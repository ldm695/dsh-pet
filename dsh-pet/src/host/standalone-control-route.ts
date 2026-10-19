import type { RouteRequest, RouteResult } from './route-contract';

export interface StandaloneControlRouteDependencies {
  isStandalone: () => boolean;
  sendControlLine: (action: 'open-settings' | 'quit-app') => void;
}

/** Commands handled by the standalone launcher over its stdout control channel. */
export function createStandaloneControlRoute(
  deps: StandaloneControlRouteDependencies,
): (request: RouteRequest) => RouteResult | undefined {
  return ({ rest, method }) => {
    if (rest === 'settings/open' || rest === 'app/quit') {
      if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      if (!deps.isStandalone()) return { kind: 'json', status: 404, obj: { error: 'not found' } };
      const action = rest === 'settings/open' ? 'open-settings' : 'quit-app';
      deps.sendControlLine(action);
      return { kind: 'json', status: 200, obj: { ok: true } };
    }
    return undefined;
  };
}
