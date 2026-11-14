import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { createWorkStatusAssignmentManager } =
  require('../../runtime/electron-helper/main/work-status-assignment.cjs') as {
    createWorkStatusAssignmentManager: () => {
      reconcile: (
        agents: Array<{ key: string; state: string; startedAt: number }>,
        eligiblePetIds: string[],
      ) => {
        assignments: Array<{ agentKey: string; petId: string; assignmentRevision: number }>;
        released: Array<{ agentKey: string; petId: string; assignmentRevision: number }>;
      };
    };
  };

test('work-status broker keeps an owner stable and assigns concurrent sources to separate pets', () => {
  const manager = createWorkStatusAssignmentManager();
  const agents = [
    { key: 'codex:client', state: 'working', startedAt: 10 },
    { key: 'claude:client', state: 'thinking', startedAt: 20 },
  ];
  const initial = manager.reconcile(agents, ['main', 'pet-2']);
  assert.equal(initial.assignments.length, 2);
  assert.notEqual(initial.assignments[0]?.petId, initial.assignments[1]?.petId);

  const updated = manager.reconcile(
    agents.map((agent) => ({ ...agent, state: 'result' })),
    ['main', 'pet-2'],
  );
  assert.deepEqual(
    updated.assignments.map(({ agentKey, petId, assignmentRevision }) => ({ agentKey, petId, assignmentRevision })),
    initial.assignments.map(({ agentKey, petId, assignmentRevision }) => ({ agentKey, petId, assignmentRevision })),
  );
});

test('work-status broker releases an ineligible pet and never assigns one pet to two sources', () => {
  const manager = createWorkStatusAssignmentManager();
  manager.reconcile(
    [
      { key: 'codex:client', state: 'working', startedAt: 10 },
      { key: 'claude:client', state: 'thinking', startedAt: 20 },
    ],
    ['main', 'pet-2'],
  );
  const result = manager.reconcile(
    [
      { key: 'codex:client', state: 'working', startedAt: 10 },
      { key: 'claude:client', state: 'thinking', startedAt: 20 },
      { key: 'dsh:client', state: 'result', startedAt: 30 },
    ],
    ['pet-2'],
  );
  assert.ok(result.released.some(({ petId }) => petId === 'main'));
  assert.equal(new Set(result.assignments.map(({ petId }) => petId)).size, result.assignments.length);
  assert.equal(result.assignments.length, 1);
});
