'use strict';

/**
 * IPC contract for renderer/main-process endpoint coordination.
 * Coordinates and sizes are screen pixels; points describe the pet's visual center.
 * The channel names define the current preload/main-process contract.
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

/**
 * Register the main-process endpoint-coordination handlers.
 * This module owns the IPC boundary only; MoveTargets remains the policy owner.
 */
function registerMoveTargetHandlers({ ipcMain, BrowserWindow, windows, moveTargets, broadcastMoveTargets }) {
  ipcMain.on(MOVE_TARGETS_CHANNELS.begin, (event, payload) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const petId = String(payload?.petId || '');
    const moveId = String(payload?.moveId || '');
    if (!win || win.isDestroyed() || !petId || windows.get(petId) !== win) return;
    const point = { x: Number(payload?.x), y: Number(payload?.y), size: Number(payload?.size) };
    const kind = payload?.kind === 'yield' ? 'yield' : 'claim';
    if (!moveTargets.begin(petId, moveId, point, kind)) return;
    broadcastMoveTargets();
  });

  ipcMain.on(MOVE_TARGETS_CHANNELS.end, (event, payload) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const petId = String(payload?.petId || '');
    const moveId = String(payload?.moveId || '');
    if (!win || win.isDestroyed() || !petId || windows.get(petId) !== win) return;
    const point = { x: Number(payload?.x), y: Number(payload?.y), size: Number(payload?.size) };
    if (!moveTargets.end(petId, moveId, point)) return;
    broadcastMoveTargets();
  });

  ipcMain.on(MOVE_TARGETS_CHANNELS.forget, (event, payload) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const petId = String(payload?.petId || '');
    if (!win || win.isDestroyed() || windows.get(petId) !== win) return;
    if (moveTargets.remove(petId)) {
      broadcastMoveTargets();
    }
  });
}

module.exports = { MOVE_TARGETS_CHANNELS, registerMoveTargetHandlers };
