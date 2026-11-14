'use strict';

/**
 * 给每个工作来源稳定分配一只桌宠。该状态属于 Electron 主进程，所有独立窗口共用同一实例。
 */
function createWorkStatusAssignmentManager() {
  const owners = new Map();
  let revision = 0;
  let nextPetIndex = 0;

  function reconcile(agentsInput, eligibleInput) {
    const agents = new Map();
    for (const agent of Array.isArray(agentsInput) ? agentsInput : []) {
      if (!agent || typeof agent.key !== 'string' || !agent.key) continue;
      agents.set(agent.key, agent);
    }
    const eligible = [
      ...new Set((Array.isArray(eligibleInput) ? eligibleInput : []).filter((id) => typeof id === 'string' && id)),
    ];
    const eligibleSet = new Set(eligible);
    const released = [];

    for (const [agentKey, owner] of owners) {
      if (agents.has(agentKey) && eligibleSet.has(owner.petId)) continue;
      released.push({ agentKey, ...owner });
      owners.delete(agentKey);
    }

    const ordered = [...agents.values()].sort((a, b) => {
      const started = Number(a.startedAt) - Number(b.startedAt);
      return started || a.key.localeCompare(b.key);
    });
    const occupied = new Set([...owners.values()].map((owner) => owner.petId));
    for (const agent of ordered) {
      if (owners.has(agent.key)) continue;
      const available = eligible.filter((petId) => !occupied.has(petId));
      if (!available.length) break;
      const index = nextPetIndex % available.length;
      nextPetIndex += 1;
      const owner = { petId: available[index], assignmentRevision: ++revision };
      owners.set(agent.key, owner);
      occupied.add(owner.petId);
    }

    const assignments = [];
    for (const agent of ordered) {
      const owner = owners.get(agent.key);
      if (owner) assignments.push({ agentKey: agent.key, ...owner, agent });
    }
    return { assignments, released };
  }

  return { reconcile };
}

module.exports = { createWorkStatusAssignmentManager };
