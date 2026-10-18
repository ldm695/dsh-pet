const { spawn } = require('node:child_process');
const {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} = require('node:fs');
const { createHash } = require('node:crypto');
const { homedir } = require('node:os');
const { dirname, join, resolve } = require('node:path');

const HEARTBEAT_MS = 1000;
const TRANSCRIPT_POLL_MS = 250;
const INTERRUPT_CONFIRM_MS = 1200;
const WATCHER_IDLE_GRACE_MS = 2000;
const MAX_TRANSCRIPT_READ_BYTES = 1024 * 1024;
const MAX_TRANSCRIPT_LINE_CHARS = 1024 * 1024;
const TERMINAL_KEEP_MS = 10_000;
const INTERRUPT_TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000;
// Claude Code does not emit a lifecycle event for every user interruption. idle_prompt is
// the preferred cleanup path; this timeout is a final guard for sessions where it is absent.
const MAX_ACTIVE_MS = 10 * 60 * 1000;
const ACTIVE_STATES = new Set(['thinking', 'working', 'result', 'waiting']);
const TERMINAL_STATES = new Set(['success', 'error']);
const ALL_STATES = new Set([...ACTIVE_STATES, ...TERMINAL_STATES]);

function dshHome() {
  const configured = process.env.DSH_HOME?.trim();
  if (configured) return resolve(configured);
  return join(homedir(), '.dsh');
}

function bridgePath() {
  const override = process.env.CLAUDE_CODE_PET_BRIDGE_PATH?.trim();
  return override ? resolve(override) : join(dshHome(), 'dsh-pet', 'claude-code-work-status-bridge.json');
}

function pluginDataPath() {
  const data = process.env.CLAUDE_PLUGIN_DATA?.trim();
  if (data) return resolve(data);
  return join(dshHome(), 'dsh-pet', 'dsh-pet-work-status-bridge-claude-code');
}

function log(message, error) {
  try {
    const root = pluginDataPath();
    mkdirSync(root, { recursive: true });
    const path = join(root, 'bridge.log');
    let previous = '';
    try {
      previous = readFileSync(path, 'utf8');
    } catch {
      // First log entry.
    }
    const details = error ? ` ${error.code || error.name || 'Error'}` : '';
    const line = `${new Date().toISOString()} ${message}${details}\n`;
    writeFileSync(path, (previous + line).slice(-32_000), 'utf8');
  } catch {
    // Diagnostics must never affect Claude Code hook behavior.
  }
}

function digest(...parts) {
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 24);
}

function readCurrent(path) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return value && typeof value === 'object' ? value : undefined;
  } catch {
    return undefined;
  }
}

function atomicWrite(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // Best-effort cleanup.
    }
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lockIsStale(lockDir, staleAfterMs = 5000) {
  const ownerPath = join(lockDir, 'pid');
  try {
    const pid = Number(readFileSync(ownerPath, 'utf8'));
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        if (error?.code === 'EPERM') return false;
        if (error?.code !== 'ESRCH') return false;
      }
    }
    return Date.now() - statSync(lockDir).mtimeMs > staleAfterMs;
  } catch {
    return false;
  }
}

function withBridgeLock(path, action) {
  const lockDir = `${path}.update.lock`;
  const deadline = Date.now() + 4000;
  mkdirSync(dirname(path), { recursive: true });
  while (true) {
    try {
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, 'pid'), String(process.pid), 'utf8');
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (lockIsStale(lockDir)) {
        try {
          rmSync(lockDir, { recursive: true, force: true });
        } catch {
          // Another writer may have replaced it; retry acquisition.
        }
      } else if (Date.now() >= deadline) {
        throw new Error('Timed out waiting for the bridge update lock');
      } else {
        sleepSync(20);
      }
    }
  }
  try {
    return action();
  } finally {
    try {
      rmSync(lockDir, { recursive: true, force: true });
    } catch {
      // Best-effort lock release.
    }
  }
}

function normalizeAgentMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, agent]) => agent && typeof agent === 'object'));
}

function refreshEnvelope(previous, agents, now, eventAt = Number(previous?.eventAt) || now) {
  const entries = Object.values(agents).filter((agent) => ALL_STATES.has(agent.state));
  entries.sort((a, b) => Number(a.eventAt) - Number(b.eventAt));
  const latest = entries.at(-1);
  return {
    version: 2,
    revision: Number.isSafeInteger(previous?.revision) ? previous.revision + 1 : 1,
    state: latest?.state ?? null,
    updatedAt: now,
    eventAt: latest ? Number(latest.eventAt) : eventAt,
    notification: null,
    source: 'claude',
    interruptedSessions: normalizeInterruptedSessions(previous?.interruptedSessions, now),
    agents: entries.map((agent) => ({
      key: agent.key,
      state: agent.state,
      revision: agent.revision,
      startedAt: agent.startedAt,
      eventAt: agent.eventAt,
    })),
  };
}

function expireAgents(agents, now) {
  for (const [key, agent] of Object.entries(agents)) {
    const eventAt = Number(agent.eventAt);
    const maxAge = TERMINAL_STATES.has(agent.state) ? TERMINAL_KEEP_MS : MAX_ACTIVE_MS;
    if (!ALL_STATES.has(agent.state) || !Number.isFinite(eventAt) || now - eventAt >= maxAge) delete agents[key];
  }
}

function sessionKeyFor(input) {
  return digest('session', typeof input?.session_id === 'string' ? input.session_id : 'unknown-session');
}

function normalizeInterruptedSessions(value, now = Date.now()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([, at]) => Number.isFinite(Number(at)) && now - Number(at) < INTERRUPT_TOMBSTONE_TTL_MS),
  );
}

function rootKey(sessionKey) {
  return digest(sessionKey, 'root');
}

function agentKey(sessionKey, id) {
  return digest(sessionKey, 'agent', id);
}

function clearSession(agents, sessionKey) {
  for (const [key, agent] of Object.entries(agents)) {
    if (agent.sessionKey === sessionKey) delete agents[key];
  }
}

function transcriptTimestamp(record, fallback = Date.now()) {
  const parsed = Date.parse(record?.timestamp);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function textValues(value, output = []) {
  if (typeof value === 'string') {
    output.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) textValues(item, output);
  } else if (value && typeof value === 'object') {
    if (value.type === 'text' && typeof value.text === 'string') output.push(value.text);
    else if (value.type !== 'tool_result') {
      for (const [key, item] of Object.entries(value)) {
        if (key !== 'tool_use' && key !== 'tool_input') textValues(item, output);
      }
    }
  }
  return output;
}

function isInterruptTranscriptRecord(record) {
  if (record?.type !== 'user') return false;
  const message = record.message;
  if (!message || typeof message !== 'object') return false;
  const values = textValues(message.content);
  return values.some((value) => /^\[Request interrupted by user(?: for tool use)?\]$/.test(value.trim()));
}

function isSubsequentUserPromptRecord(record) {
  if (record?.type !== 'user' || record?.message?.role !== 'user') return false;
  const content = record.message.content;
  if (typeof content === 'string') return true;
  return Array.isArray(content) && content.some((item) => item?.type === 'text' && typeof item.text === 'string');
}

function clearInterruptedSession(sessionKey, interruptedAt) {
  const path = bridgePath();
  const now = Date.now();
  let cleared = false;
  withBridgeLock(path, () => {
    const previous = readCurrent(path);
    const agents = normalizeAgentMap(previous?.agentMap);
    const sessionAgents = Object.values(agents).filter((agent) => agent.sessionKey === sessionKey);
    // A prompt submitted after the transcript marker means Claude has already resumed.
    if (sessionAgents.some((agent) => Number(agent.eventAt) > interruptedAt)) return;
    clearSession(agents, sessionKey);
    const interruptedSessions = normalizeInterruptedSessions(previous?.interruptedSessions, now);
    interruptedSessions[sessionKey] = now;
    const value = refreshEnvelope(previous, agents, now, now);
    value.agentMap = agents;
    value.interruptedSessions = interruptedSessions;
    atomicWrite(path, value);
    cleared = true;
  });
  if (cleared) log('event=TranscriptInterrupt state=idle bridge=written');
  return cleared;
}

function transcriptWatcherDir(sessionKey) {
  return join(pluginDataPath(), 'transcript-watchers', sessionKey);
}

function startTranscriptWatcher(sessionKey, transcriptPath) {
  if (typeof transcriptPath !== 'string' || !transcriptPath.trim()) return;
  const watchDir = transcriptWatcherDir(sessionKey);
  mkdirSync(dirname(watchDir), { recursive: true });
  if (existsSync(watchDir)) {
    if (!lockIsStale(watchDir, 10_000)) return;
    try {
      rmSync(watchDir, { recursive: true, force: true });
    } catch {
      return;
    }
  }
  try {
    mkdirSync(watchDir);
    const child = spawn(process.execPath, [__filename, '--watch-transcript', sessionKey, transcriptPath, watchDir], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, CLAUDE_CODE_PET_TRANSCRIPT_WATCHER: '1' },
    });
    if (!child.pid) throw new Error('Transcript watcher did not start');
    writeFileSync(join(watchDir, 'pid'), String(child.pid), 'utf8');
    child.once('error', (error) => log('transcript-watcher=start-failed', error));
    child.unref();
  } catch (error) {
    try {
      rmSync(watchDir, { recursive: true, force: true });
    } catch {
      // Best-effort lock cleanup.
    }
    log('transcript-watcher=start-failed', error);
  }
}

function sessionHasActiveAgent(sessionKey) {
  const current = readCurrent(bridgePath());
  const agents = normalizeAgentMap(current?.agentMap);
  return Object.values(agents).some((agent) => agent.sessionKey === sessionKey && ACTIVE_STATES.has(agent.state));
}

function runTranscriptWatcher(sessionKey, transcriptPath, watchDir) {
  let ownsLock = false;
  let descriptor;
  let initialSize = 0;
  try {
    let ownerPid = 0;
    for (let attempt = 0; attempt < 50 && !ownerPid; attempt += 1) {
      try {
        ownerPid = Number(readFileSync(join(watchDir, 'pid'), 'utf8'));
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        sleepSync(20);
      }
    }
    if (ownerPid !== process.pid) return;
    ownsLock = true;
    descriptor = openSync(transcriptPath, 'r');
    initialSize = statSync(transcriptPath).size;
  } catch (error) {
    if (error?.code !== 'ENOENT') log('transcript-watcher=open-failed', error);
    if (ownsLock) {
      try { rmSync(watchDir, { recursive: true, force: true }); } catch { /* Best-effort cleanup. */ }
    }
    return;
  }

  let offset = initialSize;
  let partialLine = '';
  let pendingInterruptAt = 0;
  let pendingInterruptSince = 0;
  let idleSince = 0;
  let skippingOversizedLine = false;
  const buffer = Buffer.alloc(64 * 1024);
  const processLine = (line) => {
    if (!line.trim()) return;
    let record;
    try { record = JSON.parse(line); } catch { return; }
    if (isInterruptTranscriptRecord(record)) {
      pendingInterruptAt = transcriptTimestamp(record);
      pendingInterruptSince = Date.now();
      return;
    }
    if (pendingInterruptAt && isSubsequentUserPromptRecord(record)
      && transcriptTimestamp(record) > pendingInterruptAt) {
      pendingInterruptAt = 0;
      pendingInterruptSince = 0;
    }
  };

  const timer = setInterval(() => {
    try {
      if (!sessionHasActiveAgent(sessionKey)) {
        if (!idleSince) idleSince = Date.now();
        else if (Date.now() - idleSince >= WATCHER_IDLE_GRACE_MS) clearInterval(timer);
        return;
      }
      idleSince = 0;
      const size = statSync(transcriptPath).size;
      if (size < offset) {
        offset = size;
        partialLine = '';
        skippingOversizedLine = false;
        pendingInterruptAt = 0;
        pendingInterruptSince = 0;
      }
      let bytesRead = 0;
      while (offset < size && bytesRead < MAX_TRANSCRIPT_READ_BYTES) {
        const length = Math.min(buffer.length, size - offset);
        const count = readSync(descriptor, buffer, 0, length, offset);
        if (!count) break;
        offset += count;
        bytesRead += count;
        partialLine += buffer.toString('utf8', 0, count);
        const lines = partialLine.split(/\r?\n/);
        partialLine = lines.pop() || '';
        for (const line of lines) {
          if (skippingOversizedLine) skippingOversizedLine = false;
          else processLine(line);
        }
        if (partialLine.length > MAX_TRANSCRIPT_LINE_CHARS) {
          partialLine = '';
          skippingOversizedLine = true;
        }
      }
      if (pendingInterruptAt && Date.now() - pendingInterruptSince >= INTERRUPT_CONFIRM_MS) {
        if (clearInterruptedSession(sessionKey, pendingInterruptAt)) {
          clearInterval(timer);
          return;
        }
        pendingInterruptAt = 0;
        pendingInterruptSince = 0;
      }
    } catch (error) {
      if (error?.code === 'ENOENT') clearInterval(timer);
      else log('transcript-watcher=read-failed', error);
    }
  }, TRANSCRIPT_POLL_MS);

  const cleanup = () => {
    clearInterval(timer);
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* Best-effort descriptor cleanup. */ }
    }
    if (ownsLock) {
      try { rmSync(watchDir, { recursive: true, force: true }); } catch { /* Best-effort lock cleanup. */ }
    }
  };
  process.once('SIGINT', cleanup);
  process.once('SIGTERM', cleanup);
  process.once('exit', cleanup);
}

function putAgent(agents, key, sessionKey, role, state, now, resetStartedAt = false) {
  if (!ALL_STATES.has(state)) return;
  const previous = agents[key];
  agents[key] = {
    key,
    sessionKey,
    role,
    state,
    revision: Number.isSafeInteger(previous?.revision) ? previous.revision + 1 : 1,
    startedAt: !resetStartedAt && Number(previous?.startedAt) ? previous.startedAt : now,
    eventAt: now,
  };
}

function stateForEvent(input) {
  switch (input?.hook_event_name) {
    case 'UserPromptSubmit':
      return 'thinking';
    case 'PreToolUse':
    case 'SubagentStart':
      return 'working';
    case 'PostToolUse':
    case 'PermissionDenied':
      return 'result';
    case 'PostToolUseFailure':
      return input.is_interrupt === true ? null : 'result';
    case 'SubagentStop':
    case 'Stop':
      return 'success';
    case 'StopFailure':
      return 'error';
    case 'PreCompact':
      return 'thinking';
    case 'PermissionRequest':
      return 'waiting';
    case 'Notification':
      // PermissionRequest already covers permission_prompt; avoid triggering the same waiting state twice.
      if (['elicitation_dialog', 'elicitation_url_dialog'].includes(input.notification_type)) return 'waiting';
      // Claude Code does not emit Stop after a user interrupt. idle_prompt is emitted only after
      // the session has been idle for a while and no background agent is still running, so use it
      // as a delayed cleanup signal for interrupted root turns.
      return input.notification_type === 'idle_prompt' ? null : undefined;
    case 'SessionStart':
      return input.source === 'compact' ? 'thinking' : null;
    case 'SessionEnd':
      return null;
    default:
      return undefined;
  }
}

function processEvent(input) {
  const eventName = input?.hook_event_name;
  const nextState = stateForEvent(input);
  if (nextState === undefined) return;

  const path = bridgePath();
  const now = Date.now();
  const sessionKey = sessionKeyFor(input);
  let eventState = nextState ?? 'idle';

  withBridgeLock(path, () => {
    const previous = readCurrent(path);
    const agents = normalizeAgentMap(previous?.agentMap);
    const interruptedSessions = normalizeInterruptedSessions(previous?.interruptedSessions, now);
    expireAgents(agents, now);

    if (eventName === 'SessionStart' && input.source !== 'compact') {
      clearSession(agents, sessionKey);
      delete interruptedSessions[sessionKey];
    } else if (eventName === 'SessionEnd' || (eventName === 'Notification' && input.notification_type === 'idle_prompt')) {
      clearSession(agents, sessionKey);
      delete interruptedSessions[sessionKey];
    } else if (eventName === 'PostToolUseFailure' && input.is_interrupt === true) {
      // An interrupt ends the whole visible session turn, not just the tool/agent that
      // happened to report the failure. Suppress late hooks until the user starts a new turn.
      clearSession(agents, sessionKey);
      interruptedSessions[sessionKey] = now;
    } else if (interruptedSessions[sessionKey] && eventName !== 'UserPromptSubmit') {
      // Delayed tool/subagent hooks must not recreate a canceled session's animation.
    } else {
      if (eventName === 'UserPromptSubmit') {
        // A new explicit prompt starts a fresh lifecycle after an interrupt.
        delete interruptedSessions[sessionKey];
        clearSession(agents, sessionKey);
      }
      const rawAgentId = typeof input.agent_id === 'string' && input.agent_id ? input.agent_id : null;
      const isSubagentEvent = eventName === 'SubagentStart' || eventName === 'SubagentStop';
      const key = rawAgentId ? agentKey(sessionKey, rawAgentId) : rootKey(sessionKey);
      const role = rawAgentId || isSubagentEvent ? 'agent' : 'root';

      if (eventName === 'SubagentStart' && rawAgentId) delete agents[key];
      if (nextState !== null) {
        putAgent(agents, key, sessionKey, role, nextState, now);
      }
    }

    const value = refreshEnvelope(previous, agents, now, now);
    value.agentMap = agents;
    value.interruptedSessions = interruptedSessions;
    atomicWrite(path, value);
  });

  log(`event=${eventName || 'unknown'} state=${eventState} bridge=written`);
  if (Object.keys(normalizeAgentMap(readCurrent(path)?.agentMap)).length > 0) startHeartbeat();
  if (nextState !== null && ACTIVE_STATES.has(nextState)) {
    startTranscriptWatcher(sessionKey, input.transcript_path);
  }
}

function startHeartbeat() {
  const root = pluginDataPath();
  const lockDir = join(root, 'heartbeat.lock');
  mkdirSync(root, { recursive: true });
  if (existsSync(lockDir) && lockIsStale(lockDir)) rmSync(lockDir, { recursive: true, force: true });
  if (existsSync(lockDir)) return;

  const child = spawn(process.execPath, [__filename, '--heartbeat', lockDir], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, CLAUDE_CODE_PET_HEARTBEAT: '1' },
  });
  child.once('error', (error) => log('heartbeat=start-failed', error));
  child.unref();
}

function runHeartbeat(lockDir) {
  let ownsLock = false;
  try {
    mkdirSync(lockDir);
    ownsLock = true;
    writeFileSync(join(lockDir, 'pid'), String(process.pid), 'utf8');
  } catch (error) {
    log('heartbeat=lock-unavailable', error);
    return;
  }

  const path = bridgePath();
  const startedAt = Date.now();
  const timer = setInterval(() => {
    try {
      let agentsRemain = false;
      withBridgeLock(path, () => {
        const current = readCurrent(path);
        if (!current) return;
        const now = Date.now();
        const agents = normalizeAgentMap(current.agentMap);
        const previousCount = Object.keys(agents).length;
        expireAgents(agents, now);
        agentsRemain = Object.keys(agents).length > 0;
        const next = refreshEnvelope(current, agents, now);
        next.revision = (Number(current.revision) || 0) + (Object.keys(agents).length === previousCount ? 0 : 1);
        next.agentMap = agents;
        atomicWrite(path, next);
      });
      if (!agentsRemain || Date.now() - startedAt > MAX_ACTIVE_MS + TERMINAL_KEEP_MS) clearInterval(timer);
    } catch (error) {
      log('heartbeat=write-failed', error);
    }
  }, HEARTBEAT_MS);

  const cleanup = () => {
    clearInterval(timer);
    if (ownsLock) rmSync(lockDir, { recursive: true, force: true });
  };
  process.once('SIGINT', cleanup);
  process.once('SIGTERM', cleanup);
  process.once('exit', cleanup);
  log('heartbeat=started');
}

if (process.argv[2] === '--heartbeat') {
  runHeartbeat(process.argv[3]);
} else if (process.argv[2] === '--watch-transcript') {
  runTranscriptWatcher(process.argv[3], process.argv[4], process.argv[5]);
} else {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    input += chunk;
  });
  process.stdin.on('end', () => {
    let parsed;
    try {
      parsed = JSON.parse(input);
      processEvent(parsed);
    } catch (error) {
      const eventName = parsed?.hook_event_name || 'unknown';
      log(`event=${eventName} bridge=failed`, error);
    }
  });
}
