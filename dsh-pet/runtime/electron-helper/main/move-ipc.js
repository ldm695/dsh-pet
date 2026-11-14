'use strict';

const CHANNELS = Object.freeze({
  begin: 'pet:begin-move',
  end: 'pet:end-move',
  snapshot: 'pet:move-targets',
  requestSnapshot: 'pet:request-move-targets',
  forget: 'pet:forget-move-target',
});

/** 主进程只接受与发送窗口绑定的宠物 ID，协调策略留在 MoveTargets。 */
function registerMoveTargetHandlers({ ipcMain, BrowserWindow, windows, moveTargets, broadcastMoveTargets }) {
  ipcMain.on(CHANNELS.requestSnapshot, (event) => event.sender.send(CHANNELS.snapshot, moveTargets.snapshot()));
  ipcMain.on(CHANNELS.begin, (event, payload) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const petId = String(payload?.petId || '');
    const moveId = String(payload?.moveId || '');
    if (!win || win.isDestroyed() || windows.get(petId) !== win) return;
    const point = { x: Number(payload?.x), y: Number(payload?.y), size: Number(payload?.size) };
    if (moveTargets.begin(petId, moveId, point, payload?.kind === 'yield' ? 'yield' : 'claim')) broadcastMoveTargets();
  });
  ipcMain.on(CHANNELS.end, (event, payload) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const petId = String(payload?.petId || '');
    const moveId = String(payload?.moveId || '');
    if (!win || win.isDestroyed() || windows.get(petId) !== win) return;
    const point = { x: Number(payload?.x), y: Number(payload?.y), size: Number(payload?.size) };
    if (moveTargets.end(petId, moveId, point)) broadcastMoveTargets();
  });
  ipcMain.on(CHANNELS.forget, (event, payload) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const petId = String(payload?.petId || '');
    if (!win || win.isDestroyed() || windows.get(petId) !== win) return;
    if (moveTargets.remove(petId)) broadcastMoveTargets();
  });
}

module.exports = { CHANNELS, registerMoveTargetHandlers };
