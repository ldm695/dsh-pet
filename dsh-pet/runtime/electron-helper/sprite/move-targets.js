/**
 * 多桌宠落点协调：消费主进程的占位快照，并在需要让位时选择更空旷的合法路线。
 *
 * PetSprite 由 sprite.js 定义；本模块只扩展其移动目标行为。
 * @module dsh-pet/runtime/electron-helper/sprite-move-targets
 */
'use strict';

Object.assign(PetSprite.prototype, {
  updateMoveTargets(targets) {
    this.moveTargets = Array.isArray(targets) ? targets : [];
    const own = this.moveTargets.find((target) => target.petId === this.pet.id);
    this.needsRelocation = own?.needsMove === true;
    if (own) this.expectedFinalPosition = { x: own.x, y: own.y, size: own.size };
    if (!this.canRelocate()) return;

    // 普通循环动画播完后再重新选动作，才能在下一次动画决策点执行让位。
    // 工作状态和用户正在操作的窗口保留原有生命周期，不被占位协调抢占。
    const el = this.front === 0 ? this.videoA : this.videoB;
    if (el?.loop) {
      el.loop = false;
      el.onended = () => this.handleEnded();
    }
  },

  canRelocate() {
    const working = this.workState && this.workState !== 'success' && this.workState !== 'error';
    return Boolean(
      this.needsRelocation &&
        !working &&
        !this.inputBusy() &&
        !this.pendingMove &&
        this.moveRef === null &&
        this.throwRef === null &&
        this.posFollow === null,
    );
  },

  beginMoveTarget(x, y, kind = 'claim', reason = kind === 'yield' ? 'overlap-yield' : 'movement') {
    const moveId = String((window.__dshPetMoveSequence = (window.__dshPetMoveSequence || 0) + 1));
    this.moveTargetId = moveId;
    this.expectedFinalPosition = { x: toScreen(x), y: toScreen(y), size: toScreen(this.size) };
    if (kind !== 'yield') this.needsRelocation = false;
    window.petBridge?.moveTargets?.begin?.(this.pet.id, moveId, this.expectedFinalPosition, kind, reason);
  },

  finishMoveTarget(reason) {
    if (!this.moveTargetId) return;
    const moveId = this.moveTargetId;
    this.moveTargetId = null;
    const actual = {
      x: toScreen(this.pos.x + this.halfW),
      y: toScreen(this.pos.y + this.halfH),
      size: toScreen(this.size),
    };
    this.expectedFinalPosition = actual;
    window.petBridge?.moveTargets?.end?.(this.pet.id, moveId, actual, reason);
  },

  endpointClearance(candidate) {
    const height = this.size * (9 / 16);
    const point = {
      x: toScreen(candidate.targetRatio * VIEW.w),
      y: toScreen(candidate.targetYRatio * VIEW.h),
      size: toScreen(this.size),
    };
    const own = this.endpointBodyRect(point);
    let clearance = Infinity;
    for (const other of this.moveTargets) {
      if (other.petId === this.pet.id || other.suspended) continue;
      const peer = this.endpointBodyRect(other);
      const gapX = Math.max(peer.left - own.right, own.left - peer.right, 0);
      const gapY = Math.max(peer.top - own.bottom, own.top - peer.bottom, 0);
      const distance = gapX > 0 || gapY > 0
        ? Math.hypot(gapX, gapY)
        : -Math.min(own.right - peer.left, peer.right - own.left, own.bottom - peer.top, peer.bottom - own.top);
      clearance = Math.min(clearance, distance);
    }
    return Number.isFinite(clearance) ? clearance : height;
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
});
