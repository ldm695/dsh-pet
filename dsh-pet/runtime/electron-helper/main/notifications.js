/**
 * DSH 桌面通知：校验渲染端上报，并按共享状态 revision 在 Helper 进程内去重。
 *
 * 各宠物窗口会消费同一条状态叶子；通知必须在主进程收敛为一次系统通知。
 * @module dsh-pet/runtime/electron-helper/main/notifications
 */
'use strict';

const path = require('node:path');
const { createNotificationRevisionGate } = require('../notification-revisions.js');

function registerDshNotificationIpc({ ipcMain, BrowserWindow, Notification, petWindows, helperDir }) {
  const revisionGate = createNotificationRevisionGate();

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
      (win?.isFocused() && win.isVisible()) ||
      !Notification?.isSupported?.() ||
      typeof data.title !== 'string' ||
      typeof data.body !== 'string' ||
      !revisionGate.claim(payload?.revision)
    ) {
      return;
    }

    const iconNames = new Set([
      'notify-done',
      'notify-error',
      'notify-truncated',
      'notify-approval',
      'notify-question',
      'notify-test',
    ]);
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
