import { normalizePoseInput, type PoseStore } from './pose';
import type { RouteRequest, RouteResult } from './route-contract';
import { requirePet, validatePetSurface, type ConfigSnapshot } from './route-validation';
import { displayCovers } from './surface';

export interface PoseRouteDependencies {
  readConfig: () => ConfigSnapshot;
  store: PoseStore;
}

/** Desktop-only position/facing snapshot route; the removed DSH Web renderer is not involved. */
export function createPoseRoute(
  deps: PoseRouteDependencies,
): (request: RouteRequest) => Promise<RouteResult | undefined> {
  return async ({ rest, method, body, query }) => {
    if (rest !== 'pose' && rest !== 'pose/report') return undefined;
    const report = rest === 'pose/report';
    if ((report && method !== 'POST') || (!report && method !== 'GET')) {
      return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
    }

    const config = deps.readConfig();
    const who = requirePet(config, query?.get('pet'));
    if (!who.ok) return who.result;
    const display = String(who.pet.display ?? '');

    if (report) {
      const surfaceError = validatePetSurface(who.pet, who.petId, query ?? new URLSearchParams());
      if (surfaceError) return surfaceError;
      let input: unknown;
      try {
        input = JSON.parse(body ?? 'null');
      } catch {
        return { kind: 'json', status: 400, obj: { error: 'invalid JSON body' } };
      }
      const parsed = normalizePoseInput(input);
      if (!parsed.ok) {
        return { kind: 'json', status: 200, obj: { ok: false, reason: parsed.reason, message: parsed.message } };
      }
      deps.store.set(who.petId, parsed.pose);
      return { kind: 'json', status: 200, obj: { ok: true } };
    }

    if (!displayCovers('desktop', display)) {
      return {
        kind: 'json',
        status: 200,
        obj: {
          ok: false,
          reason: 'pet-not-displayed',
          message: `${who.petId} 的显示模式是 ${display}；桌面端实况只对桌面宠物有效`,
          display,
        },
      };
    }
    const snapshot = deps.store.get(who.petId);
    if (!snapshot) {
      return {
        kind: 'json',
        status: 200,
        obj: { ok: false, reason: 'pose-unavailable', message: '尚未收到这只宠物的桌面位置与朝向' },
      };
    }
    return { kind: 'json', status: 200, obj: { ok: true, petId: who.petId, ...snapshot } };
  };
}
