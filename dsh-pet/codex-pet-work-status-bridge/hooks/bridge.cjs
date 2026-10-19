const { spawn, spawnSync } = require('node:child_process');
const { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { homedir } = require('node:os');
const { dirname, join, resolve } = require('node:path');

const HEARTBEAT_MS = 1000;
const TERMINAL_KEEP_MS = 10_000;
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
  const override = process.env.CODEX_PET_BRIDGE_PATH?.trim();
  return override ? resolve(override) : join(dshHome(), 'dsh-pet', 'codex-work-status-bridge.json');
}

function pluginDataPath() {
  const data = process.env.PLUGIN_DATA?.trim();
  if (data) return resolve(data);
  return join(dshHome(), 'dsh-pet', 'dsh-pet-work-status-bridge-codex');
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
    const details = error ? ` ${error.code || error.name || 'Error'}: ${error.message || String(error)}` : '';
    const line = `${new Date().toISOString()} ${message}${details}\n`;
    writeFileSync(path, (previous + line).slice(-32_000), 'utf8');
  } catch {
    // Diagnostics must never affect Codex hook behavior.
  }
}

function digest(...parts) {
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 24);
}

function readCurrent(path) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (!value || typeof value !== 'object') return undefined;
    return value;
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
  const deadline = Date.now() + 5000;
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
  const entries = Object.entries(value).filter(([, agent]) => agent && typeof agent === 'object');
  return Object.fromEntries(entries);
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
    source: 'codex',
    interruptedSessions:
      previous?.interruptedSessions && typeof previous.interruptedSessions === 'object'
        ? previous.interruptedSessions
        : {},
    agents: entries.map((agent) => ({
      key: agent.key,
      state: agent.state,
      revision: agent.revision,
      startedAt: agent.startedAt,
      eventAt: agent.eventAt,
    })),
  };
}

function normalizeInterruptedSessions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, at]) => Number.isFinite(Number(at))));
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

function turnKeyFor(input) {
  return digest('turn', typeof input?.turn_id === 'string' ? input.turn_id : 'current-turn');
}

function rootKey(sessionKey) {
  // Codex may report a different turn_id on tool hooks within one visible turn.
  // A root session can only have one active turn, so key it by session to avoid
  // leaving old turn records alive and assigning more pets as hooks arrive.
  return digest(sessionKey, 'root');
}

function subagentKey(sessionKey, agentId) {
  return digest(sessionKey, 'subagent', agentId);
}

function clearSession(agents, sessionKey) {
  for (const [key, agent] of Object.entries(agents)) {
    if (agent.sessionKey === sessionKey) delete agents[key];
  }
}

function clearRootAgents(agents, sessionKey) {
  for (const [key, agent] of Object.entries(agents)) {
    if (agent.sessionKey === sessionKey && agent.role === 'root') delete agents[key];
  }
}

function clearOtherRootAgents(agents, sessionKey, keepKey) {
  for (const [key, agent] of Object.entries(agents)) {
    if (key !== keepKey && agent.sessionKey === sessionKey && agent.role === 'root') delete agents[key];
  }
}

function putAgent(agents, key, sessionKey, turnKey, role, state, now) {
  if (!ALL_STATES.has(state)) return;
  const previous = agents[key];
  agents[key] = {
    key,
    sessionKey,
    turnKey,
    role,
    state,
    revision: Number.isSafeInteger(previous?.revision) ? previous.revision + 1 : 1,
    startedAt: Number(previous?.startedAt) || now,
    eventAt: now,
  };
}

function stateForRootEvent(eventName) {
  switch (eventName) {
    case 'UserPromptSubmit':
      return 'thinking';
    case 'PreToolUse':
      return 'working';
    case 'PostToolUse':
      return 'result';
    case 'PermissionRequest':
      return 'waiting';
    case 'Stop':
      return 'success';
    default:
      return undefined;
  }
}

function processEvent(input) {
  const eventName = input?.hook_event_name;
  const sessionKey = sessionKeyFor(input);
  const turnKey = turnKeyFor(input);
  const path = bridgePath();
  const now = Date.now();
  let eventState = 'unchanged';

  withBridgeLock(path, () => {
    const previous = readCurrent(path);
    const agents = normalizeAgentMap(previous?.agentMap);
    const interruptedSessions = normalizeInterruptedSessions(previous?.interruptedSessions);
    expireAgents(agents, now);

    if (eventName === 'SessionStart') {
      if (input.source === 'compact' && interruptedSessions[sessionKey]) {
        eventState = 'ignored-after-interrupt';
      } else if (input.source === 'compact') {
        const key = rootKey(sessionKey);
        clearOtherRootAgents(agents, sessionKey, key);
        putAgent(agents, key, sessionKey, turnKey, 'root', 'thinking', now);
        eventState = 'thinking';
      } else {
        clearSession(agents, sessionKey);
        delete interruptedSessions[sessionKey];
        eventState = 'idle';
      }
    } else if (eventName === 'SessionEnd' || eventName === 'Interrupt') {
      clearSession(agents, sessionKey);
      if (eventName === 'Interrupt') interruptedSessions[sessionKey] = now;
      else delete interruptedSessions[sessionKey];
      eventState = 'idle';
    } else if (eventName === 'UserPromptSubmit') {
      // A new explicit prompt is the only event that resumes a session after an interrupt.
      delete interruptedSessions[sessionKey];
      clearRootAgents(agents, sessionKey);
      putAgent(agents, rootKey(sessionKey), sessionKey, turnKey, 'root', 'thinking', now);
      eventState = 'thinking';
    } else if (interruptedSessions[sessionKey]) {
      // Late hooks can carry a missing or different turn_id. Suppress the session until an
      // explicit new prompt arrives, so canceled work cannot recreate any animation state.
      eventState = 'ignored-after-interrupt';
    } else if (eventName === 'SubagentStart') {
      const agentId = typeof input.agent_id === 'string' ? input.agent_id : '';
      if (agentId) {
        const key = subagentKey(sessionKey, agentId);
        delete agents[key];
        putAgent(agents, key, sessionKey, turnKey, 'subagent', 'working', now);
        eventState = 'working';
      }
    } else if (eventName === 'SubagentStop') {
      const agentId = typeof input.agent_id === 'string' ? input.agent_id : '';
      const key = agentId ? subagentKey(sessionKey, agentId) : '';
      if (key && agents[key]) {
        putAgent(agents, key, sessionKey, turnKey, 'subagent', 'success', now);
        eventState = 'success';
      }
    } else {
      const state = stateForRootEvent(eventName);
      if (state !== undefined) {
        // Codex exposes agent_id on SubagentStart/Stop. Tool hooks do not consistently identify
        // the originating subagent, so do not let their events overwrite the root while children run.
        const hasActiveSubagent = Object.values(agents).some(
          (agent) => agent.sessionKey === sessionKey && agent.role === 'subagent' && ACTIVE_STATES.has(agent.state),
        );
        if (input.agent_id && eventName !== 'Stop' && eventName !== 'UserPromptSubmit') {
          const agentId = String(input.agent_id);
          putAgent(agents, subagentKey(sessionKey, agentId), sessionKey, turnKey, 'subagent', state, now);
          eventState = state;
        } else if (eventName === 'Stop' || eventName === 'UserPromptSubmit' || !hasActiveSubagent) {
          const key = rootKey(sessionKey);
          clearOtherRootAgents(agents, sessionKey, key);
          putAgent(agents, key, sessionKey, turnKey, 'root', state, now);
          eventState = state;
        } else {
          eventState = 'root-event-deferred';
        }
      }
    }

    const value = refreshEnvelope(previous, agents, now, now);
    value.agentMap = agents;
    value.interruptedSessions = interruptedSessions;
    atomicWrite(path, value);
  });

  log(`event=${eventName || 'unknown'} state=${eventState} bridge=written`);
  const current = readCurrent(path);
  if (Object.keys(normalizeAgentMap(current?.agentMap)).length > 0) startHeartbeat();
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
    env: { ...process.env, CODEX_PET_HEARTBEAT: '1' },
  });
  child.once('error', (error) => log('heartbeat=start-failed', error));
  child.unref();
}

function clearBridge(path) {
  withBridgeLock(path, () => {
    const current = readCurrent(path);
    if (!current) return;
    const now = Date.now();
    const previous = { ...current, revision: Number(current.revision) || 0 };
    const cleared = refreshEnvelope(previous, {}, now, now);
    cleared.agentMap = {};
    atomicWrite(path, cleared);
  });
  log('heartbeat=expired bridge=cleared');
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
        const interruptedSessions = normalizeInterruptedSessions(current.interruptedSessions);
        const previousCount = Object.keys(agents).length;
        expireAgents(agents, now);
        agentsRemain = Object.keys(agents).length > 0;
        const next = refreshEnvelope(current, agents, now);
        next.revision = (Number(current.revision) || 0) + (Object.keys(agents).length === previousCount ? 0 : 1);
        next.agentMap = agents;
        next.interruptedSessions = interruptedSessions;
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

    if (parsed?.hook_event_name === 'Stop' || parsed?.hook_event_name === 'SubagentStop') {
      process.stdout.write('{"continue":true}');
    }
  });
}
