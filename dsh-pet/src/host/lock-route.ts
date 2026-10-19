import type { LockStore } from './lock';
import { requirePet, requireSurface, validatePetSurface, type ConfigSnapshot } from './route-validation';
import type { RouteRequest, RouteResult } from './route-contract';

export interface LockRouteDependencies {
  readConfig: () => ConfigSnapshot;
  locks: LockStore;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Per-pet exclusive control lease endpoints. */
export function createLockRoute(
  deps: LockRouteDependencies,
): (request: RouteRequest) => Promise<RouteResult | undefined> {
  return async ({ rest, method, body, query }) => {
    if (rest !== 'lock' && rest !== 'lock/release') return undefined;
    if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };

    let parsed: unknown;
    try {
      parsed = JSON.parse(body ?? 'null');
    } catch {
      return { kind: 'json', status: 400, obj: { error: 'invalid JSON body' } };
    }
    const payload = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    const params = query ?? new URLSearchParams();
    const isRelease = rest === 'lock/release';
    if (!isRelease) {
      const surface = requireSurface(params);
      if (!surface.ok) return surface.result;
    }

    try {
      const cfg = deps.readConfig();
      const who = requirePet(cfg, params.get('pet'));
      if (!who.ok) return who.result;
      if (!isRelease) {
        const surfaceError = validatePetSurface(who.pet, who.petId, params);
        if (surfaceError) return surfaceError;
      }

      if (isRelease) {
        const decision = deps.locks.release({ petId: who.petId, lockId: payload.lockId, force: payload.force });
        if (!decision.ok) {
          const obj: Record<string, unknown> = { ok: false, reason: decision.reason, message: decision.message };
          if (decision.reason === 'lock-lost') obj.cause = decision.cause;
          return { kind: 'json', status: 200, obj };
        }
        return { kind: 'json', status: 200, obj: { ok: true } };
      }

      const decision = deps.locks.acquire({ petId: who.petId, lockId: payload.lockId, ttl: payload.ttl });
      if (!decision.ok) {
        const obj: Record<string, unknown> = { ok: false, reason: decision.reason, message: decision.message };
        if (decision.reason === 'locked') obj.expiresAt = decision.expiresAt;
        if (decision.reason === 'lock-lost') obj.cause = decision.cause;
        return { kind: 'json', status: 200, obj };
      }
      return {
        kind: 'json',
        status: 200,
        obj: { ok: true, pet: decision.petId, lockId: decision.lockId, expiresAt: decision.expiresAt, renewed: decision.renewed },
      };
    } catch (error) {
      return { kind: 'json', status: 200, obj: { ok: false, reason: 'generate-error', message: messageOf(error) } };
    }
  };
}
