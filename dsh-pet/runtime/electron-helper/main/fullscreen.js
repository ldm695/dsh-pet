'use strict';

const { FullscreenDisplayStabilizer } = require('../fullscreen-state.js');

const FULLSCREEN_FADE_MS = 220;
const NATIVE_SHOW_SETTLE_MS = 260;
const POLL_MS = 500;

function createFullscreenVisibility({
  app,
  BrowserWindow,
  ipcMain,
  screen,
  petWindows,
  priority,
  platform = process.platform,
}) {
  let mode = normalizePriority(priority);
  let hideOnFullscreen = mode === 'hide-on-fullscreen' || mode === 'hide-on-fullscreen-or-maximized';
  let hideOnMaximized = mode === 'hide-on-fullscreen-or-maximized';
  const stabilizer = new FullscreenDisplayStabilizer(2);
  const hiddenDisplayIds = new Set();
  const targetByWindow = new Map();
  const sequenceByWindow = new Map();
  const reducedMotionByRenderer = new Map();
  const waiters = new Map();
  let sequence = 0;
  let timer = null;
  let probe = null;
  let started = false;
  let enumerationWarningShown = false;
  let ready = !hideOnFullscreen && !hideOnMaximized;

  function isHelperRenderer(contents) {
    const win = BrowserWindow.fromWebContents(contents);
    return (
      !!win && ([...petWindows.state.windows.values()].includes(win) || petWindows.state.notificationWindow === win)
    );
  }

  function sendTransition(win, hidden, transitioning, durationMs) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return Promise.resolve(false);
    const id = ++sequence;
    return new Promise((resolve) => {
      const timeout = setTimeout(
        () => {
          waiters.delete(id);
          resolve(false);
        },
        Math.max(350, durationMs + 150),
      );
      waiters.set(id, { rendererId: win.webContents.id, timeout, resolve });
      try {
        win.webContents.send('pet:fullscreen-visibility-transition', { id, hidden, transitioning, durationMs });
      } catch {
        clearTimeout(timeout);
        waiters.delete(id);
        resolve(false);
      }
    });
  }

  function completeTransition(event, id) {
    const waiter = waiters.get(id);
    if (!waiter || waiter.rendererId !== event.sender.id) return;
    clearTimeout(waiter.timeout);
    waiters.delete(id);
    waiter.resolve(true);
  }

  function isCurrent(win, id, hidden) {
    return !win.isDestroyed() && sequenceByWindow.get(win.id) === id && targetByWindow.get(win.id) === hidden;
  }

  async function transition(win, hidden) {
    if (!win || win.isDestroyed()) return;
    const id = (sequenceByWindow.get(win.id) || 0) + 1;
    sequenceByWindow.set(win.id, id);
    const reducedMotion = reducedMotionByRenderer.get(win.webContents.id) !== false;
    const duration = reducedMotion ? 0 : FULLSCREEN_FADE_MS;
    if (hidden) {
      if (!win.isVisible()) return;
      await sendTransition(win, true, true, duration);
      if (!isCurrent(win, id, true)) return;
      win.hide();
      await sendTransition(win, true, false, 0);
      return;
    }
    if (!win.isVisible()) {
      await sendTransition(win, true, true, 0);
      if (!isCurrent(win, id, false)) return;
      win.showInactive();
      if (!reducedMotion) await new Promise((resolve) => setTimeout(resolve, NATIVE_SHOW_SETTLE_MS));
      if (!isCurrent(win, id, false)) return;
    }
    await sendTransition(win, false, true, duration);
    if (!isCurrent(win, id, false)) return;
    await sendTransition(win, false, false, 0);
  }

  function displayIdForWindow(win) {
    try {
      return String(screen.getDisplayMatching(win.getBounds()).id);
    } catch {
      return null;
    }
  }

  function applyVisibility() {
    for (const win of new Set(petWindows.state.windows.values())) {
      if (win.isDestroyed()) continue;
      const displayId = displayIdForWindow(win);
      const hidden = !ready || (displayId !== null && hiddenDisplayIds.has(displayId));
      const previous = targetByWindow.get(win.id);
      targetByWindow.set(win.id, hidden);
      if (previous !== hidden) void transition(win, hidden);
      else if (!hidden && !win.isVisible()) void transition(win, false);
    }
  }

  function rectMatchesDisplay(rect, bounds) {
    const tolerance = Math.max(10, Math.round(Math.min(bounds.width, bounds.height) * 0.02));
    return (
      Math.abs(rect.left - bounds.x) <= tolerance &&
      Math.abs(rect.top - bounds.y) <= tolerance &&
      Math.abs(rect.right - (bounds.x + bounds.width)) <= tolerance &&
      Math.abs(rect.bottom - (bounds.y + bounds.height)) <= tolerance
    );
  }

  function update(sample, losslessWindows) {
    const next = new Set();
    const desktopShell = new Set(['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd']);
    if (sample && !desktopShell.has(sample.className)) {
      const rect = { left: sample.left, top: sample.top, right: sample.right, bottom: sample.bottom };
      if (hideOnFullscreen) {
        for (const display of screen.getAllDisplays())
          if (rectMatchesDisplay(rect, display.bounds)) next.add(String(display.id));
      }
      if (hideOnMaximized && sample.isMaximized) {
        try {
          next.add(
            String(
              screen.getDisplayMatching({
                x: sample.left,
                y: sample.top,
                width: sample.right - sample.left,
                height: sample.bottom - sample.top,
              }).id,
            ),
          );
        } catch {}
      }
    }
    if (hideOnFullscreen) {
      for (const item of losslessWindows) {
        for (const display of screen.getAllDisplays())
          if (rectMatchesDisplay(item.rect, display.bounds)) next.add(String(display.id));
      }
    }
    hiddenDisplayIds.clear();
    for (const id of stabilizer.update(next)) hiddenDisplayIds.add(id);
    ready = true;
    applyVisibility();
  }

  function stopWatcher() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function stop() {
    stopWatcher();
    ipcMain.removeListener('pet:motion-preference', onMotionPreference);
    ipcMain.removeListener('pet:fullscreen-transition-complete', completeTransition);
    for (const waiter of waiters.values()) {
      clearTimeout(waiter.timeout);
      waiter.resolve(false);
    }
    waiters.clear();
  }

  function normalizePriority(value) {
    return ['hide-on-fullscreen', 'hide-on-fullscreen-or-maximized', 'normal'].includes(value)
      ? value
      : 'always-on-top';
  }

  function setPriority(value) {
    mode = normalizePriority(value);
    hideOnFullscreen = mode === 'hide-on-fullscreen' || mode === 'hide-on-fullscreen-or-maximized';
    hideOnMaximized = mode === 'hide-on-fullscreen-or-maximized';
    hiddenDisplayIds.clear();
    ready = !hideOnFullscreen && !hideOnMaximized;
    if (timer) clearInterval(timer);
    timer = null;
    applyVisibility();
    if (started) startWatcher();
  }

  function failOpen(error) {
    stopWatcher();
    ready = true;
    hiddenDisplayIds.clear();
    applyVisibility();
    if (error) console.warn('[dsh-pet desktop helper] fullscreen detection disabled:', String(error?.message || error));
  }

  function onMotionPreference(event, reducedMotion) {
    if (!isHelperRenderer(event.sender) || typeof reducedMotion !== 'boolean') return;
    const previous = reducedMotionByRenderer.get(event.sender.id);
    reducedMotionByRenderer.set(event.sender.id, reducedMotion);
    if (previous === reducedMotion || !reducedMotion) return;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && targetByWindow.has(win.id)) void transition(win, targetByWindow.get(win.id));
  }

  function startWatcher() {
    if (!hideOnFullscreen && !hideOnMaximized) return;
    if (platform !== 'win32') return;
    try {
      const { createFullscreenWindowProbe } = require('../win32-fullscreen.js');
      probe = createFullscreenWindowProbe();
      const poll = () => {
        try {
          const displays = screen.getAllDisplays().map((display) => display.bounds);
          let losslessWindows = [];
          if (hideOnFullscreen) {
            try {
              losslessWindows = probe.enumerateLosslessScalingWindows(displays);
            } catch (error) {
              if (!enumerationWarningShown) {
                enumerationWarningShown = true;
                console.warn(
                  '[dsh-pet desktop helper] Lossless Scaling window enumeration skipped:',
                  String(error?.message || error),
                );
              }
            }
          }
          update(probe.readForegroundWindow(), losslessWindows);
        } catch (error) {
          failOpen(error);
        }
      };
      poll();
      if (timer === null) {
        timer = setInterval(poll, POLL_MS);
        timer.unref?.();
      }
    } catch (error) {
      failOpen(error);
    }
  }

  function start() {
    if (started) return;
    started = true;
    ipcMain.on('pet:motion-preference', onMotionPreference);
    ipcMain.on('pet:fullscreen-transition-complete', completeTransition);
    startWatcher();
  }

  return { start, stop, applyVisibility, setPriority };
}

module.exports = { createFullscreenVisibility };
