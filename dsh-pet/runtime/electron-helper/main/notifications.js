'use strict';

const path = require('node:path');
const { createNotificationRevisionGate } = require('../notification-revisions.js');

/**
 * 桌面系统通知只由 Helper 主进程发送，防止每只独立桌宠窗口重复弹出同一条 DSH 通知。
 */
function registerDshNotificationIpc({ ipcMain, BrowserWindow, Notification, petWindows, helperDir }) {
  const revisions = createNotificationRevisionGate();
  const iconNames = new Set([
    'notify-done',
    'notify-error',
    'notify-truncated',
    'notify-approval',
    'notify-question',
    'notify-test',
  ]);

  ipcMain.on('pet:dsh-notification', (event, payload) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const isPetWindow = [...petWindows.state.windows.values()].includes(win);
    const isNotificationWorker = petWindows.state.notificationWindow === win;
    const data = payload?.data;
    if (
      (!isPetWindow && !isNotificationWorker) ||
      !data ||
      data.type !== 'standalone' ||
      data.source !== 'dsh' ||
      data.sourceForeground === true ||
      (win.isFocused() && win.isVisible()) ||
      !Notification?.isSupported?.() ||
      typeof data.title !== 'string' ||
      typeof data.body !== 'string' ||
      !revisions.claim(payload?.revision)
    ) {
      return;
    }
    const iconName = iconNames.has(data.icon) ? data.icon : 'notify-done';
    const icon = path.resolve(helperDir, '..', '..', 'assets', 'pic', iconName + '.png');
    try {
      new Notification({
        title: data.title,
        body: data.body.length > 80 ? data.body.slice(0, 80) + '…' : data.body,
        icon,
      }).show();
    } catch (error) {
      console.warn('[dsh-pet-desktop-helper] DSH notification failed:', String(error?.message || error));
    }
  });
}

module.exports = { registerDshNotificationIpc };
