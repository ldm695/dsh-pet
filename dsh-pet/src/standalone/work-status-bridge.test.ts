import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { createStandaloneWorkStatusBridge } from './work-status-bridge.ts';

const roots: string[] = [];
after(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-pet-work-bridge-'));
  roots.push(home);
  return home;
}

function writeBridge(home: string, filename: string, payload: unknown): void {
  const directory = join(home, 'dsh-pet');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, filename), JSON.stringify(payload), 'utf8');
}

test('独立状态桥接按来源选取一个活动 agent，并稳定推进修订号', () => {
  const home = makeHome();
  const now = Date.now();
  writeBridge(home, 'codex-work-status-bridge.json', {
    version: 2,
    updatedAt: now,
    agents: [
      { key: 'older', state: 'success', revision: 1, startedAt: now - 200, eventAt: now - 20 },
      { key: 'newer', state: 'working', revision: 2, startedAt: now - 100, eventAt: now },
    ],
  });
  const bridge = createStandaloneWorkStatusBridge(home);
  const first = bridge.readAgents();
  const second = bridge.readAgents();
  assert.equal(first.length, 1);
  assert.equal(first[0]?.key, 'codex:client');
  assert.equal(first[0]?.state, 'working');
  assert.equal(first[0]?.sourceName, 'Codex');
  assert.equal(second[0]?.revision, first[0]?.revision);
});

test('独立状态桥接忽略过期与不兼容文件', () => {
  const home = makeHome();
  const warnings: string[] = [];
  const now = Date.now();
  writeBridge(home, 'codex-work-status-bridge.json', {
    version: 1,
    updatedAt: now,
    agents: [{ key: 'old', state: 'working', revision: 1, startedAt: now }],
  });
  writeBridge(home, 'claude-code-work-status-bridge.json', {
    version: 2,
    updatedAt: now - 5000,
    agents: [{ key: 'stale', state: 'working', revision: 1, startedAt: now - 5000 }],
  });
  const bridge = createStandaloneWorkStatusBridge(home, (warning) => warnings.push(warning));
  assert.deepEqual(bridge.readAgents(), []);
  assert.equal(warnings.length, 1);
  bridge.readAgents();
  assert.equal(warnings.length, 1);
});

test('DSH 通知使用唯一修订并且只交付一次', () => {
  const home = makeHome();
  const now = Date.now();
  writeBridge(home, 'work-status-bridge.json', {
    version: 2,
    updatedAt: now,
    agents: [],
    notification: {
      revision: 4,
      createdAt: now,
      title: '对话完成',
      body: '完成',
      icon: 'unknown-icon',
      sourceForeground: false,
    },
  });
  const bridge = createStandaloneWorkStatusBridge(home);
  bridge.readAgents();
  assert.deepEqual(bridge.takeNotification(), {
    revision: `${now}:4`,
    title: '对话完成',
    body: '完成',
    icon: 'notify-done',
    sourceForeground: false,
  });
  assert.equal(bridge.takeNotification(), undefined);
  bridge.readAgents();
  assert.equal(bridge.takeNotification(), undefined);
});
