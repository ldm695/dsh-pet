import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMenuRoute } from './menu-route';
import { createExternalWorkStatusRoute } from './external-work-status-route';
import { createStateRoute } from './state-route';
import { PollStateStore } from './state';
import { WorkStatusStore } from './work-status';
import type { RouteRequest, RouteResult } from './route-contract';
import type { WorkStatusSnapshotWire } from '../shared/work-status';

type WorkPayload = { sections: { workStatus: { data: WorkStatusSnapshotWire } } };

const request = (rest: string, method = 'GET', payload?: unknown, query = ''): RouteRequest => ({
  rest,
  method,
  body: payload === undefined ? undefined : JSON.stringify(payload),
  query: new URLSearchParams(query),
});
function json<T = Record<string, unknown>>(result: RouteResult | undefined): T {
  assert.ok(result && result.kind === 'json');
  return result.obj as T;
}

test('第三方菜单注册、点击消费和注销均通过现有状态通道生效', async () => {
  const state = new PollStateStore();
  const route = createMenuRoute((name, data) => state.writeSection(name, data));
  assert.deepEqual(json(await route(request('menu/item', 'POST', { owner: '游戏', labels: ['弹弓', '钓鱼'] }))), {
    ok: true,
  });
  assert.deepEqual(state.read().sections.menu.data, {
    items: [
      { owner: '游戏', label: '弹弓' },
      { owner: '游戏', label: '钓鱼' },
    ],
  });
  const pending = route(request('menu/events', 'GET', undefined, 'owner=游戏&wait=5000'));
  assert.deepEqual(json(await route(request('menu/click', 'POST', { owner: '游戏', label: '弹弓', pet: 'pet.one' }))), {
    ok: true,
    delivered: true,
  });
  assert.deepEqual(json(await pending), { ok: true, events: { 弹弓: 'pet.one', 钓鱼: null } });
  assert.deepEqual(json(await route(request('menu/events', 'GET', undefined, 'owner=游戏'))), {
    ok: true,
    events: { 弹弓: null, 钓鱼: null },
  });
  await route(request('menu/item', 'DELETE', undefined, 'owner=游戏'));
  assert.deepEqual(state.read().sections.menu.data, { items: [] });
  assert.equal(json(await route(request('menu/events', 'GET', undefined, 'owner=游戏'))).reason, 'unknown-owner');
});

test('外部工作状态在独立模式的重复桥接轮询后保留，并可显式清除', async () => {
  const state = new PollStateStore();
  const work = new WorkStatusStore();
  const external = createExternalWorkStatusRoute(work, () => {});
  const route = createStateRoute({
    state,
    isStandalone: () => true,
    bridgePaths: { dsh: '', codex: '', claude: '' },
    externalWorkSnapshot: external.snapshot,
  });
  await external.handle(request('work-status', 'POST', { state: 'working', task: '构建' }));
  for (let i = 0; i < 2; i++) {
    const payload = json<WorkPayload>(await route(request('state'))).sections.workStatus.data;
    assert.equal(payload.state, 'working');
    assert.equal(payload.task, '构建');
    assert.equal(payload.agents?.[0].key, 'api:client');
  }
  await external.handle(request('work-status', 'POST', { state: 'result' }));
  assert.equal(json<WorkPayload>(await route(request('state'))).sections.workStatus.data.task, '构建');
  assert.deepEqual(await external.handle(request('work-status', 'DELETE')), { kind: 'text', status: 204, body: '' });
  const cleared = json<WorkPayload>(await route(request('state'))).sections.workStatus.data;
  assert.equal(cleared.state, null);
  assert.deepEqual(cleared.agents, []);
});
