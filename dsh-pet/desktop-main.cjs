const { app, BrowserWindow, Menu, Tray, shell } = require('electron');
const { spawn } = require('node:child_process');
const { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync } = require('node:fs');
const { join } = require('node:path');

const PORT = 6952;
const packageMetadata = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8'));
const APP_EDITION = packageMetadata.dshPetEdition === 'public' ? 'public' : 'personal';
const APP_DISPLAY_NAME = APP_EDITION === 'public' ? 'DSH Pet' : '哦鲸鲸';
const APP_USER_MODEL_ID = APP_EDITION === 'public' ? 'cloud.pc2005.dsh-pet.public' : 'cloud.pc2005.dsh-pet';
const TOAST_ACTIVATOR_CLSID = '{8C4174A4-DA42-4E82-9A67-A0A32D76D6B2}';
// Diagnostic launch switches are forwarded through the standalone host to the transparent helper.
// Example: app.exe --dsh-pet-render-mode=hardware --dsh-pet-frame-diagnostics
for (const arg of process.argv.slice(1)) {
  const renderMode = arg.match(/^--dsh-pet-render-mode=(software|hardware)$/i)?.[1]?.toLowerCase();
  if (renderMode) process.env.DSH_PET_RENDER_MODE = renderMode;
  if (arg === '--dsh-pet-frame-diagnostics') process.env.DSH_PET_FRAME_DIAGNOSTICS = '1';
}
// Product branding can change without relocating existing settings, logs, and credentials.
app.setPath('userData', join(app.getPath('appData'), APP_EDITION === 'public' ? 'dsh-pet-public' : 'dsh-pet'));
process.env.DSH_PET_EDITION = APP_EDITION;
process.env.DSH_PET_DISPLAY_NAME = APP_DISPLAY_NAME;
process.env.DSH_PET_APP_USER_MODEL_ID = APP_USER_MODEL_ID;
const renderModeSettingsPath = join(app.getPath('userData'), 'render-mode.json');
process.env.DSH_PET_RENDER_MODE_FILE = renderModeSettingsPath;
if (!process.env.DSH_PET_RENDER_MODE) {
  try {
    const preference = JSON.parse(readFileSync(renderModeSettingsPath, 'utf8'));
    process.env.DSH_PET_RENDER_MODE = preference.renderMode === 'software' ? 'software' : 'hardware';
  } catch {
    process.env.DSH_PET_RENDER_MODE = 'hardware';
  }
}
let host;
let tray;
let settingsWindow;
let hostReady = false;
let quitting = false;
let servicePort = PORT;
let hostStdoutBuffer = '';

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
      icon: join(app.getAppPath(), 'assets', 'dsh-pet-icon-16.png'),
      backgroundColor: '#292929',
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    settingsWindow.removeMenu();
    settingsWindow.setMenuBarVisibility(false);
    settingsWindow.once('ready-to-show', () => settingsWindow && settingsWindow.show());
    settingsWindow.on('closed', () => {
      settingsWindow = undefined;
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
      DSH_PET_WORK_STATUS_DIAGNOSTICS_FILE: join(
        app.getPath('userData'),
        'logs',
        'work-status-diagnostics.jsonl',
      ),
      DSH_PET_EDITION: APP_EDITION,
      DSH_PET_DISPLAY_NAME: APP_DISPLAY_NAME,
      DSH_PET_APP_USER_MODEL_ID: APP_USER_MODEL_ID,
    };
    host = spawn(process.execPath, [hostScript, '--port', String(PORT)], {
      cwd: app.getPath('userData'),
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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

    tray = new Tray(join(packageRoot, 'assets', 'dsh-pet-icon-16.png'));
    tray.setToolTip(APP_DISPLAY_NAME);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: `${APP_DISPLAY_NAME} 设置…`, click: openSettings },
        { type: 'separator' },
        { label: '查看日志', click: () => shell.openPath(join(app.getPath('userData'), 'logs', 'standalone.log')) },
        { type: 'separator' },
        { label: `退出 ${APP_DISPLAY_NAME}`, click: quit },
      ]),
    );
    tray.on('click', openSettings);
  });

  app.on('before-quit', () => {
    quitting = true;
    stopHost();
  });

  // Closing the settings window must leave the tray app and standalone host running.
  app.on('window-all-closed', () => {});
}
