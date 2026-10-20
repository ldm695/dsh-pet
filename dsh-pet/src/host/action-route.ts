import {
  decideBroadcast,
  decideBubbleClear,
  normalizeBroadcastAnim,
  normalizeBroadcastDuration,
  normalizeBroadcastText,
} from './broadcast';
import { decideAnim } from './anim';
import { decidePosition, decideThrow, positionLeafData } from './motion-cue';
import type { LockStore } from './lock';
import { requirePet, validateSurfaceById } from './route-validation';
import type { RouteRequest, RouteResult } from './route-contract';

type ConfigSnapshot = Record<string, Record<string, unknown>>;
type ActionLeaf = 'say' | 'anim' | 'position' | 'throw';

export interface ActionRouteDependencies {
  readConfig: () => ConfigSnapshot;
  refreshBalance: (manual: boolean, targetPetId?: string) => Promise<void>;
  publishWhisper: (petId: string) => Promise<WhisperActionResult>;
  memeDirs: (assetRoot: string) => string[];
  writePet: (petId: string, leaf: ActionLeaf, data: unknown) => void;
  createPlayback: (petId: string, name: string) => { playbackId: string };
  locks: LockStore;
}

export type WhisperActionResult =
  | { ok: true; text: string; image?: string }
  | { ok: false; reason: 'generate-error'; message?: string };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failedDecision(reason: string, message: string): RouteResult {
  return { kind: 'json', status: 200, obj: { ok: false, reason, message } };
}

function generateError(error: unknown): RouteResult {
  return {
    kind: 'json',
    status: 200,
    obj: { ok: false, reason: 'generate-error', message: messageOf(error) },
  };
}

function lockBlocked(locks: LockStore, petId: string, query: URLSearchParams): RouteResult | undefined {
  const gate = locks.gate(petId, String(query.get('lock') ?? ''));
  if (gate.ok) return undefined;
  const obj: Record<string, unknown> = { ok: false, reason: gate.reason, message: gate.message };
  if (gate.reason === 'lock-lost') obj.cause = gate.cause;
  return { kind: 'json', status: 200, obj };
}

/** Action endpoints translate requests into domain decisions and versioned state writes. */
export function createActionRoute(
  deps: ActionRouteDependencies,
): (request: RouteRequest) => Promise<RouteResult | undefined> {
  return async ({ rest, method, body, query }) => {
    if (rest === 'balance') {
      if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      const targetPetId = String(query?.get('pet') ?? '').trim() || undefined;
      await deps.refreshBalance(true, targetPetId);
      return { kind: 'json', status: 200, obj: { ok: true } };
    }

    if (rest === 'whisper') {
      if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      const cfg = deps.readConfig();
      const who = requirePet(cfg, query?.get('pet'));
      if (!who.ok) return who.result;
      const surfaceError = validateSurfaceById(cfg, who.petId, query ?? new URLSearchParams());
      if (surfaceError) return surfaceError;
      try {
        const result = await deps.publishWhisper(who.petId);
        return {
          kind: 'json',
          status: 200,
          obj: result,
        };
      } catch (error) {
        return {
          kind: 'json',
          status: 200,
          obj: { ok: false, reason: 'generate-error', message: messageOf(error) },
        };
      }
    }

    if (rest === 'broadcast') {
      if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      let parsed: unknown;
      try {
        parsed = JSON.parse(body ?? 'null');
      } catch {
        return { kind: 'json', status: 400, obj: { error: 'invalid JSON body' } };
      }
      const payload = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
      if (!normalizeBroadcastText(payload.text)) {
        return { kind: 'json', status: 200, obj: { ok: false, reason: 'bad-request', message: 'text 为空' } };
      }
      const duration = normalizeBroadcastDuration(payload.duration);
      if (duration === null) {
        return {
          kind: 'json',
          status: 200,
          obj: { ok: false, reason: 'bad-request', message: 'duration 必须是 ≥0 的有限数字（毫秒）' },
        };
      }
      const anim = normalizeBroadcastAnim(payload.anim);
      try {
        const cfg = deps.readConfig();
        const decision = decideBroadcast({
          cfg,
          requested: String(query?.get('pet') ?? ''),
          text: payload.text,
          image: payload.image,
          url: payload.url,
          duration,
          anim,
          memeDirs: deps.memeDirs,
        });
        if (!decision.ok) return failedDecision(decision.reason, decision.message);
        const surfaceError = validateSurfaceById(cfg, decision.petId, query ?? new URLSearchParams());
        if (surfaceError) return surfaceError;
        const blocked = lockBlocked(deps.locks, decision.petId, query ?? new URLSearchParams());
        if (blocked) return blocked;
        const data: Record<string, unknown> = { text: decision.text, duration: decision.duration, anim: decision.anim };
        if (decision.image) data.image = decision.image;
        if (decision.url) data.url = decision.url;
        deps.writePet(decision.petId, 'say', data);
        return { kind: 'json', status: 200, obj: { ok: true } };
      } catch (error) {
        return generateError(error);
      }
    }

    if (rest === 'bubble/clear') {
      if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      try {
        const cfg = deps.readConfig();
        const decision = decideBubbleClear({ cfg, requested: String(query?.get('pet') ?? '') });
        if (!decision.ok) return failedDecision(decision.reason, decision.message);
        const surfaceError = validateSurfaceById(cfg, decision.petId, query ?? new URLSearchParams());
        if (surfaceError) return surfaceError;
        const blocked = lockBlocked(deps.locks, decision.petId, query ?? new URLSearchParams());
        if (blocked) return blocked;
        deps.writePet(decision.petId, 'say', { clear: true });
        return { kind: 'json', status: 200, obj: { ok: true } };
      } catch (error) {
        return generateError(error);
      }
    }

    if (rest === 'anim') {
      if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      let parsed: unknown;
      try {
        parsed = JSON.parse(body ?? 'null');
      } catch {
        return { kind: 'json', status: 400, obj: { error: 'invalid JSON body' } };
      }
      const payload = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
      try {
        const cfg = deps.readConfig();
        const decision = decideAnim({
          cfg,
          requested: String(query?.get('pet') ?? ''),
          name: payload.name,
          url: payload.url,
          facing: payload.facing,
        });
        if (!decision.ok) return failedDecision(decision.reason, decision.message);
        const surfaceError = validateSurfaceById(cfg, decision.petId, query ?? new URLSearchParams());
        if (surfaceError) return surfaceError;
        const blocked = lockBlocked(deps.locks, decision.petId, query ?? new URLSearchParams());
        if (blocked) return blocked;
        const playback = deps.createPlayback(decision.petId, decision.url ?? decision.name ?? '');
        const data: Record<string, unknown> = { playbackId: playback.playbackId };
        if (decision.name) data.name = decision.name;
        if (decision.url) data.url = decision.url;
        if (decision.facing) data.facing = decision.facing;
        deps.writePet(decision.petId, 'anim', data);
        return { kind: 'json', status: 200, obj: { ok: true, playbackId: playback.playbackId } };
      } catch (error) {
        return generateError(error);
      }
    }

    if (rest === 'position' || rest === 'throw') {
      const isPosition = rest === 'position';
      if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      let parsed: unknown;
      try {
        parsed = JSON.parse(body ?? 'null');
      } catch {
        return { kind: 'json', status: 400, obj: { error: 'invalid JSON body' } };
      }
      const payload = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
      try {
        const cfg = deps.readConfig();
        const requested = String(query?.get('pet') ?? '');
        if (isPosition) {
          const decision = decidePosition({
            cfg,
            requested,
            x: payload.x,
            y: payload.y,
            mode: payload.mode,
            duration: payload.duration,
          });
          if (!decision.ok) return failedDecision(decision.reason, decision.message);
          const surfaceError = validateSurfaceById(cfg, decision.petId, query ?? new URLSearchParams());
          if (surfaceError) return surfaceError;
          const blocked = lockBlocked(deps.locks, decision.petId, query ?? new URLSearchParams());
          if (blocked) return blocked;
          deps.writePet(decision.petId, 'position', positionLeafData(decision));
          return { kind: 'json', status: 200, obj: { ok: true, x: decision.x, y: decision.y } };
        }
        const decision = decideThrow({ cfg, requested, angle: payload.angle, power: payload.power });
        if (!decision.ok) return failedDecision(decision.reason, decision.message);
        const surfaceError = validateSurfaceById(cfg, decision.petId, query ?? new URLSearchParams());
        if (surfaceError) return surfaceError;
        const blocked = lockBlocked(deps.locks, decision.petId, query ?? new URLSearchParams());
        if (blocked) return blocked;
        deps.writePet(decision.petId, 'throw', { angle: decision.angle, power: decision.power });
        return { kind: 'json', status: 200, obj: { ok: true } };
      } catch (error) {
        return generateError(error);
      }
    }
    return undefined;
  };
}
