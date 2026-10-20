import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createChatRoute } from './chat-route';
import type { RouteRequest } from './route-contract';

const request = (method: string, query?: string, body?: string): RouteRequest => ({
  rest: 'chat',
  method,
  query: new URLSearchParams(query),
  body,
});

describe('createChatRoute', () => {
  test('maps history and validates a normalized message before generation', async () => {
    const calls: Array<[string, string]> = [];
    const route = createChatRoute({
      readConfig: () => ({ main: { pets: [{ id: 'p1', display: 'desktop' }] } }),
      readHistory: async (petId) => ({ messages: [{ role: 'user', content: petId, ts: 1 }], rounds: 3 }),
      chatWithPet: async (petId, text) => {
        calls.push([petId, text]);
        return { ok: true };
      },
    });
    assert.equal(await route({ ...request('GET'), rest: 'other' }), undefined);
    assert.deepEqual(await route(request('GET', 'pet=p1')), {
      kind: 'json',
      status: 200,
      obj: { ok: true, messages: [{ role: 'user', content: 'p1', ts: 1 }], rounds: 3 },
    });
    assert.deepEqual(await route(request('POST', 'pet=p1&surface=desktop', '{"text":"  hello  "}')), {
      kind: 'json',
      status: 200,
      obj: { ok: true },
    });
    assert.deepEqual(calls, [['p1', 'hello']]);
    assert.deepEqual(await route(request('POST', 'pet=p1&surface=desktop', '{"text":"  "}')), {
      kind: 'json',
      status: 200,
      obj: { ok: false, reason: 'bad-request', message: '消息为空' },
    });
    assert.deepEqual(await route(request('POST', 'pet=p1&surface=desktop', JSON.stringify({ text: 'x'.repeat(2001) }))), {
      kind: 'json',
      status: 200,
      obj: { ok: false, reason: 'bad-request', message: '消息过长（限 2000 字）' },
    });
    assert.deepEqual(await route(request('PUT')), { kind: 'json', status: 405, obj: { error: 'method not allowed' } });
  });

  test('maps memory and generation failures to the established response body', async () => {
    const route = createChatRoute({
      readConfig: () => ({ main: { pets: [{ id: 'p1', display: 'desktop' }] } }),
      readHistory: async () => {
        throw new Error('memory unavailable');
      },
      chatWithPet: async () => {
        throw new Error('model unavailable');
      },
    });
    assert.deepEqual(await route(request('GET', 'pet=p1')), {
      kind: 'json',
      status: 200,
      obj: { ok: false, reason: 'generate-error', message: 'memory unavailable' },
    });
    const invalidJson = await route(request('POST', 'pet=p1&surface=desktop', '{'));
    assert.equal((invalidJson as { obj: { reason: string } }).obj.reason, 'generate-error');
    assert.match((invalidJson as { obj: { message: string } }).obj.message, /JSON/);
    assert.deepEqual(await route(request('POST', 'pet=p1&surface=desktop', '{"text":"hello"}')), {
      kind: 'json',
      status: 200,
      obj: { ok: false, reason: 'generate-error', message: 'model unavailable' },
    });
  });
});
