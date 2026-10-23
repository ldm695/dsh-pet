const { app, BrowserWindow, Menu, nativeImage, shell, Tray } = require('electron');
const { spawn } = require('node:child_process');
const { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync } = require('node:fs');
const { join, resolve } = require('node:path');

const PORT = 6952;
const packageMetadata = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8'));
const APP_EDITION = packageMetadata.dshPetEdition === 'public' ? 'public' : 'personal';
const APP_DISPLAY_NAME = APP_EDITION === 'public' ? 'DSH Pet' : '哦鲸鲸';
const APP_ICON_FILE = APP_EDITION === 'public' ? 'logo-rounded.png' : 'dsh-pet-icon-16.png';
const APP_USER_MODEL_ID = APP_EDITION === 'public' ? 'cloud.pc2005.dsh-pet.public' : 'cloud.pc2005.dsh-pet';
const TOAST_ACTIVATOR_CLSID = '{8C4174A4-DA42-4E82-9A67-A0A32D76D6B2}';
// Preserve existing user data when the product branding changes.
if (process.env.DSH_PET_APP_DATA_DIR) {
  app.setPath('appData', resolve(process.env.DSH_PET_APP_DATA_DIR));
}
app.setPath('userData', join(app.getPath('appData'), APP_EDITION === 'public' ? 'dsh-pet-public' : 'dsh-pet'));
process.env.DSH_PET_EDITION = APP_EDITION;
process.env.DSH_PET_DISPLAY_NAME = APP_DISPLAY_NAME;
process.env.DSH_PET_APP_USER_MODEL_ID = APP_USER_MODEL_ID;
let host;
let settingsWindow;
let hostReady = false;
let quitting = false;
let servicePort = PORT;
let hostStdoutBuffer = '';
let tray;
let hostRequestToken = '';
let visibleDesktopPetCount = 0;
let trayRefreshInProgress = false;
let trayRefreshRequested = false;

// The packaged executable is also used to run the transparent-window helper.
// Electron may keep loading this package's main entry even when the helper JS
// path is passed on the command line, so dispatch that path explicitly here.
const helperEntry = process.argv
  .slice(1)
  .find((arg) => /(?:^|[\\/])runtime[\\/]electron-helper[\\/]main\.js$/i.test(arg));
if (helperEntry) {
  require(helperEntry);
} else {
  function log(line) {
    try {
      const logDir = join(app.getPath('userData'), 'logs');
      mkdirSync(logDir, { recursive: true });
      appendFileSync(join(logDir, 'standalone.log'), `${new Date().toISOString()} ${line}\n`);
    } catch {
      // Logging must not prevent the desktop pet from starting.
    }
  }

  function stopHost() {
    if (host && host.exitCode === null) host.kill();
  }

  function quit() {
    if (quitting) return;
    quitting = true;
    stopHost();
    app.quit();
  }

  function openSettings() {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.show();
      settingsWindow.focus();
      return;
    }
    settingsWindow = new BrowserWindow({
      width: 1040,
      height: 900,
      minWidth: 720,
      minHeight: 620,
      title: `${APP_DISPLAY_NAME} 设置`,
      icon: join(app.getAppPath(), 'assets', APP_ICON_FILE),
      backgroundColor: '#292929',
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    const settingsIcon = nativeImage.createFromPath(join(app.getAppPath(), 'assets', APP_ICON_FILE));
    if (!settingsIcon.isEmpty()) settingsWindow.setIcon(settingsIcon);
    settingsWindow.removeMenu();
    settingsWindow.setMenuBarVisibility(false);
    settingsWindow.once('ready-to-show', () => settingsWindow && settingsWindow.show());
    settingsWindow.on('closed', () => {
      settingsWindow = undefined;
      // With neither a tray nor a visible pet, the settings window is the only user-facing
      // entry point. Do not leave an invisible background process after it closes.
      if (!tray && visibleDesktopPetCount === 0 && !quitting) quit();
    });
    if (hostReady) {
      settingsWindow.loadURL(settingsUrl()).catch((error) => {
        log(`[error] Unable to open settings: ${error.message}`);
      });
    }
  }

  function handleHostOutputLine(line) {
    const output = line.trimEnd();
    if (output === 'DSH_PET_CONTROL:open-settings') {
      openSettings();
      return;
    }
    if (output === 'DSH_PET_CONTROL:quit-app') {
      quit();
      return;
    }
    const portMatch = output.match(/服务已监听 http:\/\/127\.0\.0\.1:(\d+)/);
    if (portMatch) {
      servicePort = Number(portMatch[1]);
      hostReady = true;
      void refreshTrayMenu();
      if (settingsWindow && !settingsWindow.isDestroyed() && !settingsWindow.webContents.getURL()) {
        settingsWindow.loadURL(settingsUrl()).catch((error) => {
          log(`[error] Unable to open settings: ${error.message}`);
        });
      }
    }
    if (output) log(output);
  }

  function settingsUrl() {
    return `http://127.0.0.1:${servicePort}/settings`;
  }

  function autoStartSupported() {
    return APP_EDITION === 'public' && process.platform === 'win32' && app.isPackaged;
  }

  function autoStartPath() {
    // Portable builds must register the outer executable, not Electron's extracted runtime path.
    return process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  }

  function getAutoStartState() {
    if (!autoStartSupported()) return { available: false, enabled: false };
    const path = autoStartPath();
    return {
      available: true,
      enabled: app.getLoginItemSettings({ path, args: [] }).openAtLogin,
    };
  }

  function setAutoStart(enabled) {
    if (!autoStartSupported()) throw new Error('开机自启动仅支持大众版 Windows Portable。');
    const path = autoStartPath();
    app.setLoginItemSettings({ openAtLogin: enabled, path, args: [] });
    const state = getAutoStartState();
    log(`[info] Windows login startup ${state.enabled ? 'enabled' : 'disabled'} (${path})`);
    return state;
  }

  function handleHostMessage(message) {
    if (!message || typeof message !== 'object') return;
    if (
      message.channel === 'dsh-pet:request-token' &&
      typeof message.token === 'string' &&
      /^[A-Za-z0-9_-]{43}$/.test(message.token)
    ) {
      hostRequestToken = message.token;
      void refreshTrayMenu();
      return;
    }
    if (message.channel === 'dsh-pet:config-changed') {
      void refreshTrayMenu();
      return;
    }
    if (message.channel !== 'dsh-pet:auto-start' || typeof message.requestId !== 'string') return;
    let response;
    try {
      if (message.action === 'get') response = { ok: true, state: getAutoStartState() };
      else if (message.action === 'set' && typeof message.enabled === 'boolean') {
        response = { ok: true, state: setAutoStart(message.enabled) };
      } else {
        throw new Error('无效的开机自启动请求。');
      }
    } catch (error) {
      response = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (!host?.connected) return;
    host.send({ channel: 'dsh-pet:auto-start:result', requestId: message.requestId, ...response }, (error) => {
      if (error) log(`[warning] Unable to return auto-start result: ${error.message}`);
    });
  }

  const PET_ROUTE = '/dsh-pet-7340';
  const isDesktopDisplay = (display) => display === 'desktop';
  const toggleDisplay = (display) => (isDesktopDisplay(display) ? 'none' : 'desktop');

  async function trayRequest(method, path, body) {
    if (!hostRequestToken) throw new Error('本机设置访问凭据尚未就绪。');
    const response = await fetch(`http://127.0.0.1:${servicePort}${PET_ROUTE}${path}`, {
      method,
      headers: {
        'X-DSH-Pet-Token': hostRequestToken,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text}`);
    return text ? JSON.parse(text) : {};
  }

  async function refreshTrayMenu() {
    if (!hostReady || !hostRequestToken) return;
    if (trayRefreshInProgress) {
      trayRefreshRequested = true;
      return;
    }
    trayRefreshInProgress = true;
    try {
      do {
        trayRefreshRequested = false;
        await refreshTrayMenuOnce();
      } while (trayRefreshRequested);
    } finally {
      trayRefreshInProgress = false;
      if (trayRefreshRequested) void refreshTrayMenu();
    }
  }

  async function refreshTrayMenuOnce() {
    try {
      const merged = await trayRequest('GET', '/config');
      const pets = Object.values(merged)
        .flatMap((conf) => (conf && Array.isArray(conf.pets) ? conf.pets : []))
        .map((pet) => ({
          id: String(pet?.id || ''),
          name: String(pet?.name || '').trim(),
          display: String(pet?.display || ''),
        }))
        .filter((pet) => pet.id);
      visibleDesktopPetCount = pets.filter((pet) => isDesktopDisplay(pet.display)).length;
      const trayEnabled = merged?.main?.trayEnabled !== false;
      if (!trayEnabled) {
        if (tray && !tray.isDestroyed()) tray.destroy();
        tray = undefined;
        if (visibleDesktopPetCount === 0 && (!settingsWindow || settingsWindow.isDestroyed())) openSettings();
        return;
      }
      createTrayIcon();
      if (!tray || tray.isDestroyed()) return;
      const petItems = [
        {
          label: '全部显示',
          type: 'checkbox',
          checked: pets.length > 0 && pets.every((pet) => isDesktopDisplay(pet.display)),
          click: () => setTrayPetsDisplay(pets, true),
        },
        {
          label: '全部隐藏',
          type: 'checkbox',
          checked: pets.length > 0 && pets.every((pet) => !isDesktopDisplay(pet.display)),
          click: () => setTrayPetsDisplay(pets, false),
        },
        { type: 'separator' },
        ...pets.map((pet) => ({
          label: pet.name || pet.id,
          type: 'checkbox',
          checked: isDesktopDisplay(pet.display),
          click: () => setTrayPetDisplay(pet, toggleDisplay(pet.display)),
        })),
      ];
      let contextMenu;
      contextMenu = Menu.buildFromTemplate([
        { label: `${APP_DISPLAY_NAME} 设置…`, click: openSettings },
        { label: '查看日志', click: () => shell.openPath(join(app.getPath('userData'), 'logs', 'standalone.log')) },
        { type: 'separator' },
        { label: '桌宠显示', submenu: Menu.buildFromTemplate(petItems) },
        { type: 'separator' },
        { label: `退出 ${APP_DISPLAY_NAME}`, click: quit },
      ]);
      tray.setContextMenu(contextMenu);
    } catch (error) {
      log(`[warning] Unable to refresh tray menu: ${error.message}`);
    }
  }

  async function setTrayPetsDisplay(pets, visible) {
    const ids = pets.map((pet) => pet.id);
    if (!ids.length) return;
    try {
      await trayRequest('POST', '/pet-display/bulk', JSON.stringify({ ids, display: visible ? 'desktop' : 'none' }));
      await refreshTrayMenu();
    } catch (error) {
      log(`[warning] Unable to update all pet display settings: ${error.message}`);
    }
  }

  async function setTrayPetDisplay(pet, display) {
    try {
      await trayRequest('POST', '/pet-display', JSON.stringify({ id: pet.id, display }));
      await refreshTrayMenu();
    } catch (error) {
      log(`[warning] Unable to update pet display: ${error.message}`);
    }
  }

  function createTrayIcon() {
    if (tray) return;
    const icon = nativeImage.createFromPath(join(app.getAppPath(), 'assets', APP_ICON_FILE));
    if (icon.isEmpty()) {
      log('[warning] Tray icon is missing or unreadable');
      return;
    }
    if (process.platform === 'darwin') icon.setTemplateImage(true);
    tray = new Tray(icon);
    tray.setToolTip(APP_DISPLAY_NAME);
    tray.on('click', openSettings);
  }

  function ensureNotificationShortcut() {
    if (process.platform !== 'win32' || !app.isPackaged) return;
    const target = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    const startMenu = join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    const shortcut = join(startMenu, `${APP_DISPLAY_NAME}.lnk`);
    const legacyShortcut = APP_EDITION === 'personal' ? join(startMenu, 'DSH Pet.lnk') : undefined;
    mkdirSync(startMenu, { recursive: true });
    // 保留旧快捷方式并迁移其名称，避免同一 AppUserModelID 对应两个通知来源。
    let legacyTarget;
    if (legacyShortcut && existsSync(legacyShortcut)) {
      try {
        legacyTarget = shell.readShortcutLink(legacyShortcut).target;
      } catch {
        // A damaged or unrelated legacy shortcut must not block current shortcut creation.
      }
    }
    if (
      legacyShortcut &&
      legacyTarget &&
      legacyTarget.toLowerCase() === target.toLowerCase() &&
      !existsSync(shortcut)
    ) {
      try {
        renameSync(legacyShortcut, shortcut);
      } catch {
        // 即使旧链接暂时无法改名，也继续创建新链接以更新通知来源名。
      }
    }
    const written = shell.writeShortcutLink(shortcut, existsSync(shortcut) ? 'update' : 'create', {
      target,
      args: [],
      description: APP_DISPLAY_NAME,
      icon: target,
      iconIndex: 0,
      appUserModelId: APP_USER_MODEL_ID,
      toastActivatorClsid: TOAST_ACTIVATOR_CLSID,
    });
    if (!written) throw new Error('Windows did not create the notification Start Menu shortcut');
  }

  if (process.platform === 'win32') {
    app.setAppUserModelId(APP_USER_MODEL_ID);
    app.setToastActivatorCLSID(TOAST_ACTIVATOR_CLSID);
  }
  app.whenReady().then(() => {
    const packageRoot = app.getAppPath();
    try {
      ensureNotificationShortcut();
    } catch (error) {
      log(`[warning] Unable to create notification Start Menu shortcut: ${error.message}`);
    }
    const hostScript = join(packageRoot, 'lib', 'standalone.js');
    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      DSH_PET_ELECTRON_PATH: process.execPath,
      DSH_PET_PACKAGE_ROOT: packageRoot,
      DSH_PET_WORK_STATUS_DIAGNOSTICS_FILE: join(app.getPath('userData'), 'logs', 'work-status-diagnostics.jsonl'),
      // TEMPORARY MOVE DIAGNOSTICS: remove this env var before a formal release.
      DSH_PET_MOVE_DIAGNOSTICS_FILE: join(app.getPath('userData'), 'logs', 'move-diagnostics.jsonl'),
      DSH_PET_EDITION: APP_EDITION,
      DSH_PET_DISPLAY_NAME: APP_DISPLAY_NAME,
      DSH_PET_AUTOSTART_SUPPORTED: autoStartSupported() ? '1' : '0',
      DSH_PET_APP_USER_MODEL_ID: APP_USER_MODEL_ID,
      DSH_PET_STANDALONE_LOG_FILE: join(app.getPath('userData'), 'logs', 'standalone.log'),
    };
    host = spawn(process.execPath, [hostScript, '--port', String(PORT)], {
      cwd: app.getPath('userData'),
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    host.on('message', handleHostMessage);
    host.stdout.on('data', (chunk) => {
      hostStdoutBuffer += String(chunk);
      let newline;
      while ((newline = hostStdoutBuffer.indexOf('\n')) >= 0) {
        const line = hostStdoutBuffer.slice(0, newline);
        hostStdoutBuffer = hostStdoutBuffer.slice(newline + 1);
        handleHostOutputLine(line);
      }
    });
    host.stderr.on('data', (chunk) => log(`[stderr] ${String(chunk).trimEnd()}`));
    host.once('error', (error) => {
      log(`[error] Unable to start standalone host: ${error.message}`);
    });
    host.once('exit', (code, signal) => {
      log(`[exit] standalone host code=${String(code)} signal=${String(signal)}`);
      if (!quitting) quit();
    });

    // The unscaled main process owns the tray. DPI linearization remains isolated
    // in the pet-window helper and cannot affect the native tray menu.
    if (process.platform === 'darwin' && app.dock) app.dock.hide();
  });

  app.on('before-quit', () => {
    quitting = true;
    stopHost();
  });

  // Closing the settings window must leave the tray app and standalone host running.
  app.on('window-all-closed', () => {});
}
