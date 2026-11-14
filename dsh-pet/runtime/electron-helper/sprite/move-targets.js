/** 多桌宠的落点占位和让位动作；协调决策由 Helper 主进程集中维护。 */
'use strict';

Object.assign(PetSprite.prototype, {
  updateMoveTargets(targets) {
    this.moveTargets = Array.isArray(targets) ? targets : [];
    const own = this.moveTargets.find((target) => target.petId === this.pet.id);
    this.needsRelocation = own?.needsMove === true;
    this.expectedFinalPosition = own ? { x: own.x, y: own.y, size: own.size } : null;
    if (!this.needsRelocation || this.pet.fixedEnabled === true || this.frozen || this.sleeping || this.inputBusy())
      return;
    const working = this.workState && this.workState !== 'success' && this.workState !== 'error';
    if (working || this.moveRef !== null || this.pendingMove || this.throwRef !== null || this.posFollow !== null)
      return;
    const active = this.front === 0 ? this.videoA : this.videoB;
    if (active?.loop) {
      active.loop = false;
      active.onended = () => this.handleEnded();
    }
  },

  beginMoveTarget(targetRatio, targetYRatio, kind = 'claim') {
    const moveId = String((window.__dshPetMoveSequence = (window.__dshPetMoveSequence || 0) + 1));
    this.moveTargetId = moveId;
    const target = {
      x: toScreen(targetRatio * VIEW.w),
      y: toScreen(targetYRatio * VIEW.h),
      size: toScreen(this.size),
    };
    this.expectedFinalPosition = target;
    if (kind !== 'yield') this.needsRelocation = false;
    window.petBridge?.moveTargets?.begin?.(this.pet.id, moveId, target, kind);
  },

  finishMoveTarget() {
    if (!this.moveTargetId) return;
    const moveId = this.moveTargetId;
    this.moveTargetId = null;
    const actual = {
      x: toScreen(this.pos.x + this.halfW),
      y: toScreen(this.pos.y + this.halfH),
      size: toScreen(this.size),
    };
    this.expectedFinalPosition = actual;
    window.petBridge?.moveTargets?.end?.(this.pet.id, moveId, actual);
  },

  endpointBodyRect(point) {
    const height = (point.size * 9) / 16;
    return S.bodyPixelBox({
      x: point.x - point.size / 2,
      y: point.y - height / 2,
      size: point.size,
      bottomPad: (height * (S.CANVAS_H - S.FEET_Y)) / S.CANVAS_H,
    });
  },

  endpointClearance(candidate) {
    const point = {
      x: toScreen(candidate.targetRatio * VIEW.w),
      y: toScreen(candidate.targetYRatio * VIEW.h),
      size: toScreen(this.size),
    };
    const own = this.endpointBodyRect(point);
    let clearance = Infinity;
    for (const other of this.moveTargets || []) {
      if (other.petId === this.pet.id || other.suspended) continue;
      const peer = this.endpointBodyRect(other);
      const gapX = Math.max(peer.left - own.right, own.left - peer.right, 0);
      const gapY = Math.max(peer.top - own.bottom, own.top - peer.bottom, 0);
      const distance =
        gapX || gapY
          ? Math.hypot(gapX, gapY)
          : -Math.min(own.right - peer.left, peer.right - own.left, own.bottom - peer.top, peer.bottom - own.top);
      clearance = Math.min(clearance, distance);
    }
    return Number.isFinite(clearance) ? clearance : point.size;
  },
});
