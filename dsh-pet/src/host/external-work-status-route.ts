import { HOST_WORK_STATUS_STATES, TASK_TEXT_MAX, type HostWorkStatusState, type WorkStatusStore } from './work-status';
import type { RouteRequest, RouteResult } from './route-contract';

export interface ExternalWorkSnapshot {
  state: HostWorkStatusState;
  task: string | null;
  revision: number;
  updatedAt: number;
}

/** 一个固定外部槽；独立模式下与现有三个客户端工作桥共同展示。 */
export function createExternalWorkStatusRoute(workStatus: WorkStatusStore, publishWorkStatus: () => void) {
  const EXTERNAL_WORK_SESSION = 'api';
  let externalWorkSeq = 0;
  let updatedAt = 0;
  return {
    snapshot: (): ExternalWorkSnapshot | undefined => {
      const state = workStatus.stateOf(EXTERNAL_WORK_SESSION);
      return state
        ? { state, task: workStatus.taskOf(EXTERNAL_WORK_SESSION), revision: externalWorkSeq, updatedAt }
        : undefined;
    },
    handle: async ({ rest, method, body }: RouteRequest): Promise<RouteResult | undefined> => {
      if (rest === 'work-status') {
        if (method === 'DELETE') {
          if (workStatus.clear(EXTERNAL_WORK_SESSION)) publishWorkStatus();
          return { kind: 'text', status: 204, body: '' };
        }
        if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
        if (Buffer.byteLength(body ?? '', 'utf8') > 8 * 1024)
          return { kind: 'json', status: 413, obj: { error: 'body too large' } };
        let parsed: unknown;
        try {
          parsed = JSON.parse(body ?? '');
        } catch {
          return { kind: 'json', status: 400, obj: { error: 'invalid JSON body' } };
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
          return { kind: 'json', status: 400, obj: { error: 'invalid JSON body' } };
        const payload = parsed as { state?: unknown; task?: unknown };
        const state = payload.state;
        if (typeof state !== 'string' || !(HOST_WORK_STATUS_STATES as readonly string[]).includes(state))
          return { kind: 'json', status: 400, obj: { error: 'invalid state' } };
        let task: string | null | undefined;
        if (Object.prototype.hasOwnProperty.call(payload, 'task')) {
          if (payload.task === null) {
            task = null;
          } else if (typeof payload.task === 'string') {
            const trimmed = payload.task.trim();
            if (trimmed === '') {
              task = null;
            } else if (Array.from(trimmed).length > TASK_TEXT_MAX) {
              return {
                kind: 'json',
                status: 400,
                obj: { error: `task too long (max ${TASK_TEXT_MAX} code points)` },
              };
            } else {
              task = trimmed;
            }
          } else {
            return { kind: 'json', status: 400, obj: { error: 'invalid task' } };
          }
        }
        externalWorkSeq += 1;
        updatedAt = Date.now();
        workStatus.setState(EXTERNAL_WORK_SESSION, state as HostWorkStatusState, externalWorkSeq);
        if (task !== undefined) workStatus.setTask(EXTERNAL_WORK_SESSION, task);
        publishWorkStatus();
        return {
          kind: 'json',
          status: 200,
          obj: {
            state: workStatus.stateOf(EXTERNAL_WORK_SESSION) ?? state,
            task: workStatus.taskOf(EXTERNAL_WORK_SESSION),
          },
        };
      }

      return undefined;
    },
  };
}
