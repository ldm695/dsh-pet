import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReadonlyRoute } from './readonly-route';

const tempDirs: string[] = [];

after(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('createReadonlyRoute', () => {
  test('/models keeps a failed provider empty and returns other providers', async () => {
    const route = createReadonlyRoute({
      configMeta: () => ({}),
      resolveAppIcon: () => undefined,
      llm: {
        listProviders: () => [
          { id: 'ready', name: 'Ready' },
          { id: 'broken', name: 'Broken' },
        ],
        listModels: async (provider) => {
          if (provider === 'broken') throw new Error('provider unavailable');
          return [{ id: 'model-a' }, { id: '', name: 'invalid' }];
        },
      },
    });

    assert.deepEqual(await route({ rest: 'models', method: 'GET' }), {
      kind: 'json',
      status: 200,
      obj: {
        providers: [
          { id: 'ready', name: 'Ready', models: [{ id: 'model-a', name: 'model-a' }] },
          { id: 'broken', name: 'Broken', models: [] },
        ],
      },
    });
  });

  test('/models falls back to configurable providers when none are registered', async () => {
    const route = createReadonlyRoute({
      configMeta: () => ({}),
      resolveAppIcon: () => undefined,
      llm: {
        listProviders: () => [],
        listConfigurableProviders: () => [{ provider: 'fallback', displayName: 'Fallback' }],
      },
    });

    assert.deepEqual(await route({ rest: 'models', method: 'GET' }), {
      kind: 'json',
      status: 200,
      obj: { providers: [{ id: 'fallback', name: 'Fallback', models: [] }] },
    });
  });

  test('/models preserves method and top-level service errors', async () => {
    const methodRoute = createReadonlyRoute({ configMeta: () => ({}), resolveAppIcon: () => undefined });
    assert.deepEqual(await methodRoute({ rest: 'models', method: 'POST' }), {
      kind: 'json',
      status: 405,
      obj: { error: 'method not allowed' },
    });

    const errorRoute = createReadonlyRoute({
      configMeta: () => ({}),
      resolveAppIcon: () => undefined,
      llm: {
        listProviders: () => {
          throw new Error('service unavailable');
        },
      },
    });
    assert.deepEqual(await errorRoute({ rest: 'models', method: 'GET' }), {
      kind: 'json',
      status: 500,
      obj: { error: 'service unavailable' },
    });
  });

  test('/config/meta delegates its complete payload and keeps method-agnostic behavior', async () => {
    const payload = { user: 'user.jsonc', storage: [{ key: 'userData', exists: true }] };
    let reads = 0;
    const route = createReadonlyRoute({
      configMeta: () => {
        reads += 1;
        return payload;
      },
      resolveAppIcon: () => undefined,
    });

    assert.deepEqual(await route({ rest: 'config/meta', method: 'POST' }), {
      kind: 'json',
      status: 200,
      obj: payload,
    });
    assert.equal(reads, 1);
  });

  test('/app-icon.png returns the resolved file or the original not-found response', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-readonly-route-'));
    tempDirs.push(dir);
    const icon = join(dir, 'icon.png');
    writeFileSync(icon, Buffer.from([137, 80, 78, 71]));
    const route = createReadonlyRoute({ configMeta: () => ({}), resolveAppIcon: () => icon });

    assert.deepEqual(await route({ rest: 'app-icon.png', method: 'GET' }), {
      kind: 'file',
      file: icon,
      contentType: 'image/png',
    });
    assert.deepEqual(await route({ rest: 'app-icon.png', method: 'POST' }), {
      kind: 'json',
      status: 405,
      obj: { error: 'method not allowed' },
    });

    const missingRoute = createReadonlyRoute({ configMeta: () => ({}), resolveAppIcon: () => undefined });
    assert.deepEqual(await missingRoute({ rest: 'app-icon.png', method: 'GET' }), {
      kind: 'text',
      status: 404,
      body: 'dsh-pet: app icon not found',
    });
  });

  test('unknown paths remain unhandled', async () => {
    const route = createReadonlyRoute({ configMeta: () => ({}), resolveAppIcon: () => undefined });
    assert.equal(await route({ rest: 'other', method: 'GET' }), undefined);
  });
});
