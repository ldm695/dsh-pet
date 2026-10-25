'use strict';

/** Windows 置顶层级检查频率。判定只读窗口状态，不会操作窗口。 */
const TOPMOST_WATCHDOG_TICK_MS = 1000;

/** 距上次设为置顶至少经过此时间后，才允许恢复一次。 */
const TOPMOST_REASSERT_MS = 5000;

/** macOS 使用普通悬浮层；其它平台使用 Electron 的 screen-saver 层级。 */
function topmostLevel(platform) {
  return platform === 'darwin' ? 'floating' : 'screen-saver';
}

/**
 * 置顶层级恢复开关。
 *
 * 实际调用还受平台和显示策略限制：仅 Windows 的全屏隐藏策略会启用，且隐藏窗口不恢复。
 * 当前前台若已经是置顶窗口，也会跳过，避免周期性重置把截图浮层等前台置顶窗口盖住。
 */
const TOPMOST_WATCHDOG_ENABLED = true;

/**
 * 判断这一拍是否可以恢复窗口的置顶层级。
 *
 * @param {{nowMs:number,lastAssertMs:number,destroyed:boolean,visible:boolean,paused:boolean,foregroundTopmost:boolean}} state
 * @param {boolean} [enabled]
 * @returns {boolean}
 */
function shouldReassertTopmost(state, enabled = true) {
  if (!enabled) return false;
  const { nowMs, lastAssertMs, destroyed, visible, paused, foregroundTopmost } = state || {};
  if (destroyed || !visible || paused || foregroundTopmost) return false;
  const elapsed = nowMs - lastAssertMs;
  return !(elapsed >= 0 && elapsed < TOPMOST_REASSERT_MS);
}

module.exports = {
  TOPMOST_WATCHDOG_TICK_MS,
  TOPMOST_REASSERT_MS,
  TOPMOST_WATCHDOG_ENABLED,
  shouldReassertTopmost,
  topmostLevel,
};
