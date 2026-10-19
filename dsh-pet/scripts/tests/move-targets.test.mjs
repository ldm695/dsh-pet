import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { MoveTargets } = require('../../runtime/electron-helper/move-targets.js');
const point = (x, y = 0, size = 100) => ({ x, y, size });
const byPet = (registry) => Object.fromEntries(registry.snapshot().map((target) => [target.petId, target]));

test('crossing paths and swapping places do not conflict when endpoints differ', () => {
  const registry = new MoveTargets();
  registry.updateActual('A', point(0));
  registry.updateActual('B', point(400));
  registry.begin('A', 'a', point(400));
  registry.begin('B', 'b', point(0));
  registry.updateActual('A', point(200));
  registry.updateActual('B', point(200));
  const state = byPet(registry);
  assert.equal(state.A.x, 400);
  assert.equal(state.B.x, 0);
  assert.equal(state.A.needsMove, false);
  assert.equal(state.B.needsMove, false);
});

test('A/B/C claiming the same endpoint mark A and B; arrival order does not change ownership', () => {
  const registry = new MoveTargets();
  registry.begin('A', 'a', point(100));
  registry.begin('B', 'b', point(100));
  registry.begin('C', 'c', point(100));
  assert.deepEqual(
    registry.snapshot().map((target) => [target.petId, target.needsMove]),
    [
      ['A', true],
      ['B', true],
      ['C', false],
    ],
  );
  registry.end('C', 'c', point(100));
  registry.end('B', 'b', point(100));
  registry.end('A', 'a', point(100));
  const state = byPet(registry);
  assert.equal(state.A.needsMove, true);
  assert.equal(state.B.needsMove, true);
  assert.equal(state.C.needsMove, false);
});

test('a later ordinary claim displaces an older stationary target and moving away clears O', () => {
  const registry = new MoveTargets();
  registry.updateActual('stationary', point(100));
  registry.begin('moving', '1', point(120));
  assert.equal(byPet(registry).stationary.needsMove, true);
  registry.begin('moving', '2', point(400));
  assert.equal(byPet(registry).stationary.needsMove, false);
});

test('an O relief move preserves priority and cannot transfer O while endpoints still overlap', () => {
  const registry = new MoveTargets();
  registry.begin('older', 'old', point(100));
  registry.begin('newer', 'new', point(100));
  const before = byPet(registry);
  assert.equal(before.older.needsMove, true);
  assert.equal(before.newer.needsMove, false);

  registry.begin('older', 'yield-1', point(120), 'yield');
  let state = byPet(registry);
  assert.equal(state.older.priority, before.older.priority);
  assert.equal(state.older.needsMove, true);
  assert.equal(state.newer.needsMove, false);
  registry.end('older', 'yield-1', point(120));
  state = byPet(registry);
  assert.equal(state.older.needsMove, true);
  assert.equal(state.newer.needsMove, false);

  registry.begin('older', 'yield-2', point(500), 'yield');
  state = byPet(registry);
  assert.equal(state.older.priority, before.older.priority);
  assert.equal(state.older.needsMove, false);
  assert.equal(state.newer.needsMove, false);
  assert.equal(state.older.moveKind, 'yield');
  registry.end('older', 'yield-2', point(500));
  assert.equal(byPet(registry).older.moveKind, 'claim');
});

test('a yielding move does not mark a peer even when its attempted endpoint overlaps that peer', () => {
  const registry = new MoveTargets();
  registry.begin('peer', 'peer', point(0));
  registry.begin('yielding', 'claim', point(500));
  registry.begin('blocker', 'blocker', point(500));
  assert.equal(byPet(registry).peer.needsMove, false);
  assert.equal(byPet(registry).yielding.needsMove, true);

  registry.begin('yielding', 'relief', point(0), 'yield');
  const state = byPet(registry);
  assert.equal(state.yielding.needsMove, true);
  assert.equal(state.peer.needsMove, false);
});

test('manual or normal movement from an O pet becomes a new claim', () => {
  const registry = new MoveTargets();
  registry.begin('A', 'a', point(100));
  registry.begin('B', 'b', point(100));
  const oldPriority = byPet(registry).A.priority;
  assert.equal(byPet(registry).A.needsMove, true);

  registry.begin('A', 'manual', point(100), 'claim');
  const state = byPet(registry);
  assert.ok(state.A.priority > oldPriority);
  assert.equal(state.A.needsMove, false);
  assert.equal(state.B.needsMove, true);
});

test('completion preserves the claim priority and stale completion is ignored', () => {
  const registry = new MoveTargets();
  registry.updateActual('B', point(400));
  registry.begin('A', 'old', point(400));
  const priority = byPet(registry).A.priority;
  assert.equal(byPet(registry).B.needsMove, true);
  assert.equal(registry.end('A', 'old', point(100)), true);
  assert.equal(byPet(registry).B.needsMove, false);
  registry.begin('A', 'new', point(700));
  assert.equal(registry.end('A', 'old', point(200)), false);
  assert.equal(byPet(registry).A.x, 700);
  assert.equal(byPet(registry).A.moveId, 'new');
  assert.ok(byPet(registry).A.priority > priority);
});

test('yield interruption restores actual position without changing priority or clearing unresolved O', () => {
  const registry = new MoveTargets();
  registry.begin('A', 'a', point(100));
  registry.begin('B', 'b', point(100));
  const priority = byPet(registry).A.priority;
  registry.begin('A', 'yield', point(400), 'yield');
  assert.equal(registry.end('A', 'yield', point(120)), true);
  const state = byPet(registry);
  assert.equal(state.A.x, 120);
  assert.equal(state.A.priority, priority);
  assert.equal(state.A.needsMove, true);
  assert.equal(state.B.needsMove, false);
});

test('a yielding pet clears O only after its expected endpoint is free and keeps its priority', () => {
  const registry = new MoveTargets();
  registry.begin('A', 'a', point(100));
  registry.begin('B', 'b', point(100));
  const priority = byPet(registry).A.priority;

  registry.begin('A', 'yield-free', point(700), 'yield');
  assert.equal(byPet(registry).A.needsMove, false);
  assert.equal(byPet(registry).A.priority, priority);
  registry.end('A', 'yield-free', point(700));

  const state = byPet(registry);
  assert.equal(state.A.needsMove, false);
  assert.equal(state.A.priority, priority);
  assert.equal(state.B.needsMove, false);
});

test('size calibration updates collision geometry without changing priority', () => {
  const registry = new MoveTargets();
  registry.updateActual('small', point(0, 0, 100));
  registry.updateActual('large', point(140, 0, 100));
  const before = byPet(registry);
  assert.equal(before.small.needsMove, false);
  registry.updateActual('large', point(140, 0, 700));
  const after = byPet(registry);
  assert.equal(after.large.priority, before.large.priority);
  assert.equal(after.small.needsMove, true);
});

test('drag/throw transit suspends occupancy and settling creates a fresh claim', () => {
  const registry = new MoveTargets();
  registry.updateActual('stationary', point(300));
  registry.updateActual('flying', point(0));
  const oldPriority = byPet(registry).flying.priority;
  registry.updateActual('flying', point(300), { freeMotion: true });
  assert.equal(byPet(registry).stationary.needsMove, false);
  assert.equal(byPet(registry).flying.suspended, true);
  registry.updateActual('flying', point(320), { freeMotion: true });
  registry.updateActual('flying', point(700));
  assert.equal(byPet(registry).flying.x, 700);
  assert.equal(byPet(registry).flying.suspended, false);
  assert.ok(byPet(registry).flying.priority > oldPriority);
  registry.updateActual('flying', point(305));
  assert.equal(byPet(registry).stationary.needsMove, true);
  const settledPriority = byPet(registry).flying.priority;
  registry.updateActual('flying', point(310));
  assert.equal(byPet(registry).flying.priority, settledPriority);
});

test('explicit position commands create new claims while routine position updates retain priority', () => {
  const registry = new MoveTargets();
  registry.updateActual('A', point(0));
  const initialPriority = byPet(registry).A.priority;
  registry.updateActual('A', point(50));
  assert.equal(byPet(registry).A.priority, initialPriority);
  registry.updateActual('A', point(75), { newClaim: true });
  assert.ok(byPet(registry).A.priority > initialPriority);
});

test('size-dependent endpoint overlap is identical at different display scales', () => {
  for (const scale of [1, 1.5, 2]) {
    const registry = new MoveTargets();
    registry.begin('small', 'a', point(0, 0, 320 * scale));
    registry.begin('large', 'b', point(161 * scale, 0, 544 * scale));
    assert.equal(byPet(registry).small.needsMove, true);
    registry.begin('large', 'c', point(163 * scale, 0, 544 * scale));
    assert.equal(byPet(registry).small.needsMove, false);
  }
});

test('removing a claimant clears markers and malformed coordinates cannot poison the registry', () => {
  const registry = new MoveTargets();
  registry.begin('A', 'a', point(100));
  registry.begin('B', 'b', point(100));
  assert.equal(registry.begin('C', 'c', point(NaN)), false);
  assert.equal(registry.begin('C', 'c', point(100, 0, 0)), false);
  assert.equal(registry.remove('B'), true);
  assert.equal(byPet(registry).A.needsMove, false);
  assert.equal(registry.snapshot().length, 1);
});
