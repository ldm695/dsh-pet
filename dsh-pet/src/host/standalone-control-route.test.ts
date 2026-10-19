import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createStandaloneControlRoute } from './standalone-control-route';
import type { RouteRequest } from './route-contract';

const request = (rest: string, method = 'POST'): RouteRequest => ({ rest, method });

describe('createStandaloneControlRoute', () => {
  test('keeps standalone control commands and rejects them outside standalone mode', () => {
    const lines: string[] = [];
    const enabled = createStandaloneControlRoute({
      isStandalone: () => true,
      sendControlLine: (line) => lines.push(line),
    });
    assert.equal(enabled(request('other')), undefined);
    assert.deepEqual(enabled(request('settings/open')), { kind: 'json', status: 200, obj: { ok: true } });
    assert.deepEqual(enabled(request('app/quit')), { kind: 'json', status: 200, obj: { ok: true } });
    assert.deepEqual(lines, ['open-settings', 'quit-app']);
    assert.deepEqual(enabled(request('settings/open', 'GET')), {
      kind: 'json',
      status: 405,
      obj: { error: 'method not allowed' },
    });

    const hosted = createStandaloneControlRoute({ isStandalone: () => false, sendControlLine: () => assert.fail() });
    assert.deepEqual(hosted(request('settings/open')), { kind: 'json', status: 404, obj: { error: 'not found' } });
  });
});
