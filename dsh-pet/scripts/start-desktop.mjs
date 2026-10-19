#!/usr/bin/env node
/**
 * start-desktop.mjs —— 本地开发/手动启动桌面 Helper（不经 DSH 宿主拉起）。
 *
 * 用法：
 *   node scripts/start-desktop.mjs [configUrl]
 *
 * 环境变量（与宿主拉起时一致）：
 *   DSH_PET_CONFIG_URL / DSH_PET_SCALE / DSH_PET_ELECTRON_PATH
 * 其余端点（thumb/balance/trigger/notify/pic/font）由 renderer 从 configUrl 推导。
 *
 * 示例（对着一个已运行的本机 DSH Pet API）：
 *   node scripts/start-desktop.mjs http://127.0.0.1:6952/dsh-pet-7340/config
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const helperMain = resolve(here, '..', 'runtime', 'electron-helper', 'main.js');
const defaultConfigUrl =
  process.env.DSH_PET_CONFIG_URL || process.argv[2] || 'http://127.0.0.1:6952/dsh-pet-7340/config';

// 手动启动时没有 DSH 宿主为 Helper 透传宠物列表。同步读取同一配置端点，
// 让主进程为渲染端实际显示的每只桌宠都创建窗口并注册命中区域。
async function desktopPetsFromConfig(configUrl) {
  if (process.env.DSH_PET_PETS) return process.env.DSH_PET_PETS;
  try {
    const response = await fetch(configUrl, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const config = await response.json();
    const pets = Array.isArray(config?.main?.pets) ? config.main.pets : Array.isArray(config?.pets) ? config.pets : [];
    return JSON.stringify(
      pets
        .filter((pet) => pet && pet.display === 'desktop')
        .map((pet, index) => ({
          id: String(pet.id ?? `pet-${index}`),
          size: Number(pet.size) > 0 ? Number(pet.size) : 462,
          position: pet.position && typeof pet.position === 'object' ? pet.position : null,
        })),
    );
  } catch (error) {
    console.warn(
      `[start-desktop] Could not load the desktop pet list; using helper fallback: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

// 平台适配：Electron 可执行文件相对路径（win32=electron.exe / darwin=Electron.app / linux=electron）
const PLAT = process.platform;
const electronRel =
  PLAT === 'win32'
    ? 'electron.exe'
    : PLAT === 'darwin'
      ? join('Electron.app', 'Contents', 'MacOS', 'Electron')
      : 'electron';

// 解析 Electron 可执行文件（不阻塞安装：提示用户先 ensure:electron）
const candidates = [
  process.env.DSH_PET_ELECTRON_PATH,
  process.env.ELECTRON_PATH,
  join(
    process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh'),
    'electron',
    electronRel,
  ),
];
const electron = candidates.find((value) => value && existsSync(value));
if (!electron) {
  console.error(
    '[start-desktop] Electron not found. Run `npm run ensure:electron` first or set DSH_PET_ELECTRON_PATH.',
  );
  process.exit(1);
}

const env = {
  ...process.env,
  DSH_PET_CONFIG_URL: defaultConfigUrl,
  DSH_PET_SCALE: process.env.DSH_PET_SCALE || '1',
  // 开发流也跟随：本脚本退出（含被强杀）后桌宠自己走，不留一个没人管的 helper
  // （helper 侧 host-liveness.js 每 2s kill(pid, 0) 一次，ESRCH 即自行退出；见 issue #56）
  DSH_PET_HOST_PID: String(process.pid),
};
env.DSH_PET_PETS = await desktopPetsFromConfig(defaultConfigUrl);
// 删掉会劫持 Electron 启动模式的变量（issue #63）：终端/宿主里若带着 ELECTRON_RUN_AS_NODE，
// Electron 会以纯 Node 模式启动，main.js 顶部 require('electron') 直接 MODULE_NOT_FOUND。
// 必须**删键**，不能设空串（实测空串会让 Electron 直接 abort）。
delete env.ELECTRON_RUN_AS_NODE;

console.log(`[start-desktop] electron:   ${electron}`);
console.log(`[start-desktop] config url: ${env.DSH_PET_CONFIG_URL}`);

const child = spawn(electron, [helperMain], { env, stdio: 'inherit', windowsHide: false });
child.on('exit', (code, signal) => {
  console.log(`[start-desktop] helper exited (code=${String(code)}, signal=${String(signal)})`);
});
