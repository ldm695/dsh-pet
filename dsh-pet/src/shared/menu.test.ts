import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMenuTree, readMenuItems } from './menu';
import type { Animations } from './types';

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

test('事件动画配置中的过期槽位不会阻止动作菜单生成', () => {
  const animations = {
    idle: ['待机'],
    turn: [],
    drag: [],
    clicks: [],
    moves: { actions: [] },
    categories: [],
    events: {
      balance: ['余额成功', ['余额档位一', '余额档位二'], { legacy: true }, null, [1, '有效候选']],
    },
  } as unknown as Animations;

  assert.deepEqual(buildMenuTree(animations), [
    {
      label: '动作',
      children: [
        { label: '待机', children: [{ label: '待机', anim: '待机' }] },
        {
          label: '余额档位',
          children: [
            { label: '余额成功', anim: '余额成功' },
            { label: '余额档位一', anim: '余额档位一' },
            { label: '余额档位二', anim: '余额档位二' },
            { label: '有效候选', anim: '有效候选' },
          ],
        },
      ],
    },
  ]);
});
