import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readMenuItems } from './menu';

test('第三方菜单按当前端筛选，旧快照与非法 target 默认两端显示', () => {
  const data = {
    items: [
      { owner: 'web-only', label: '网页', target: 'web' },
      { owner: 'desktop-only', label: '桌面', target: 'desktop' },
      { owner: 'shared', label: '共用', target: 'both' },
      { owner: 'legacy', label: '旧项' },
      { owner: 'invalid', label: '坏值', target: 'mobile' },
    ],
  };

  assert.deepEqual(readMenuItems(data, 'desktop'), [
    { owner: 'desktop-only', label: '桌面' },
    { owner: 'shared', label: '共用' },
    { owner: 'legacy', label: '旧项' },
    { owner: 'invalid', label: '坏值' },
  ]);
  assert.deepEqual(readMenuItems(data, 'web'), [
    { owner: 'web-only', label: '网页' },
    { owner: 'shared', label: '共用' },
    { owner: 'legacy', label: '旧项' },
    { owner: 'invalid', label: '坏值' },
  ]);
});
