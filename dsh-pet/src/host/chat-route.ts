import type { ChatMemoryMessage } from './chat';
import type { RouteRequest, RouteResult } from './route-contract';

export interface ChatRouteDependencies {
  readHistory: (petId: string) => Promise<{ messages: ChatMemoryMessage[]; rounds: number }>;
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
    if (rest === 'chat') {
      const petId = String(query?.get('pet') ?? '');
      try {
        if (method === 'GET') {
          const { messages, rounds } = await deps.readHistory(petId);
          return { kind: 'json', status: 200, obj: { ok: true, messages, rounds } };
        }
        if (method === 'POST') {
          const parsed = (JSON.parse(body ?? 'null') as Record<string, unknown> | null) ?? {};
          const text = typeof parsed.text === 'string' ? parsed.text.trim() : '';
          if (!text)
            return { kind: 'json', status: 200, obj: { ok: false, reason: 'bad-request', message: '消息为空' } };
          if (text.length > 2000) {
            return {
              kind: 'json',
              status: 200,
              obj: { ok: false, reason: 'bad-request', message: '消息过长（限 2000 字）' },
            };
          }
          return { kind: 'json', status: 200, obj: await deps.chatWithPet(petId, text) };
        }
        return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      } catch (error) {
        return {
          kind: 'json',
          status: 200,
          obj: { ok: false, reason: 'generate-error', message: errorMessage(error) },
        };
      }
    }
    return undefined;
  };
}
