import { readFileSync } from 'node:fs';
import type { RouteRequest, RouteResult } from './route-contract';
import { parseStateWaitQuery, type PollState } from './state';
import type { HostWorkStatusState } from './work-status';
import type { StateSnapshot } from '../shared/state-contract';
import type { ExternalWorkSnapshot } from './external-work-status-route';
import type { WorkStatusSnapshotWire } from '../shared/work-status';

interface StateStoreAccess {
  read(): PollState;
  writeSection(name: string, data: unknown): void;
  wait(args: { since: number; timeoutMs: number; onWake: () => void }): () => void;
}

interface StandaloneBridge {
  revision?: unknown;
  state?: unknown;
  eventAt?: unknown;
  updatedAt?: unknown;
  agents?: unknown;
  notification?: {
    revision?: unknown;
    title?: unknown;
    body?: unknown;
    icon?: unknown;
    createdAt?: unknown;
    sourceForeground?: unknown;
  } | null;
}

export interface StateRouteDependencies {
  state: StateStoreAccess;
  externalWorkSnapshot?: () => ExternalWorkSnapshot | undefined;
  isStandalone: () => boolean;
  bridgePaths: { dsh: string; codex: string; claude: string };
}

export function createStateRoute(
  deps: StateRouteDependencies,
): (request: RouteRequest) => Promise<RouteResult | undefined> {
  let lastStandaloneBridgeFingerprint = '';
  const standaloneAgentRevisions = new Map<string, { signature: string; revision: number }>();
  const lastStandaloneNotificationRevisions = new Map<string, string>();

  const stateResponse = (snapshot: PollState): StateSnapshot => ({
    ...snapshot,
    ...(deps.isStandalone() ? { longPoll: false } : {}),
  });

  const refreshStandaloneBridges = (): void => {
    const readBridge = (path: string): StandaloneBridge | undefined => {
      try {
        return JSON.parse(readFileSync(path, 'utf8')) as StandaloneBridge;
      } catch {
        return undefined;
      }
    };
    const dshBridge = readBridge(deps.bridgePaths.dsh);
    const codexBridge = readBridge(deps.bridgePaths.codex);
    const claudeBridge = readBridge(deps.bridgePaths.claude);
    const now = Date.now();
    const fresh = (bridge: StandaloneBridge | undefined): boolean => {
      const updatedAt = Number(bridge?.updatedAt);
      return Number.isFinite(updatedAt) && now - updatedAt < 3500 && now >= updatedAt;
    };
    const freshBridges = [
      { source: 'dsh', bridge: dshBridge },
      { source: 'codex', bridge: codexBridge },
      { source: 'claude', bridge: claudeBridge },
    ].filter(({ bridge }) => fresh(bridge));
    const activeStates = new Set(['thinking', 'working', 'result', 'waiting', 'success', 'error']);
    const allBridgeAgents: Array<{
      key: string;
      state: HostWorkStatusState;
      sourceName: string;
      revision: number;
      startedAt: number;
      eventAt: number;
      source: string;
      task?: string | null;
    }> = freshBridges.flatMap(({ source, bridge }) => {
      const bridgeAgentList = bridge?.agents;
      if (Array.isArray(bridgeAgentList)) {
        return bridgeAgentList.flatMap((rawAgent) => {
          if (!rawAgent || typeof rawAgent !== 'object') return [];
          const agent = rawAgent as Record<string, unknown>;
          if (
            typeof agent.key !== 'string' ||
            typeof agent.state !== 'string' ||
            !activeStates.has(agent.state) ||
            !Number.isSafeInteger(agent.revision) ||
            !Number.isFinite(agent.startedAt)
          ) {
            return [];
          }
          return [
            {
              key: `${source}:${agent.key}`,
              state: agent.state as HostWorkStatusState,
              sourceName: source === 'codex' ? 'Codex' : source === 'claude' ? 'Claude Code' : 'DeepSeek Harness',
              revision: agent.revision as number,
              startedAt: agent.startedAt as number,
              eventAt: Number(agent.eventAt ?? bridge?.eventAt ?? bridge?.updatedAt) || now,
              source,
            },
          ];
        });
      }
      const state = bridge?.state;
      if (typeof state !== 'string' || !activeStates.has(state)) return [];
      return [
        {
          key: `legacy:${source}`,
          state: state as HostWorkStatusState,
          sourceName: source === 'codex' ? 'Codex' : source === 'claude' ? 'Claude Code' : 'DeepSeek Harness',
          revision: Number(bridge?.revision) || 0,
          startedAt: Number(bridge?.eventAt ?? bridge?.updatedAt) || now,
          eventAt: Number(bridge?.eventAt ?? bridge?.updatedAt) || now,
          source,
        },
      ];
    });
    const external = deps.externalWorkSnapshot?.();
    if (external)
      allBridgeAgents.push({
        key: 'api',
        source: 'api',
        sourceName: '外部应用',
        state: external.state,
        task: external.task,
        revision: external.revision,
        startedAt: external.updatedAt,
        eventAt: external.updatedAt,
      });
    // Each client owns at most one pet; its latest in-progress session takes priority over
    // completed siblings so parallel subagents do not consume additional pets.
    const agentsBySource = new Map<string, typeof allBridgeAgents>();
    for (const agent of allBridgeAgents) {
      const list = agentsBySource.get(agent.source) ?? [];
      list.push(agent);
      agentsBySource.set(agent.source, list);
    }
    const inProgressStates = new Set(['thinking', 'working', 'result', 'waiting']);
    const bridgeAgents = Array.from(agentsBySource, ([source, agents]) => {
      const inProgress = agents.filter((agent) => inProgressStates.has(agent.state));
      const candidates = inProgress.length > 0 ? inProgress : agents;
      const latest = candidates.reduce(
        (current, agent) => (!current || agent.eventAt > current.eventAt ? agent : current),
        null as (typeof allBridgeAgents)[number] | null,
      );
      if (!latest) return null;
      const terminal = latest.state === 'success' || latest.state === 'error';
      const signature = JSON.stringify([latest.key, latest.state, latest.startedAt, terminal ? null : latest.revision]);
      const previous = standaloneAgentRevisions.get(source);
      const revision = previous?.signature === signature ? previous.revision : (previous?.revision ?? 0) + 1;
      standaloneAgentRevisions.set(source, { signature, revision });
      return { ...latest, key: `${source}:client`, revision };
    }).filter((agent): agent is NonNullable<typeof agent> => agent !== null);
    bridgeAgents.sort((a, b) => a.startedAt - b.startedAt || a.key.localeCompare(b.key));
    const latestAgent = bridgeAgents.reduce(
      (latest, agent) => (!latest || agent.eventAt > latest.eventAt ? agent : latest),
      null as (typeof bridgeAgents)[number] | null,
    );
    const workState = latestAgent?.state ?? null;
    const sourceName = latestAgent?.sourceName ?? null;
    const task = latestAgent?.source === 'api' ? (external?.task ?? null) : null;
    const fingerprint = JSON.stringify({ workState, sourceName, task, bridgeAgents });
    if (fingerprint !== lastStandaloneBridgeFingerprint) {
      lastStandaloneBridgeFingerprint = fingerprint;
      const payload: WorkStatusSnapshotWire = { state: workState, task, sourceName, agents: bridgeAgents };
      deps.state.writeSection('workStatus', payload);
    }

    const dshNotification = dshBridge?.notification;
    const dshNotificationRevision = `${String(dshNotification?.createdAt ?? '')}:${String(dshNotification?.revision ?? '')}`;
    const dshNotificationCreatedAt = Number(dshNotification?.createdAt);
    if (
      fresh(dshBridge) &&
      dshNotificationRevision.length > 0 &&
      dshNotificationRevision !== lastStandaloneNotificationRevisions.get('dsh') &&
      Number.isFinite(dshNotificationCreatedAt) &&
      Date.now() >= dshNotificationCreatedAt &&
      Date.now() - dshNotificationCreatedAt <= 15_000 &&
      typeof dshNotification?.title === 'string' &&
      typeof dshNotification?.body === 'string'
    ) {
      lastStandaloneNotificationRevisions.set('dsh', dshNotificationRevision);
      deps.state.writeSection('notify', {
        type: 'standalone',
        source: 'dsh',
        sourceForeground: dshNotification.sourceForeground === true,
        title: dshNotification.title,
        body: dshNotification.body,
        icon:
          typeof dshNotification.icon === 'string' &&
          ['notify-done', 'notify-error', 'notify-truncated', 'notify-approval', 'notify-question'].includes(
            dshNotification.icon,
          )
            ? dshNotification.icon
            : 'notify-done',
      });
    }
  };

  return async ({ rest, method, query, signal }) => {
    if (rest === 'state') {
      if (method !== 'GET') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      if (deps.isStandalone()) {
        refreshStandaloneBridges();
        return {
          kind: 'json',
          status: 200,
          obj: stateResponse(deps.state.read()),
          headers: { 'cache-control': 'no-cache, no-store' },
        };
      }
      const parsed = parseStateWaitQuery(query?.get('since') ?? null, query?.get('timeout') ?? null);
      if (parsed.kind === 'error') return { kind: 'json', status: 400, obj: { error: parsed.error } };
      const current = deps.state.read();
      const headers = { 'cache-control': 'no-cache, no-store' };
      if (parsed.kind === 'none' || current.counter !== parsed.since) {
        return { kind: 'json', status: 200, obj: stateResponse(current), headers };
      }
      const since = parsed.since;
      return await new Promise<RouteResult>((resolveWait) => {
        let settled = false;
        const settle = (result: RouteResult): void => {
          if (settled) return;
          settled = true;
          resolveWait(result);
        };
        const cancel = deps.state.wait({
          since,
          timeoutMs: parsed.timeoutMs,
          onWake: () => settle({ kind: 'json', status: 200, obj: stateResponse(deps.state.read()), headers }),
        });
        const onAbort = (): void => {
          cancel();
          settle({ kind: 'none' });
        };
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
    return undefined;
  };
}
