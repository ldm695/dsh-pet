'use strict';

/**
 * IPC contract for renderer/main-process endpoint coordination.
 * Coordinates and sizes are screen pixels; points describe the pet's visual center.
 * The channel strings are intentionally stable for compatibility with existing preload clients.
 *
 * @typedef {{ x: number, y: number, size: number }} MovePoint
 * @typedef {'claim' | 'yield'} MoveKind
 * @typedef {{ petId: string, moveId: string, x: number, y: number, size: number, kind: MoveKind, reason: string }} BeginMovePayload
 * @typedef {{ petId: string, moveId: string, x: number, y: number, size: number, reason?: string }} EndMovePayload
 * @typedef {{ petId: string }} ForgetMoveTargetPayload
 * @typedef {{ petId: string, x: number, y: number, size: number, priority: number, yielding: boolean, moveId: string | null, moveKind: MoveKind, suspended: boolean, needsMove: boolean, blockers: string[] }} MoveTarget
 * @typedef {MoveTarget[]} MoveTargetSnapshot
 */

const MOVE_TARGETS_CHANNELS = Object.freeze({
  begin: 'pet:begin-move',
  end: 'pet:end-move',
  snapshot: 'pet:move-targets',
  forget: 'pet:forget-move-target',
});

const ALLOWED_BEGIN_REASONS = new Set([
  'overlap-yield',
  'manual-movement',
  'automatic-movement',
  'position-command',
]);

/**
 * Register the main-process endpoint-coordination handlers.
 * This module owns the IPC boundary only; MoveTargets remains the policy owner.
 */
function registerMoveTargetHandlers({
  ipcMain,
  BrowserWindow,
  windows,
  moveTargets,
  traceMoveTarget,
  broadcastMoveTargets,
}) {
  ipcMain.on(MOVE_TARGETS_CHANNELS.begin, (event, payload) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const petId = String(payload?.petId || '');
    const moveId = String(payload?.moveId || '');
    if (!win || win.isDestroyed() || !petId || windows.get(petId) !== win) return;
    const point = { x: Number(payload?.x), y: Number(payload?.y), size: Number(payload?.size) };
    const kind = payload?.kind === 'yield' ? 'yield' : 'claim';
    const reason = ALLOWED_BEGIN_REASONS.has(payload?.reason)
      ? payload.reason
      : kind === 'yield'
        ? 'overlap-yield'
        : 'movement-start';
    const previousPriority = moveTargets.targets.get(petId)?.priority ?? null;
    if (!moveTargets.begin(petId, moveId, point, kind)) return;
    const target = moveTargets.targets.get(petId);
    // TEMPORARY MOVE DIAGNOSTICS: keep this event covered by release cleanup notes.
    traceMoveTarget('begin', {
      petId,
      moveId,
      kind,
      reason,
      priority: target.priority,
      ...point,
    });
    if (target.priority !== previousPriority) {
      traceMoveTarget('claim-priority', {
        petId,
        from: previousPriority,
        to: target.priority,
        kind,
        reason,
      });
    }
    broadcastMoveTargets();
  });

  ipcMain.on(MOVE_TARGETS_CHANNELS.end, (event, payload) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const petId = String(payload?.petId || '');
    const moveId = String(payload?.moveId || '');
    if (!win || win.isDestroyed() || !petId || windows.get(petId) !== win) return;
    const point = { x: Number(payload?.x), y: Number(payload?.y), size: Number(payload?.size) };
    const completedKind = moveTargets.targets.get(petId)?.moveKind;
    if (!moveTargets.end(petId, moveId, point)) return;
    const target = moveTargets.targets.get(petId);
    // TEMPORARY MOVE DIAGNOSTICS: keep this event covered by release cleanup notes.
    traceMoveTarget('end', {
      petId,
      moveId,
      reason: payload?.reason,
      kind: completedKind,
      priority: target?.priority,
      needsMove: target?.yielding === true,
      ...point,
    });
    broadcastMoveTargets();
  });

  ipcMain.on(MOVE_TARGETS_CHANNELS.forget, (event, payload) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const petId = String(payload?.petId || '');
    if (!win || win.isDestroyed() || windows.get(petId) !== win) return;
    if (moveTargets.remove(petId)) {
      // TEMPORARY MOVE DIAGNOSTICS: remove this record before a formal release.
      traceMoveTarget('remove-target', { petId, reason: 'renderer-forgot-target' });
      broadcastMoveTargets();
    }
  });
}

module.exports = { MOVE_TARGETS_CHANNELS, registerMoveTargetHandlers };
