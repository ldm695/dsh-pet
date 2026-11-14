'use strict';

const { HIT_BOX, CANVAS_H, STAGE_W, FEET_Y } = require('../pointer-target.js');

/** 多桌宠移动落点的进程级仲裁器；只管占位和让位，不接管各宠物的动画时钟。 */
class MoveTargets {
  constructor() {
    this.targets = new Map();
    this.sequence = 0;
  }

  valid(point) {
    return point && [point.x, point.y, point.size].every(Number.isFinite) && point.size > 0;
  }

  bodyRect(point) {
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
    const x = this.bodyRect(a);
    const y = this.bodyRect(b);
    return x.left < y.right && x.right > y.left && x.top < y.bottom && x.bottom > y.top;
  }

  updateActual(petId, point, options = {}) {
    if (!this.valid(point)) return false;
    const previous = this.targets.get(petId);
    if (previous?.moveId) return false;
    const freeMotion = options?.freeMotion === true;
    if (freeMotion && previous?.suspended) return false;
    if (
      !freeMotion &&
      previous &&
      !previous.suspended &&
      previous.x === point.x &&
      previous.y === point.y &&
      previous.size === point.size
    )
      return false;
    const claim = !previous || (previous.suspended && !freeMotion);
    const target = {
      ...previous,
      ...point,
      petId,
      priority: claim ? ++this.sequence : previous.priority,
      yielding: claim ? false : previous.yielding === true,
      moveId: null,
      moveKind: claim ? 'claim' : previous.moveKind || 'claim',
      suspended: freeMotion,
    };
    this.targets.set(petId, target);
    if (claim || target.moveKind !== 'yield') this.applyClaim(target);
    this.refreshYielding();
    return true;
  }

  begin(petId, moveId, point, kind = 'claim') {
    if (!moveId || !this.valid(point)) return false;
    const previous = this.targets.get(petId);
    const yielding = kind === 'yield';
    const target = {
      ...previous,
      ...point,
      petId,
      priority: yielding && previous ? previous.priority : ++this.sequence,
      yielding: yielding ? previous?.yielding !== false : false,
      moveId,
      moveKind: yielding ? 'yield' : 'claim',
      suspended: false,
    };
    this.targets.set(petId, target);
    if (!yielding) this.applyClaim(target);
    this.refreshYielding();
    return true;
  }

  end(petId, moveId, actual) {
    const previous = this.targets.get(petId);
    if (!previous || previous.moveId !== moveId || !this.valid(actual)) return false;
    const target = { ...previous, ...actual, moveId: null, suspended: false };
    this.targets.set(petId, target);
    if (target.moveKind === 'yield') {
      target.yielding = [...this.targets.values()].some(
        (other) => other.petId !== petId && !other.suspended && this.overlaps(target, other),
      );
    } else this.applyClaim(target);
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
      const overlapping = entries.some(
        (other) => other.petId !== target.petId && !other.suspended && this.overlaps(target, other),
      );
      if (!overlapping) {
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
