import { mkdir, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';

export const name = 'dsh-pet-work-status-bridge';
export const inject = ['webServer'];

const routePrefix = '/dsh-pet-work-status-bridge-v1';
const validStates = new Set(['thinking', 'working', 'result', 'waiting', 'success', 'error']);
const terminalStates = new Set(['success', 'error']);
const terminalKeepMs = 60_000;
const activeMaxAgeMs = 2 * 60 * 60 * 1000;
const selectionTtlMs = 5_000;
const notificationTtlMs = 15_000;
const userRoot = join(resolveDshHome(), 'dsh-pet');
const bridgePath = join(userRoot, 'work-status-bridge.json');

function endState(kind) {
  if (kind === 'completed') return 'success';
  if (kind === 'error' || kind === 'max-tokens' || kind === 'timeout') return 'error';
  if (kind === 'blocked') return 'waiting';
  return null;
}

function notificationFromEvent(event) {
  const data = event?.data ?? {};
  if (event?.type === 'turn/end') {
    const reason = data.reason ?? {};
    if (reason.kind === 'completed') return { title: '对话完成', body: '', icon: 'notify-done' };
    if (reason.kind === 'error')
      return { title: '生成失败', body: String(reason.error?.message ?? ''), icon: 'notify-error' };
    if (reason.kind === 'max-tokens')
      return { title: '输出被截断', body: '已达到输出 token 上限', icon: 'notify-truncated' };
  }
  if (event?.type === 'approval/asked') {
    const tool = typeof data.toolName === 'string' && data.toolName ? `工具「${data.toolName}」` : '';
    const reason = typeof data.reason === 'string' && data.reason ? `：${data.reason}` : '';
    return { title: '正在申请权限', body: tool + reason, icon: 'notify-approval' };
  }
  if (event?.type === 'tool/call' && String(data.name ?? '') === 'ask_user_question') {
    try {
      const questions = JSON.parse(String(data.arguments ?? '')).questions;
      const question = Array.isArray(questions) ? questions[0]?.question : '';
      if (Array.isArray(questions) && questions.length > 0) {
        return {
          title: '模型在等你回答',
          body: typeof question === 'string' ? question : '',
          icon: 'notify-question',
        };
      }
    } catch {
      // Invalid question payloads do not produce a notification.
    }
  }
  return null;
}

function agentErrorNotification(error) {
  const body = typeof error === 'string' ? error : error instanceof Error ? error.message : String(error ?? '');
  return { title: '生成失败', body, icon: 'notify-error' };
}

function sessionKey(sessionId) {
  return `dsh:${createHash('sha256').update(sessionId).digest('hex').slice(0, 24)}`;
}

function updateState(states, turns, sessionId, event) {
  const type = event?.type;
  const data = event?.data ?? {};
  const turn = turns.get(sessionId) ?? { goalRound: false, closing: null };
  let next;
  const startsTurn = type === 'turn/start';

  if (type === 'user/message') {
    if (data.source?.kind === 'goal') {
      turn.goalRound = true;
      turns.set(sessionId, turn);
    }
    return;
  }
  if (type === 'turn/start') {
    turns.set(sessionId, { goalRound: false, closing: null });
    next = 'thinking';
  } else if (type === 'tool/call') {
    if (String(data.name ?? '') === 'update_goal') {
      try {
        const action = JSON.parse(String(data.arguments ?? '')).action;
        if (action === 'complete' || action === 'blocked') {
          turn.closing = action;
          turns.set(sessionId, turn);
        }
      } catch {
        // Malformed tool arguments do not change the turn outcome.
      }
    }
    next = String(data.name ?? '') === 'ask_user_question' ? 'waiting' : 'working';
  } else if (type === 'tool/result') {
    next = 'result';
  } else if (type === 'approval/asked') {
    next = 'waiting';
  } else if (type === 'turn/end') {
    next = endState(String(data.reason?.kind ?? ''));
    if (next === 'success' && turn.goalRound) {
      next = turn.closing === 'blocked' ? 'error' : turn.closing === 'complete' ? 'success' : 'result';
    }
    if (!next) {
      const removed = states.delete(sessionId);
      turns.delete(sessionId);
      return removed;
    }
  } else {
    return;
  }

  if (!validStates.has(next)) return;
  const previous = states.get(sessionId);
  const incomingSeq = Number(event?.seq);
  const seq = Number.isSafeInteger(incomingSeq) ? incomingSeq : (previous?.seq ?? 0) + 1;
  const now = Date.now();
  if (!startsTurn && previous?.state === next && previous.seq >= seq) return false;
  const stateChanged = !previous || previous.state !== next || startsTurn;
  states.set(sessionId, {
    state: next,
    seq,
    revision: (previous?.revision ?? 0) + (stateChanged ? 1 : 0),
    startedAt: !previous || startsTurn ? now : previous.startedAt,
    eventAt: now,
  });
  return stateChanged;
}

export function apply(ctx) {
  let selectedSessionId = null;
  let selectionUpdatedAt = 0;
  let dshFocused = false;
  let lastSelectionRevision = -1;
  let revision = 0;
  let lastFingerprint = '';
  let stateUpdatedAt = Date.now();
  let notificationRevision = 0;
  let notification = null;
  let writeQueue = Promise.resolve();
  let warnedWrite = false;
  const states = new Map();
  const turns = new Map();
  const terminalTimers = new Map();

  const publish = () => {
    const now = Date.now();
    for (const [sessionId, agent] of states) {
      const maxAge = terminalStates.has(agent.state) ? terminalKeepMs : activeMaxAgeMs;
      if (now - agent.eventAt < maxAge) continue;
      states.delete(sessionId);
      turns.delete(sessionId);
      const timer = terminalTimers.get(sessionId);
      if (timer) clearTimeout(timer);
      terminalTimers.delete(sessionId);
    }
    const agents = Array.from(states, ([id, agent]) => ({
      key: sessionKey(id),
      state: agent.state,
      revision: agent.revision,
      startedAt: agent.startedAt,
      eventAt: agent.eventAt,
    })).sort((a, b) => a.startedAt - b.startedAt || a.key.localeCompare(b.key));
    const latest = agents.reduce((best, agent) => (!best || agent.eventAt > best.eventAt ? agent : best), null);
    const state = latest?.state ?? null;
    const eventAt = latest?.eventAt ?? now;
    if (notification && Date.now() - notification.createdAt > notificationTtlMs) notification = null;
    const fingerprint = JSON.stringify(
      agents.map(({ key, state, revision: agentRevision, startedAt }) => ({
        key,
        state,
        revision: agentRevision,
        startedAt,
      })),
    );
    if (fingerprint !== lastFingerprint) {
      lastFingerprint = fingerprint;
      revision += 1;
      stateUpdatedAt = eventAt;
    }
    const body = JSON.stringify({
      version: 2,
      revision,
      state,
      eventAt: eventAt || stateUpdatedAt,
      updatedAt: now,
      agents,
      notification,
    });
    const tempPath = `${bridgePath}.${process.pid}.tmp`;
    writeQueue = writeQueue
      .then(async () => {
        await mkdir(userRoot, { recursive: true });
        await writeFile(tempPath, body, 'utf8');
        await rename(tempPath, bridgePath);
      })
      .catch((error) => {
        if (!warnedWrite) {
          warnedWrite = true;
          ctx.logger?.warn?.(
            `[${name}] Failed to write bridge state: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      });
  };

  const disposeRoute = ctx.webServer.register({
    kind: 'prefix',
    path: routePrefix,
    handler: async (req, res) => {
      if (req.method !== 'POST' || req.url?.split('?')[0] !== `${routePrefix}/selection`) {
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
        res.end('{"error":"not found"}');
        return;
      }
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const incomingRevision = Number(payload?.revision);
        const sessionId = payload?.sessionId === null ? null : payload?.sessionId;
        if (
          !Number.isSafeInteger(incomingRevision) ||
          incomingRevision <= lastSelectionRevision ||
          (sessionId !== null && (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 256))
        ) {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
          res.end('{"error":"invalid or stale selection"}');
          return;
        }
        lastSelectionRevision = incomingRevision;
        selectedSessionId = sessionId;
        // Older bridge clients do not report focus; treat it as focused to avoid unsolicited toasts.
        dshFocused = payload.focused !== false;
        selectionUpdatedAt = Date.now();
        publish();
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end('{"ok":true}');
      } catch {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        res.end('{"error":"invalid JSON body"}');
      }
    },
  });

  const disposeEvents = ctx.on('session/event', (session, event) => {
    if (!event?.type) return;
    const sessionId = String(session?.header?.id ?? session?.id ?? '');
    if (!sessionId) return;
    if (
      selectedSessionId === sessionId &&
      !dshFocused &&
      Date.now() - selectionUpdatedAt <= selectionTtlMs &&
      session?.header?.origin !== 'subagent' &&
      !(typeof session?.header?.delegationDepth === 'number' && session.header.delegationDepth > 0)
    ) {
      const toast = notificationFromEvent(event);
      if (toast) notification = { ...toast, revision: ++notificationRevision, createdAt: Date.now() };
    }
    const stateChanged = updateState(states, turns, sessionId, event);
    if (event.type === 'turn/end') {
      const oldTimer = terminalTimers.get(sessionId);
      if (oldTimer) clearTimeout(oldTimer);
      if (terminalStates.has(states.get(sessionId)?.state)) {
        const timer = setTimeout(() => {
          terminalTimers.delete(sessionId);
          if (terminalStates.has(states.get(sessionId)?.state)) {
            states.delete(sessionId);
            turns.delete(sessionId);
            publish();
          }
        }, terminalKeepMs);
        timer.unref?.();
        terminalTimers.set(sessionId, timer);
      }
    } else if (states.has(sessionId)) {
      const timer = terminalTimers.get(sessionId);
      if (timer) clearTimeout(timer);
      terminalTimers.delete(sessionId);
    }
    if (stateChanged || selectedSessionId === sessionId) publish();
  });

  const disposeAgentError = ctx.on('agent/error', (payload) => {
    if (!selectedSessionId || dshFocused || Date.now() - selectionUpdatedAt > selectionTtlMs) return;
    notification = {
      ...agentErrorNotification(payload?.error),
      revision: ++notificationRevision,
      createdAt: Date.now(),
    };
    publish();
  });

  const heartbeat = setInterval(publish, 1000);
  heartbeat.unref?.();
  publish();
  ctx.effect(
    () => () => {
      disposeRoute();
      disposeEvents();
      disposeAgentError();
      clearInterval(heartbeat);
      for (const timer of terminalTimers.values()) clearTimeout(timer);
      terminalTimers.clear();
    },
    `${name}: multi-session and Agent status bridge`,
  );
}
