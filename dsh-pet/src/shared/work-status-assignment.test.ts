import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import {
  LEGACY_WORK_STATUS_AGENT_KEY,
  normalizeWorkStatusAgents,
  WorkStatusAssignmentManager,
} from './work-status-assignment.ts';
import type { WorkStatusAgentSnapshot, WorkStatusSnapshot } from './work-status.ts';

function agent(
  key: string,
  startedAt: number,
  overrides: Partial<WorkStatusAgentSnapshot> = {},
): WorkStatusAgentSnapshot {
  return {
    key,
    state: 'working',
    revision: 1,
    startedAt,
    ...overrides,
  };
}

describe('WorkStatusAssignmentManager', () => {
  test('randomly assigns distinct eligible pets and keeps existing ownership stable', () => {
    const manager = new WorkStatusAssignmentManager(() => 0);
    const first = manager.reconcile([agent('agent-a', 1), agent('agent-b', 2)], ['pet-1', 'pet-2']);
    assert.deepEqual(
      first.assignments.map(({ agentKey, petId }) => [agentKey, petId]),
      [
        ['agent-a', 'pet-1'],
        ['agent-b', 'pet-2'],
      ],
    );

    const second = manager.reconcile(
      [agent('agent-b', 2, { revision: 2 }), agent('agent-a', 1, { state: 'result', revision: 3 })],
      ['pet-2', 'pet-1'],
    );
    assert.deepEqual(
      second.assignments.map(({ agentKey, petId }) => [agentKey, petId]),
      [
        ['agent-a', 'pet-1'],
        ['agent-b', 'pet-2'],
      ],
    );
    assert.deepEqual(second.released, []);

    const unchanged = manager.reconcile(
      [agent('agent-a', 1, { state: 'result', revision: 3 }), agent('agent-b', 2, { revision: 2 })],
      ['pet-2', 'pet-1'],
    );
    assert.deepEqual(
      unchanged.assignments.map(({ agentKey, petId, assignmentRevision }) => [agentKey, petId, assignmentRevision]),
      second.assignments.map(({ agentKey, petId, assignmentRevision }) => [agentKey, petId, assignmentRevision]),
    );
  });

  test('uses Agent key as a deterministic tie-breaker for equal start times', () => {
    const manager = new WorkStatusAssignmentManager(() => 0);
    const result = manager.reconcile([agent('z-agent', 10), agent('a-agent', 10)], ['only-pet']);
    assert.deepEqual(
      result.assignments.map(({ agentKey }) => agentKey),
      ['a-agent'],
    );
  });

  test('leaves excess Agents pending and assigns a freed pet on the next snapshot', () => {
    const manager = new WorkStatusAssignmentManager(() => 0);
    const first = manager.reconcile([agent('agent-a', 1), agent('agent-b', 2)], ['pet-1']);
    assert.deepEqual(
      first.assignments.map(({ agentKey }) => agentKey),
      ['agent-a'],
    );

    const next = manager.reconcile([agent('agent-b', 2)], ['pet-1']);
    assert.deepEqual(
      next.released.map(({ agentKey, petId }) => [agentKey, petId]),
      [['agent-a', 'pet-1']],
    );
    assert.deepEqual(
      next.assignments.map(({ agentKey, petId }) => [agentKey, petId]),
      [['agent-b', 'pet-1']],
    );
    assert.ok(next.assignments[0].assignmentRevision > first.assignments[0].assignmentRevision);
  });

  test('releases an ineligible pet and reassigns its still-active Agent', () => {
    const manager = new WorkStatusAssignmentManager(() => 0);
    const first = manager.reconcile([agent('agent-a', 1)], ['pet-1', 'pet-2']);
    const next = manager.reconcile([agent('agent-a', 1)], ['pet-2']);

    assert.deepEqual(
      next.released.map(({ petId }) => petId),
      ['pet-1'],
    );
    assert.equal(next.assignments[0].petId, 'pet-2');
    assert.ok(next.assignments[0].assignmentRevision > first.assignments[0].assignmentRevision);
  });

  test('keeps terminal states assigned until the Agent leaves the snapshot', () => {
    const manager = new WorkStatusAssignmentManager(() => 0);
    const first = manager.reconcile([agent('agent-a', 1)], ['pet-1']);
    const terminal = manager.reconcile([agent('agent-a', 1, { state: 'success', revision: 2 })], ['pet-1']);
    assert.equal(terminal.assignments[0].petId, 'pet-1');
    assert.equal(terminal.assignments[0].assignmentRevision, first.assignments[0].assignmentRevision);

    const idle = manager.reconcile([], ['pet-1']);
    assert.deepEqual(idle.assignments, []);
    assert.deepEqual(
      idle.released.map(({ agentKey, petId }) => [agentKey, petId]),
      [['agent-a', 'pet-1']],
    );
  });

  test('increments assignment revision when a new Agent takes the same pet with identical visible state', () => {
    const manager = new WorkStatusAssignmentManager(() => 0);
    const previous = manager.reconcile([agent('agent-a', 1, { sourceName: 'Codex', revision: 4 })], ['pet-1']);
    const next = manager.reconcile([agent('agent-b', 2, { sourceName: 'Codex', revision: 4 })], ['pet-1']);

    assert.equal(next.assignments[0].petId, previous.assignments[0].petId);
    assert.ok(next.assignments[0].assignmentRevision > previous.assignments[0].assignmentRevision);
  });

  test('normalizes legacy snapshots and treats an explicit empty agents list as authoritative', () => {
    const legacy: WorkStatusSnapshot = { state: 'working', task: 'legacy task', sourceName: 'DSH' };
    assert.deepEqual(normalizeWorkStatusAgents(legacy, 19), [
      {
        key: LEGACY_WORK_STATUS_AGENT_KEY,
        state: 'working',
        sourceName: 'DSH',
        revision: 19,
        startedAt: 0,
      },
    ]);
    assert.deepEqual(normalizeWorkStatusAgents({ ...legacy, agents: [] }, 20), []);
    assert.deepEqual(normalizeWorkStatusAgents({ ...legacy, state: null }, 21), []);
  });

  test('the Electron shared-core bundle exposes the same assignment behavior as the browser source', () => {
    const source = readFileSync(new URL('../../runtime/electron-helper/shared-core.js', import.meta.url), 'utf8');
    const context = vm.createContext({});
    vm.runInContext(source, context);
    const bundledShared = context.PetShared as typeof import('./index.ts');
    assert.equal(typeof bundledShared.WorkStatusAssignmentManager, 'function');
    assert.equal(typeof bundledShared.normalizeWorkStatusAgents, 'function');

    const agents = [agent('agent-a', 1), agent('agent-b', 2)];
    const sourceResult = new WorkStatusAssignmentManager(() => 0).reconcile(agents, ['pet-1', 'pet-2']);
    const bundledResult = new bundledShared.WorkStatusAssignmentManager(() => 0).reconcile(agents, ['pet-1', 'pet-2']);
    assert.deepEqual(JSON.parse(JSON.stringify(bundledResult)), sourceResult);
  });
});
