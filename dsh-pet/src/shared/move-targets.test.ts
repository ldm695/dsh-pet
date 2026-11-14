import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const { MoveTargets } = require('../../runtime/electron-helper/main/move-targets.cjs') as {
  MoveTargets: new () => {
    updateActual(id: string, point: { x: number; y: number; size: number }): boolean;
    begin(id: string, move: string, point: { x: number; y: number; size: number }, kind?: string): boolean;
    end(id: string, move: string, point: { x: number; y: number; size: number }): boolean;
    snapshot(): Array<{ petId: string; needsMove: boolean; blockers: string[]; moveId: string | null }>;
    remove(id: string): boolean;
  };
};

describe('多桌宠移动落点仲裁', () => {
  it('重叠的桌宠由后占位者让位，离开后解除让位状态', () => {
    const broker = new MoveTargets();
    broker.updateActual('pet-a', { x: 500, y: 300, size: 300 });
    broker.updateActual('pet-b', { x: 500, y: 300, size: 300 });
    let state = broker.snapshot();
    assert.equal(state.find((item) => item.petId === 'pet-a')?.needsMove, true);
    assert.equal(state.find((item) => item.petId === 'pet-b')?.needsMove, false);
    broker.begin('pet-a', 'move-1', { x: 100, y: 300, size: 300 }, 'yield');
    assert.equal(broker.end('pet-a', 'move-1', { x: 100, y: 300, size: 300 }), true);
    state = broker.snapshot();
    assert.equal(state.find((item) => item.petId === 'pet-a')?.needsMove, false);
  });

  it('过期移动回执不能结束更新后的移动，删除桌宠会刷新占位状态', () => {
    const broker = new MoveTargets();
    broker.updateActual('pet-a', { x: 500, y: 300, size: 300 });
    broker.begin('pet-a', 'move-new', { x: 800, y: 300, size: 300 });
    assert.equal(broker.end('pet-a', 'move-old', { x: 700, y: 300, size: 300 }), false);
    assert.equal(broker.snapshot()[0]?.moveId, 'move-new');
    assert.equal(broker.remove('pet-a'), true);
    assert.deepEqual(broker.snapshot(), []);
  });
});
