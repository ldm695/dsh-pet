import type { RouteRequest, RouteResult } from './route-contract';
import { requirePet, validatePetSurface, type ConfigSnapshot } from './route-validation';

export interface ChatRouteDependencies {
  readConfig: () => ConfigSnapshot;
  readHistory: (petId: string, rounds?: number) => Promise<{ messages: unknown[]; rounds: number }>;
  chatWithPet: (petId: string, text: string) => Promise<unknown>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Chat request validation and response mapping; memory/model work stays in host services. */
export function createChatRoute(
  deps: ChatRouteDependencies,
): (request: RouteRequest) => Promise<RouteResult | undefined> {
  return async ({ rest, method, body, query }) => {
    if (rest !== 'chat') return undefined;
    if (method !== 'GET' && method !== 'POST') {
      return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
    }

    try {
      let roundsOverride: number | undefined;
      const roundsRaw = method === 'GET' ? (query?.get('rounds') ?? null) : null;
      if (roundsRaw !== null && roundsRaw.trim() !== '') {
        const rounds = Number(roundsRaw);
        if (!Number.isInteger(rounds) || rounds < 0 || rounds > 200) {
          return {
            kind: 'json',
            status: 200,
            obj: { ok: false, reason: 'bad-request', message: 'rounds 必须是 0–200 的整数（不传则用配置）' },
          };
        }
        roundsOverride = rounds;
      }

      let payload: Record<string, unknown> = {};
      if (method === 'POST') {
        try {
          const parsed = JSON.parse(body ?? 'null');
          payload = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
        } catch {
          return { kind: 'json', status: 400, obj: { error: 'invalid JSON body' } };
        }
        const text = typeof payload.text === 'string' ? payload.text.trim() : '';
        if (!text) {
          return { kind: 'json', status: 200, obj: { ok: false, reason: 'bad-request', message: '消息为空' } };
        }
        if (text.length > 2000) {
          return { kind: 'json', status: 200, obj: { ok: false, reason: 'bad-request', message: '消息过长（限 2000 字）' } };
        }
      }

      const who = requirePet(deps.readConfig(), query?.get('pet'));
      if (!who.ok) return who.result;
      if (method === 'GET') {
        const { messages, rounds } = await deps.readHistory(who.petId, roundsOverride);
        return { kind: 'json', status: 200, obj: { ok: true, messages, rounds } };
      }

      const surfaceError = validatePetSurface(who.pet, who.petId, query ?? new URLSearchParams());
      if (surfaceError) return surfaceError;
      return { kind: 'json', status: 200, obj: await deps.chatWithPet(who.petId, String(payload.text).trim()) };
    } catch (error) {
      return {
        kind: 'json',
        status: 200,
        obj: { ok: false, reason: 'generate-error', message: errorMessage(error) },
      };
    }
  };
}
