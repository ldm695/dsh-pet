import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PollStateStore } from './state';
import { createStateRoute } from './state-route';
import { createExternalWorkStatusRoute } from './external-work-status-route';
import { WorkStatusStore } from './work-status';
import { toWorkStatus } from '../shared/work-status';
import type { RouteRequest } from './route-contract';

const tempDirs: string[] = [];
after(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const request = (rest = 'state', method = 'GET', query?: string, signal?: AbortSignal): RouteRequest => ({
  rest,
  method,
  query: new URLSearchParams(query),
  signal,
});

describe('createStateRoute', () => {
  test('外部状态与客户端桥接并存，撤销外部槽后客户端继续工作', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-external-work-'));
    tempDirs.push(dir);
    const paths = { dsh: join(dir, 'dsh.json'), codex: join(dir, 'codex.json'), claude: join(dir, 'claude.json') };
    const now = Date.now();
    writeFileSync(
      paths.codex,
      JSON.stringify({
        version: 2,
        updatedAt: now,
        agents: [{ key: 'root', state: 'thinking', revision: 1, startedAt: now - 100, eventAt: now - 100 }],
      }),
    );
    const state = new PollStateStore();
    const external = createExternalWorkStatusRoute(new WorkStatusStore(), () => {});
    const route = createStateRoute({ state, isStandalone: () => true, bridgePaths: paths, externalWorkSnapshot: external.snapshot });
    await external.handle({ rest: 'work-status', method: 'POST', body: JSON.stringify({ state: 'working', task: '外部任务' }) });
    await route(request());
    const snapshot = toWorkStatus(state.read().sections.workStatus.data);
    assert.ok(snapshot);
    assert.deepEqual(snapshot.agents?.map((agent) => agent.key).sort(), ['api:client', 'codex:client']);
    assert.equal(snapshot.agents?.find((agent) => agent.key === 'api:client')?.task, '外部任务');
    await external.handle({ rest: 'work-status', method: 'DELETE' });
    await route(request());
    const remaining = toWorkStatus(state.read().sections.workStatus.data);
    assert.equal(remaining?.state, 'thinking');
    assert.deepEqual(remaining?.agents?.map((agent) => agent.key), ['codex:client']);
  });

  test('normal state reads remain no-cache, and invalid methods/query keep their original errors', async () => {
    const state = new PollStateStore();
    const route = createStateRoute({
      state,
      isStandalone: () => false,
      bridgePaths: { dsh: '', codex: '', claude: '' },
    });
    const result = await route(request());
    assert.equal((result as { kind: string }).kind, 'json');
    assert.deepEqual((result as { headers: unknown }).headers, { 'cache-control': 'no-cache, no-store' });
    assert.equal((result as { obj: { longPoll?: false } }).obj.longPoll, undefined);
    assert.deepEqual(await route(request('state', 'POST')), {
      kind: 'json',
      status: 405,
      obj: { error: 'method not allowed' },
    });
    assert.deepEqual(await route(request('state', 'GET', 'since=1')), {
      kind: 'json',
      status: 400,
      obj: { error: 'since and timeout must be used together' },
    });
    assert.equal(await route(request('other')), undefined);
  });

  test('aborting long polling removes its state waiter and returns no response', async () => {
    const state = new PollStateStore();
    const route = createStateRoute({
      state,
      isStandalone: () => false,
      bridgePaths: { dsh: '', codex: '', claude: '' },
    });
    const controller = new AbortController();
    const resultPromise = route(request('state', 'GET', 'since=0&timeout=5000', controller.signal));
    assert.equal(state.waiterCount(), 1);
    controller.abort();
    assert.deepEqual(await resultPromise, { kind: 'none' });
    assert.equal(state.waiterCount(), 0);
  });

  test('standalone bridges group sessions per client, keep stable revisions, and publish one notification', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-state-route-'));
    tempDirs.push(dir);
    const paths = { dsh: join(dir, 'dsh.json'), codex: join(dir, 'codex.json'), claude: join(dir, 'claude.json') };
    const now = Date.now();
    writeFileSync(
      paths.dsh,
      JSON.stringify({
        version: 2,
        updatedAt: now,
        agents: [{ key: 'root', state: 'working', revision: 2, startedAt: now - 500, eventAt: now }],
        notification: { revision: 3, title: 'Done', body: 'Finished', createdAt: now, sourceForeground: false },
      }),
    );
    writeFileSync(
      paths.codex,
      JSON.stringify({
        version: 2,
        updatedAt: now,
        agents: [
          { key: 'root', state: 'working', revision: 4, startedAt: now - 400, eventAt: now - 50 },
          { key: 'subagent', state: 'success', revision: 8, startedAt: now - 300, eventAt: now - 30 },
        ],
      }),
    );
    writeFileSync(
      paths.claude,
      JSON.stringify({
        version: 2,
        updatedAt: now,
        agents: [{ key: 'root', state: 'thinking', revision: 5, startedAt: now - 20, eventAt: now - 20 }],
      }),
    );
    const state = new PollStateStore();
    const route = createStateRoute({ state, isStandalone: () => true, bridgePaths: paths });

    const first = (await route(request())) as {
      obj: { longPoll?: false; sections: Record<string, { data: unknown }> };
    };
    assert.equal(first.obj.longPoll, false);
    const work = first.obj.sections.workStatus.data as {
      state: string;
      sourceName: string;
      agents: Array<{ key: string }>;
    };
    assert.equal(work.state, 'working');
    assert.equal(work.sourceName, 'DeepSeek Harness');
    assert.deepEqual(
      work.agents.map((agent) => agent.key),
      ['dsh:client', 'codex:client', 'claude:client'],
    );
    assert.deepEqual(first.obj.sections.notify.data, {
      type: 'standalone',
      source: 'dsh',
      sourceForeground: false,
      title: 'Done',
      body: 'Finished',
      icon: 'notify-done',
    });
    const counter = first.obj.sections.workStatus.data && state.read().counter;
    const second = (await route(request())) as { obj: { counter: number } };
    assert.equal(second.obj.counter, counter, 'identical bridge snapshots must not rewrite state');
  });
});
