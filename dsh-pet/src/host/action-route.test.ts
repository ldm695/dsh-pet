import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createActionRoute, type ActionRouteDependencies } from './action-route';
import type { RouteRequest } from './route-contract';

function fixture(overrides: Partial<ActionRouteDependencies> = {}) {
  const calls: Array<{ kind: string; args: unknown[] }> = [];
  const config = {
    main: {
      pets: [{ id: 'main', name: 'Main' }],
      animations: { idle: ['idle'] },
    },
  };
  const deps: ActionRouteDependencies = {
    readConfig: () => config,
    activePetId: () => 'main',
    refreshBalance: async (...args) => {
      calls.push({ kind: 'balance', args });
    },
    publishWhisper: async (...args) => {
      calls.push({ kind: 'whisper', args });
      return true;
    },
    memeDirs: (...args) => {
      calls.push({ kind: 'meme-dirs', args });
      return [];
    },
    writePet: (...args) => calls.push({ kind: 'write', args }),
    createPlayback: (...args) => {
      calls.push({ kind: 'playback', args });
      return { playbackId: 'play-1' };
    },
    ...overrides,
  };
  return { route: createActionRoute(deps), calls };
}

const request = (rest: string, method = 'POST', body?: string, query?: string): RouteRequest => ({
  rest,
  method,
  body,
  query: new URLSearchParams(query),
});

describe('createActionRoute', () => {
  test('balance and whisper keep targeted pet values and response semantics', async () => {
    const { route, calls } = fixture();
    assert.deepEqual(await route(request('balance', 'POST', undefined, 'pet=%20main%20')), {
      kind: 'json',
      status: 200,
      obj: { ok: true },
    });
    assert.deepEqual(await route(request('whisper', 'POST', undefined, 'pet=main')), {
      kind: 'json',
      status: 200,
      obj: { ok: true },
    });
    assert.deepEqual(calls, [
      { kind: 'balance', args: [true, 'main'] },
      { kind: 'whisper', args: ['main'] },
    ]);

    const failed = fixture({ publishWhisper: async () => false });
    assert.deepEqual(await failed.route(request('whisper')), {
      kind: 'json',
      status: 200,
      obj: { ok: false, reason: 'generate-error' },
    });
    const thrown = fixture({
      publishWhisper: async () => {
        throw new Error('provider failed');
      },
    });
    assert.deepEqual(await thrown.route(request('whisper')), {
      kind: 'json',
      status: 200,
      obj: { ok: false, reason: 'generate-error', message: 'provider failed' },
    });
  });

  test('broadcast normalizes payload and writes the accepted say leaf once', async () => {
    const { route, calls } = fixture();
    assert.deepEqual(
      await route(request('broadcast', 'POST', JSON.stringify({ text: '  hello  ', anim: false }), 'pet=main')),
      {
        kind: 'json',
        status: 200,
        obj: { ok: true },
      },
    );
    assert.deepEqual(calls, [
      { kind: 'write', args: ['main', 'say', { text: 'hello', duration: 10000, anim: false }] },
    ]);
    assert.deepEqual(await route(request('broadcast', 'POST', '{')), {
      kind: 'json',
      status: 400,
      obj: { error: 'invalid JSON body' },
    });
    assert.deepEqual(await route(request('broadcast', 'POST', JSON.stringify({ text: 'hello', duration: -1 }))), {
      kind: 'json',
      status: 200,
      obj: { ok: false, reason: 'bad-request', message: 'duration 必须是 ≥0 的有限数字（毫秒）' },
    });
    assert.equal(calls.length, 1);
  });

  test('bubble clear is idempotent and only writes the say leaf', async () => {
    const { route, calls } = fixture();
    assert.deepEqual(await route(request('bubble/clear')), { kind: 'json', status: 200, obj: { ok: true } });
    assert.deepEqual(calls, [{ kind: 'write', args: ['main', 'say', { clear: true }] }]);
  });

  test('animation creates a playback receipt before writing its leaf', async () => {
    const { route, calls } = fixture();
    assert.deepEqual(await route(request('anim', 'POST', JSON.stringify({ name: 'idle' }))), {
      kind: 'json',
      status: 200,
      obj: { ok: true, playbackId: 'play-1' },
    });
    assert.deepEqual(calls, [
      { kind: 'playback', args: ['main', 'idle'] },
      { kind: 'write', args: ['main', 'anim', { name: 'idle', playbackId: 'play-1' }] },
    ]);
  });

  test('position clamps coordinates and throw preserves requested physics values', async () => {
    const { route, calls } = fixture();
    assert.deepEqual(await route(request('position', 'POST', JSON.stringify({ x: 2, y: -1, mode: 'spring' }))), {
      kind: 'json',
      status: 200,
      obj: { ok: true, x: 1, y: 0 },
    });
    assert.deepEqual(await route(request('throw', 'POST', JSON.stringify({ angle: 45, power: 0.5 }))), {
      kind: 'json',
      status: 200,
      obj: { ok: true },
    });
    assert.deepEqual(calls, [
      { kind: 'write', args: ['main', 'position', { x: 1, y: 0, mode: 'spring' }] },
      { kind: 'write', args: ['main', 'throw', { angle: 45, power: 0.5 }] },
    ]);
  });

  test('all action routes retain their method guards and unknown routes remain unhandled', async () => {
    const { route } = fixture();
    for (const rest of ['balance', 'whisper', 'broadcast', 'bubble/clear', 'anim', 'position', 'throw']) {
      assert.deepEqual(await route(request(rest, 'GET')), {
        kind: 'json',
        status: 405,
        obj: { error: 'method not allowed' },
      });
    }
    assert.equal(await route(request('not-an-action')), undefined);
  });
});
