import {
  decideBroadcast,
  decideBubbleClear,
  normalizeBroadcastAnim,
  normalizeBroadcastDuration,
  normalizeBroadcastText,
} from './broadcast';
import { decideAnim } from './anim';
import { decidePosition, decideThrow, positionLeafData } from './motion-cue';
import type { RouteRequest, RouteResult } from './route-contract';

type ConfigSnapshot = Record<string, Record<string, unknown>>;
type ActionLeaf = 'say' | 'anim' | 'position' | 'throw';

export interface ActionRouteDependencies {
  readConfig: () => ConfigSnapshot;
  activePetId: () => string;
  refreshBalance: (manual: boolean, targetPetId?: string) => Promise<void>;
  publishWhisper: (petId: string) => Promise<boolean>;
  memeDirs: (assetRoot: string) => string[];
  writePet: (petId: string, leaf: ActionLeaf, data: unknown) => void;
  createPlayback: (petId: string, name: string) => { playbackId: string };
}

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

/** Action endpoints that translate requests into existing domain decisions and state writes. */
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
      const petId = String(query?.get('pet') ?? '');
      try {
        const ok = await deps.publishWhisper(petId);
        return {
          kind: 'json',
          status: 200,
          obj: ok ? { ok: true } : { ok: false, reason: 'generate-error' },
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
        const decision = decideBroadcast({
          cfg: deps.readConfig(),
          requested: String(query?.get('pet') ?? ''),
          active: deps.activePetId(),
          text: payload.text,
          image: payload.image,
          duration,
          anim,
          memeDirs: deps.memeDirs,
        });
        if (!decision.ok) return failedDecision(decision.reason, decision.message);
        deps.writePet(
          decision.petId,
          'say',
          decision.image
            ? { text: decision.text, image: decision.image, duration: decision.duration, anim: decision.anim }
            : { text: decision.text, duration: decision.duration, anim: decision.anim },
        );
        return { kind: 'json', status: 200, obj: { ok: true } };
      } catch (error) {
        return generateError(error);
      }
    }

    if (rest === 'bubble/clear') {
      if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      try {
        const decision = decideBubbleClear({
          cfg: deps.readConfig(),
          requested: String(query?.get('pet') ?? ''),
          active: deps.activePetId(),
        });
        if (!decision.ok) return failedDecision(decision.reason, decision.message);
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
        const decision = decideAnim({
          cfg: deps.readConfig(),
          requested: String(query?.get('pet') ?? ''),
          active: deps.activePetId(),
          name: payload.name,
        });
        if (!decision.ok) return failedDecision(decision.reason, decision.message);
        const playback = deps.createPlayback(decision.petId, decision.name);
        deps.writePet(decision.petId, 'anim', { name: decision.name, playbackId: playback.playbackId });
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
        const active = deps.activePetId();
        if (isPosition) {
          const decision = decidePosition({
            cfg,
            requested,
            active,
            x: payload.x,
            y: payload.y,
            mode: payload.mode,
            duration: payload.duration,
          });
          if (!decision.ok) return failedDecision(decision.reason, decision.message);
          deps.writePet(decision.petId, 'position', positionLeafData(decision));
          return { kind: 'json', status: 200, obj: { ok: true, x: decision.x, y: decision.y } };
        }
        const decision = decideThrow({
          cfg,
          requested,
          active,
          angle: payload.angle,
          power: payload.power,
        });
        if (!decision.ok) return failedDecision(decision.reason, decision.message);
        deps.writePet(decision.petId, 'throw', { angle: decision.angle, power: decision.power });
        return { kind: 'json', status: 200, obj: { ok: true } };
      } catch (error) {
        return generateError(error);
      }
    }
    return undefined;
  };
}
