import { parsePlaybackPath, parseWaitQuery, type PlaybackStore } from './playback';
import type { RouteRequest, RouteResult } from './route-contract';

export interface PlaybackRouteDependencies {
  playback: Pick<PlaybackStore, 'report' | 'get' | 'wait'>;
}

/** Playback receipts and waiters for one-shot animation requests. */
export function createPlaybackRoute(
  deps: PlaybackRouteDependencies,
): (request: RouteRequest) => Promise<RouteResult | undefined> {
  return async ({ rest, method, body, query, signal }) => {
    const playbackPath = rest === 'playback' || rest.startsWith('playback/') ? parsePlaybackPath(rest) : undefined;
    if (!playbackPath) return undefined;
    const { playbackId, isReport } = playbackPath;
    if (isReport) {
      if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      let reported: unknown;
      try {
        reported = JSON.parse(body ?? 'null');
      } catch {
        return { kind: 'json', status: 400, obj: { error: 'invalid JSON body' } };
      }
      const payload = reported && typeof reported === 'object' ? (reported as Record<string, unknown>) : {};
      const outcome = deps.playback.report(playbackId, payload.status, payload.reason);
      if (outcome === 'unknown') return { kind: 'json', status: 404, obj: { error: 'unknown playback' } };
      if (outcome === 'invalid') return { kind: 'json', status: 400, obj: { error: 'invalid status' } };
      return { kind: 'json', status: 200, obj: { ok: true } };
    }

    if (method !== 'GET') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
    const record = deps.playback.get(playbackId);
    if (!record) return { kind: 'json', status: 404, obj: { error: 'unknown playback' } };
    const parsed = parseWaitQuery(query?.get('wait') ?? null, query?.get('timeout') ?? null);
    if (parsed.kind === 'error') return { kind: 'json', status: 400, obj: { error: parsed.error } };
    if (parsed.kind === 'none') return { kind: 'json', status: 200, obj: { ...record, matched: false } };
    const { wait: waitList, timeoutMs } = parsed;
    if (waitList.includes(record.status)) return { kind: 'json', status: 200, obj: { ...record, matched: true } };
    return await new Promise<RouteResult>((resolveWait) => {
      let settled = false;
      const settle = (result: RouteResult): void => {
        if (settled) return;
        settled = true;
        resolveWait(result);
      };
      const cancel = deps.playback.wait({
        playbackId,
        wait: waitList,
        timeoutMs,
        onWake: (nextRecord, matched) => settle({ kind: 'json', status: 200, obj: { ...nextRecord, matched } }),
      });
      if (cancel === undefined) {
        settle({ kind: 'json', status: 404, obj: { error: 'unknown playback' } });
        return;
      }
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
  };
}
