'use strict';

const { HIT_BOX, CANVAS_H, STAGE_W, FEET_Y } = require('./pet-geometry.js');

// Expected endpoints use the same screen coordinate system and size as pet:set-bounds.
// Occupancy uses the physics HIT_BOX body rectangle; crossing another pet's route is allowed.
class MoveTargets {
  constructor() {
    this.targets = new Map();
    this.sequence = 0;
  }

  valid(point) {
    return point && [point.x, point.y, point.size].every(Number.isFinite) && point.size > 0;
  }

  bodyRect(point) {
    // Move target points store the pet's visual center. Convert that center to the
    // same body box used by physics.ts: root bounds plus the stage's bottom padding.
    const height = (point.size * CANVAS_H) / STAGE_W;
    const rootX = point.x - point.size / 2;
    const rootY = point.y - height / 2;
    const bottomPad = (height * (CANVAS_H - FEET_Y)) / CANVAS_H;
    return {
      left: rootX + (HIT_BOX.x0 / STAGE_W) * point.size,
      top: rootY + bottomPad + (HIT_BOX.y0 / CANVAS_H) * height,
      right: rootX + (HIT_BOX.x1 / STAGE_W) * point.size,
      bottom: rootY + bottomPad + (HIT_BOX.y1 / CANVAS_H) * height,
    };
  }

  overlaps(a, b) {
    const bodyA = this.bodyRect(a);
    const bodyB = this.bodyRect(b);
    // Match physics.ts rectsOverlap: touching edges do not count as a collision.
    return (
      bodyA.left < bodyB.right &&
      bodyA.right > bodyB.left &&
      bodyA.top < bodyB.bottom &&
      bodyA.bottom > bodyB.top
    );
  }

  updateActual(petId, point, options = {}) {
    if (!this.valid(point)) return false;
    const previous = this.targets.get(petId);
    if (previous?.moveId) return false;

    // Preserve the old boolean argument for internal callers/tests while exposing
    // explicit claim intent for direct repositioning and settled free motion.
    const opts = typeof options === 'boolean' ? { freeMotion: options } : options || {};
    const freeMotion = opts.freeMotion === true;
    if (freeMotion && previous?.suspended) return false;
    if (
      !freeMotion &&
      previous &&
      !previous.suspended &&
      previous.x === point.x &&
      previous.y === point.y &&
      previous.size === point.size &&
      opts.newClaim !== true
    )
      return false;

    const newClaim = !previous || opts.newClaim === true || (previous.suspended && !freeMotion);
    const target = {
      ...previous,
      ...point,
      petId,
      priority: newClaim ? ++this.sequence : previous.priority,
      yielding: newClaim ? false : previous?.yielding === true,
      moveId: null,
      moveKind: newClaim ? 'claim' : previous?.moveKind || 'claim',
      suspended: freeMotion,
    };
    this.targets.set(petId, target);
    if (newClaim || target.moveKind !== 'yield') this.applyClaim(target);
    this.refreshYielding();
    return true;
  }

  begin(petId, moveId, point, kind = 'claim') {
    if (!moveId || !this.valid(point)) return false;
    const previous = this.targets.get(petId);
    const yieldingMove = kind === 'yield';
    const target = {
      ...previous,
      ...point,
      petId,
      priority: yieldingMove && previous ? previous.priority : ++this.sequence,
      // A yielding move keeps its O lease until its expected endpoint is clear.
      yielding: yieldingMove ? previous?.yielding !== false : false,
      moveId,
      moveKind: yieldingMove ? 'yield' : 'claim',
      suspended: false,
    };
    this.targets.set(petId, target);
    if (!yieldingMove) this.applyClaim(target);
    this.refreshYielding();
    return true;
  }

  end(petId, moveId, actual) {
    const previous = this.targets.get(petId);
    // A late cancellation/completion must not release a newer movement by the same pet.
    if (!previous || !moveId || previous.moveId !== moveId || !this.valid(actual)) return false;
    const target = { ...previous, ...actual, moveId: null, suspended: false };
    this.targets.set(petId, target);
    // Completion never changes priority. Ordinary claims re-evaluate their actual
    // stopping point; a yielding move must not transfer its O to another pet.
    if (target.moveKind === 'yield') {
      if (
        [...this.targets.values()].some(
          (other) => other.petId !== petId && !other.suspended && this.overlaps(target, other),
        )
      ) {
        target.yielding = true;
      }
    } else {
      this.applyClaim(target);
    }
    this.refreshYielding();
    return true;
  }

  remove(petId) {
    const removed = this.targets.delete(petId);
    if (removed) this.refreshYielding();
    return removed;
  }

  applyClaim(claimant) {
    if (!claimant || claimant.suspended) return;
    for (const other of this.targets.values()) {
      if (other.petId === claimant.petId || other.suspended || !this.overlaps(claimant, other)) continue;
      if (other.priority < claimant.priority) other.yielding = true;
      else if (other.priority > claimant.priority) claimant.yielding = true;
    }
  }

  refreshYielding() {
    const entries = [...this.targets.values()];
    for (const target of entries) {
      if (target.suspended) continue;
      if (!target.yielding) {
        if (!target.moveId && target.moveKind === 'yield') target.moveKind = 'claim';
        continue;
      }
      const stillOverlaps = entries.some(
        (other) => other.petId !== target.petId && !other.suspended && this.overlaps(target, other),
      );
      if (!stillOverlaps) {
        target.yielding = false;
        if (!target.moveId && target.moveKind === 'yield') target.moveKind = 'claim';
      }
    }
  }

  snapshot() {
    this.refreshYielding();
    const entries = [...this.targets.values()];
    return entries.map((target) => {
      const overlaps = entries.filter(
        (other) =>
          other.petId !== target.petId && !other.suspended && !target.suspended && this.overlaps(target, other),
      );
      const blockers = target.yielding
        ? overlaps.map((other) => other.petId)
        : overlaps.filter((other) => other.priority > target.priority).map((other) => other.petId);
      return { ...target, needsMove: !target.suspended && target.yielding, blockers };
    });
  }
}

module.exports = { MoveTargets };
