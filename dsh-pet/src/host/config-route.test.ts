import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { ConfigRouteDependencies } from './config-route';
import { createConfigRoute } from './config-route';
import type { RouteRequest } from './route-contract';

const pet = (id: string, display = 'both') => ({
  id,
  name: id,
  size: 320,
  balanceEnabled: true,
  display,
  position: { corner: 'bottom-right', marginX: 0, marginY: 0 },
});

function fixture(overrides: Partial<ConfigRouteDependencies> = {}) {
  const calls: string[] = [];
  const config = {
    main: { pets: [pet('main-a'), pet('main-b')] },
    pack: { pets: [pet('pack-a')] },
  };
  const deps: ConfigRouteDependencies = {
    userRoot: '/user',
    userConfigPath: '/user/main-config.jsonc',
    petConfigDir: '/user/pet',
    findPetConfigEntry: (entry) =>
      entry === 'pack' ? { path: '/user/pet/pack.jsonc', raw: { pets: [pet('pack-a')] } } : undefined,
    readAll: () => config,
    readUser: () => ({ pets: [...config.main.pets], whisperPrompt: 'keep me' }),
    userUnparsable: () => false,
    syncDefault: () => calls.push('sync-default'),
    writeConfig: async (path, _directory, content) => {
      calls.push(`write:${path}:${content}`);
    },
    writeConfigChanged: () => calls.push('config-changed'),
    reloadDesktop: () => calls.push('reload'),
    mapResponseConfig: (value) => ({ ...value, mapped: true }),
    ...overrides,
  };
  return { route: createConfigRoute(deps), calls, config };
}

const request = (rest: string, method = 'GET', body?: string, query?: string): RouteRequest => ({
  rest,
  method,
  body,
  query: new URLSearchParams(query),
});

describe('createConfigRoute', () => {
  test('/config GET and method matrix preserve response and cache behavior', async () => {
    const { route } = fixture();
    assert.deepEqual(await route(request('config')), {
      kind: 'json',
      status: 200,
      obj: { main: { pets: [pet('main-a'), pet('main-b')] }, pack: { pets: [pet('pack-a')] }, mapped: true },
      headers: { 'cache-control': 'no-cache, no-store' },
    });
    for (const method of ['DELETE', 'PATCH']) {
      assert.deepEqual(await route(request('config', method)), {
        kind: 'json',
        status: 405,
        obj: { error: 'method not allowed' },
      });
    }
    assert.deepEqual(await route(request('pet-display', 'GET')), {
      kind: 'json',
      status: 405,
      obj: { error: 'method not allowed' },
    });
    assert.deepEqual(await route(request('pet-display/bulk', 'GET')), {
      kind: 'json',
      status: 405,
      obj: { error: 'method not allowed' },
    });
    assert.deepEqual(await route(request('reload', 'GET')), {
      kind: 'json',
      status: 405,
      obj: { error: 'method not allowed' },
    });
  });

  test('/config PUT validates payload, checks corruption, honors force, and orders side effects after write', async () => {
    const { route, calls } = fixture({ userUnparsable: () => true });
    const body = JSON.stringify({ pets: [pet('main-a')] });
    assert.deepEqual(await route(request('config', 'PUT', '{')), {
      kind: 'json',
      status: 400,
      obj: { error: 'invalid JSON body' },
    });
    assert.equal(
      ((await route(request('config', 'PUT', JSON.stringify({ pets: [] })))) as { status: number }).status,
      400,
    );
    assert.deepEqual(await route(request('config', 'PUT', body)), {
      kind: 'json',
      status: 409,
      obj: { error: 'user config is unparsable', needConfirm: true, userFile: '/user/main-config.jsonc' },
    });
    assert.deepEqual(await route(request('config', 'PUT', body, 'force=1')), {
      kind: 'json',
      status: 200,
      obj: { main: { pets: [pet('main-a'), pet('main-b')] }, pack: { pets: [pet('pack-a')] }, mapped: true },
    });
    assert.equal(calls.length, 2);
    assert.ok(calls[0].startsWith('write:/user/main-config.jsonc:'));
    assert.equal(calls[1], 'reload');
  });

  test('/config POST reports sync failure and otherwise syncs before one reload', async () => {
    const failed = fixture({
      syncDefault: () => {
        throw new Error('read only');
      },
    });
    assert.deepEqual(await failed.route(request('config', 'POST')), {
      kind: 'json',
      status: 500,
      obj: { error: 'read only' },
    });
    assert.deepEqual(failed.calls, []);

    const passed = fixture();
    assert.equal(((await passed.route(request('config', 'POST'))) as { status: number }).status, 200);
    assert.deepEqual(passed.calls, ['sync-default', 'reload']);
  });

  test('bulk display validates every target before writes, groups files, and updates/reloads once after success', async () => {
    const { route, calls } = fixture();
    const body = JSON.stringify({ ids: [' main-a ', 'main-a', 'pack-a'], display: 'desktop' });
    const result = await route(request('pet-display/bulk', 'POST', body));
    assert.equal((result as { status: number }).status, 200);
    const writes = calls.filter((call) => call.startsWith('write:'));
    assert.equal(writes.length, 2);
    assert.ok(writes[0].startsWith('write:/user/main-config.jsonc:'));
    assert.ok(writes[1].startsWith('write:/user/pet/pack.jsonc:'));
    assert.deepEqual(calls.slice(-2), ['config-changed', 'reload']);

    const missing = fixture();
    assert.deepEqual(
      await missing.route(
        request('pet-display/bulk', 'POST', JSON.stringify({ ids: ['main-a', 'unknown'], display: 'web' })),
      ),
      {
        kind: 'json',
        status: 404,
        obj: { error: 'pet not found: unknown' },
      },
    );
    assert.equal(missing.calls.length, 0);
    assert.deepEqual(await missing.route(request('pet-display/bulk', 'POST', '{')), {
      kind: 'json',
      status: 400,
      obj: { error: 'invalid JSON body' },
    });
    assert.deepEqual(
      await missing.route(request('pet-display/bulk', 'POST', JSON.stringify({ ids: [], display: 'web' }))),
      { kind: 'json', status: 400, obj: { error: 'missing pet ids' } },
    );
    assert.deepEqual(
      await missing.route(request('pet-display/bulk', 'POST', JSON.stringify({ ids: ['main-a'], display: 'invalid' }))),
      { kind: 'json', status: 400, obj: { error: 'invalid display: invalid' } },
    );

    let attemptedWrites = 0;
    const partialFailure = fixture({
      writeConfig: async () => {
        attemptedWrites += 1;
        if (attemptedWrites === 2) throw new Error('disk full');
      },
    });
    assert.deepEqual(
      await partialFailure.route(
        request('pet-display/bulk', 'POST', JSON.stringify({ ids: ['main-a', 'pack-a'], display: 'desktop' })),
      ),
      { kind: 'json', status: 500, obj: { error: 'disk full' } },
    );
    assert.equal(attemptedWrites, 2);
    assert.deepEqual(partialFailure.calls, [], '失败写入不应发 config 变更信号或重载桌面端');
  });

  test('single display preserves its layer fields and only signals after a successful write', async () => {
    const { route, calls } = fixture();
    const result = await route(request('pet-display', 'POST', JSON.stringify({ id: 'pack-a', display: 'none' })));
    assert.equal((result as { status: number }).status, 200);
    assert.ok(calls[0].startsWith('write:/user/pet/pack.jsonc:'));
    assert.deepEqual(calls.slice(1), ['config-changed', 'reload']);

    const failed = fixture({
      writeConfig: async () => {
        throw new Error('disk full');
      },
    });
    assert.deepEqual(
      await failed.route(request('pet-display', 'POST', JSON.stringify({ id: 'main-a', display: 'none' }))),
      {
        kind: 'json',
        status: 500,
        obj: { error: 'disk full' },
      },
    );
    assert.deepEqual(failed.calls, []);
    assert.deepEqual(await route(request('pet-display', 'POST', JSON.stringify({ id: 'missing', display: 'none' }))), {
      kind: 'json',
      status: 404,
      obj: { error: 'pet not found: missing' },
    });
  });

  test('reload schedules desktop synchronization once and unknown routes are unhandled', async () => {
    const { route, calls } = fixture();
    assert.deepEqual(await route(request('reload', 'POST')), { kind: 'json', status: 200, obj: { reloading: true } });
    assert.deepEqual(calls, ['reload']);
    assert.equal(await route(request('something-else')), undefined);
  });
});
