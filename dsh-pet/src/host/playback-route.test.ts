import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PlaybackStore } from './playback';
import { createPlaybackRoute } from './playback-route';
import type { RouteRequest } from './route-contract';

const request = (rest: string, method = 'GET', query?: string, body?: string, signal?: AbortSignal): RouteRequest => ({
  rest,
  method,
  query: new URLSearchParams(query),
  body,
  signal,
});

describe('createPlaybackRoute', () => {
  test('validates report methods, JSON, IDs, and status while preserving receipt mapping', async () => {
    const playback = new PlaybackStore();
    const route = createPlaybackRoute({ playback });
    assert.equal(await route(request('other')), undefined);
    assert.deepEqual(await route(request('playback/pb-x/report', 'GET')), {
      kind: 'json',
      status: 405,
      obj: { error: 'method not allowed' },
    });
    assert.deepEqual(await route(request('playback/pb-x/report', 'POST', undefined, '{')), {
      kind: 'json',
      status: 400,
      obj: { error: 'invalid JSON body' },
    });
    assert.deepEqual(await route(request('playback/pb-x/report', 'POST', undefined, '{"status":"ended"}')), {
      kind: 'json',
      status: 404,
      obj: { error: 'unknown playback' },
    });

    const created = playback.create('pet-1', 'wave');
    assert.deepEqual(
      await route(request(`playback/${created.playbackId}/report`, 'POST', undefined, '{"status":"accepted"}')),
      {
        kind: 'json',
        status: 400,
        obj: { error: 'invalid status' },
      },
    );
    assert.deepEqual(
      await route(request(`playback/${created.playbackId}/report`, 'POST', undefined, '{"status":"playing"}')),
      {
        kind: 'json',
        status: 200,
        obj: { ok: true },
      },
    );
    assert.deepEqual(await route(request(`playback/${created.playbackId}`, 'GET')), {
      kind: 'json',
      status: 200,
      obj: { ...created, status: 'playing', updatedAt: playback.get(created.playbackId)?.updatedAt, matched: false },
    });
    assert.deepEqual(await route(request(`playback/${created.playbackId}`, 'POST')), {
      kind: 'json',
      status: 405,
      obj: { error: 'method not allowed' },
    });
    assert.deepEqual(await route(request('playback/missing')), {
      kind: 'json',
      status: 404,
      obj: { error: 'unknown playback' },
    });
    assert.deepEqual(await route(request(`playback/${created.playbackId}`, 'GET', 'wait=ended')), {
      kind: 'json',
      status: 400,
      obj: { error: 'wait and timeout must be used together' },
    });
  });

  test('aborting a wait removes the playback waiter', async () => {
    const playback = new PlaybackStore();
    const record = playback.create('pet-1', 'wave');
    const route = createPlaybackRoute({ playback });
    const controller = new AbortController();
    const pending = route(
      request(`playback/${record.playbackId}`, 'GET', 'wait=ended&timeout=10000', undefined, controller.signal),
    );
    assert.equal(playback.waiterCount(), 1);
    controller.abort();
    assert.deepEqual(await pending, { kind: 'none' });
    assert.equal(playback.waiterCount(), 0);
  });
});
