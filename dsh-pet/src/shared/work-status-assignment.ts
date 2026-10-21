import type { WorkStatusAgentSnapshot } from './work-status';

export interface WorkStatusPetAssignment {
  agentKey: string;
  petId: string;
  agent: WorkStatusAgentSnapshot;
  /** Changes whenever ownership is newly established, even when the visible status is identical. */
  assignmentRevision: number;
}

export interface ReleasedWorkStatusAssignment {
  agentKey: string;
  petId: string;
  assignmentRevision: number;
}

export interface WorkStatusAssignmentResult {
  assignments: WorkStatusPetAssignment[];
  released: ReleasedWorkStatusAssignment[];
}

interface AssignmentOwner {
  petId: string;
  assignmentRevision: number;
}

/**
 * Stateful per-renderer assignment policy shared by the web and Electron adapters.
 * The adapters provide only pets that are visible in that renderer and have work-status enabled.
 */
export class WorkStatusAssignmentManager {
  declare private readonly owners: Map<string, AssignmentOwner>;
  declare private assignmentRevision: number;
  declare private readonly random: () => number;

  constructor(random: () => number = Math.random) {
    this.owners = new Map();
    this.assignmentRevision = 0;
    this.random = random;
  }

  reconcile(agents: readonly WorkStatusAgentSnapshot[], eligiblePetIds: readonly string[]): WorkStatusAssignmentResult {
    const currentByKey = new Map<string, WorkStatusAgentSnapshot>();
    for (const agent of agents) {
      if (!agent || typeof agent.key !== 'string' || agent.key.length === 0) continue;
      // Match the old Map-based consumers: if malformed input repeats a key, its last entry wins.
      currentByKey.set(agent.key, agent);
    }

    const eligible = [...new Set(eligiblePetIds.filter((petId) => typeof petId === 'string' && petId.length > 0))];
    const eligibleSet = new Set(eligible);
    const released: ReleasedWorkStatusAssignment[] = [];

    for (const [agentKey, owner] of this.owners) {
      if (currentByKey.has(agentKey) && eligibleSet.has(owner.petId)) continue;
      released.push({ agentKey, ...owner });
      this.owners.delete(agentKey);
    }

    const orderedAgents = [...currentByKey.values()].sort((a, b) => {
      const byStart = a.startedAt - b.startedAt;
      if (byStart !== 0) return byStart;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });
    const occupied = new Set([...this.owners.values()].map((owner) => owner.petId));

    for (const agent of orderedAgents) {
      if (this.owners.has(agent.key)) continue;
      const available = eligible.filter((petId) => !occupied.has(petId));
      if (available.length === 0) break;

      const roll = this.random();
      const normalizedRoll = Number.isFinite(roll) ? Math.max(0, Math.min(roll, 1)) : 0;
      const index = Math.min(available.length - 1, Math.floor(normalizedRoll * available.length));
      const owner = {
        petId: available[index],
        assignmentRevision: ++this.assignmentRevision,
      };
      this.owners.set(agent.key, owner);
      occupied.add(owner.petId);
    }

    const assignments: WorkStatusPetAssignment[] = [];
    for (const agent of orderedAgents) {
      const owner = this.owners.get(agent.key);
      if (!owner) continue; // No free pet yet; the agent remains pending in the next snapshot.
      assignments.push({
        agentKey: agent.key,
        petId: owner.petId,
        agent,
        assignmentRevision: owner.assignmentRevision,
      });
    }

    return { assignments, released };
  }
}
