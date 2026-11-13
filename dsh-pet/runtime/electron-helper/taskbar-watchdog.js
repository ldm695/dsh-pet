/**
 * Windows 任务栏看门狗的纯判定。
 * Shell 重建任务栏后可能重新登记桌宠窗口；周期性重申 `skipTaskbar` 可使隐藏状态恢复。
 * @module dsh-pet/runtime/electron-helper/taskbar-watchdog
 */
'use strict';

/** Shell 重建后最迟重新隐藏任务栏按钮的间隔。 */
const TASKBAR_WATCHDOG_TICK_MS = 3000;

/** 缺省启用；可用环境变量显式关闭以便排查问题。 */
const TASKBAR_WATCHDOG_ENABLED = true;

/**
 * 判断当前平台是否运行看门狗。
 * @param {string} platform - `process.platform`。
 * @param {boolean} [enabled] - 总开关。
 * @returns {boolean} 仅 Windows 且开启时为 true。
 */
function shouldRunTaskbarWatchdog(platform, enabled = TASKBAR_WATCHDOG_ENABLED) {
  return enabled && platform === 'win32';
}

/**
 * 解析看门狗环境变量：只有显式 `0` 或 `false` 才关闭。
 * @param {string | undefined} raw - `DSH_PET_TASKBAR_WATCHDOG` 的值。
 * @returns {boolean} 是否启用。
 */
function taskbarWatchdogEnabledFromEnv(raw) {
  return raw !== '0' && raw !== 'false';
}

module.exports = {
  TASKBAR_WATCHDOG_TICK_MS,
  TASKBAR_WATCHDOG_ENABLED,
  shouldRunTaskbarWatchdog,
  taskbarWatchdogEnabledFromEnv,
};
