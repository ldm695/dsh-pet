import { findPetInstance } from './config';
import { displayCovers, normalizeSurface, SURFACE_TEXT, type Surface } from './surface';
import type { RouteResult } from './route-contract';

export type ConfigSnapshot = Record<string, Record<string, unknown>>;

export function badRequest(message: string): RouteResult {
  return { kind: 'json', status: 200, obj: { ok: false, reason: 'bad-request', message } };
}

export function requireSurface(query: URLSearchParams): { ok: true; surface: Surface } | { ok: false; result: RouteResult } {
  const surface = normalizeSurface(query.get('surface'));
  return surface
    ? { ok: true, surface }
    : { ok: false, result: badRequest(SURFACE_TEXT) };
}

export function requirePet(
  cfg: ConfigSnapshot,
  requested: unknown,
): { ok: true; petId: string; pet: Record<string, unknown> } | { ok: false; result: RouteResult } {
  const petId = typeof requested === 'string' ? requested.trim() : '';
  if (!petId) {
    return {
      ok: false,
      result: { kind: 'json', status: 200, obj: { ok: false, reason: 'pet-required', message: 'pet 必填：要指定操作哪只桌宠' } },
    };
  }
  const found = findPetInstance(cfg, petId);
  if (!found) {
    return {
      ok: false,
      result: { kind: 'json', status: 200, obj: { ok: false, reason: 'unknown-pet', message: '没有这只桌宠：' + petId } },
    };
  }
  return { ok: true, petId, pet: found.pet };
}

export function validatePetSurface(
  pet: Record<string, unknown>,
  petId: string,
  query: URLSearchParams,
): RouteResult | undefined {
  const surface = requireSurface(query);
  if (!surface.ok) return surface.result;
  const display = String(pet.display ?? '');
  if (displayCovers(surface.surface, display)) return undefined;
  return {
    kind: 'json',
    status: 200,
    obj: {
      ok: false,
      reason: 'pet-not-displayed',
      message: petId + ' 的显示模式是 ' + display + '，不满足 surface=' + surface.surface,
      display,
    },
  };
}

export function validateSurfaceById(
  cfg: ConfigSnapshot,
  petId: string,
  query: URLSearchParams,
): RouteResult | undefined {
  const found = findPetInstance(cfg, petId);
  return validatePetSurface(found?.pet ?? {}, petId, query);
}
