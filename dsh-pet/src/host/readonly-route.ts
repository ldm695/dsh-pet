import type { RouteRequest, RouteResult } from './route-contract';

type NamedItem = { id?: unknown; name?: unknown };

export interface ReadonlyRouteLlm {
  listProviders?: () => NamedItem[];
  listConfigurableProviders?: () => Array<{ provider?: unknown; displayName?: unknown }>;
  listModels?: (provider: string) => NamedItem[] | Promise<NamedItem[]>;
}

export interface ReadonlyRouteDependencies {
  llm?: ReadonlyRouteLlm;
  /** Kept as a callback so dynamic filesystem presence flags stay fresh per request. */
  configMeta: () => unknown;
  resolveAppIcon: () => string | undefined;
}

function named(id: unknown, name: unknown): { id: string; name: string } {
  const value = String(id ?? '');
  return { id: value, name: String(name ?? '') || value };
}

/** Small read-only endpoints that need host services or package metadata. */
export function createReadonlyRoute(
  deps: ReadonlyRouteDependencies,
): (request: RouteRequest) => Promise<RouteResult | undefined> {
  return async ({ rest, method }) => {
    if (rest === 'config/meta') {
      // This endpoint historically ignored the method and always returned metadata.
      return { kind: 'json', status: 200, obj: deps.configMeta() };
    }

    if (rest === 'models') {
      if (method !== 'GET') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      try {
        const llm = deps.llm;
        let providers = (typeof llm?.listProviders === 'function' ? llm.listProviders() : []).map((provider) =>
          named(provider?.id, provider?.name),
        );
        if (providers.length === 0 && typeof llm?.listConfigurableProviders === 'function') {
          providers = llm
            .listConfigurableProviders()
            .map((provider) => named(provider?.provider, provider?.displayName));
        }
        providers = providers.filter((provider) => provider.id);
        const catalog = await Promise.all(
          providers.map(async (provider) => {
            let models: Array<{ id: string; name: string }> = [];
            try {
              const list = await llm?.listModels?.(provider.id);
              models = (Array.isArray(list) ? list : [])
                .map((model) => named(model?.id, model?.name))
                .filter((model) => model.id);
            } catch {
              // One unavailable provider should not hide the rest of the catalog.
            }
            return { ...provider, models };
          }),
        );
        return { kind: 'json', status: 200, obj: { providers: catalog } };
      } catch (error) {
        return {
          kind: 'json',
          status: 500,
          obj: { error: error instanceof Error ? error.message : String(error) },
        };
      }
    }

    if (rest === 'app-icon.png') {
      if (method !== 'GET') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      const appIcon = deps.resolveAppIcon();
      if (appIcon === undefined) return { kind: 'text', status: 404, body: 'dsh-pet: app icon not found' };
      return { kind: 'file', file: appIcon, contentType: 'image/png' };
    }

    return undefined;
  };
}
