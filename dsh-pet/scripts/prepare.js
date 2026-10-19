#!/usr/bin/env node
/**
 * prepare.js —— 构建 Windows EXE 所需运行产物。
 *
 * 做什么：
 *   1. 构建独立宿主与 EXE 内嵌设置页（npm run bundle）
 *   1.5 构建桌面共享核心（npm run build:desktop-core：src/shared → window.PetShared）
 *
 * 用法：node scripts/prepare.js（npm run build）
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

// 1. 构建 src → lib
// Windows 下 npm 是 npm.cmd，spawnSync 无法直接执行 .cmd；用 cmd /c 跑整条命令
// （固定命令行，无用户输入，无注入风险）
console.log('[prepare] building (tsdown)...');
const npmRun = process.platform === 'win32' ? 'cmd /c npm run bundle' : 'npm run bundle';
const build = spawnSync(npmRun, { cwd: ROOT, stdio: 'inherit', shell: true });
if (build.status !== 0) {
  console.error(`[prepare] 构建失败 (exit ${build.status})`);
  process.exit(1);
}

// 1.5 构建桌面共享核心（src/shared → window.PetShared 经典 script；与浏览器 bundle 同一份源码）
console.log('[prepare] building desktop shared-core...');
const coreRun = process.platform === 'win32' ? 'cmd /c npm run build:desktop-core' : 'npm run build:desktop-core';
const buildCore = spawnSync(coreRun, { cwd: ROOT, stdio: 'inherit', shell: true });
if (buildCore.status !== 0) {
  console.error(`[prepare] 桌面 shared-core 构建失败 (exit ${buildCore.status})`);
  process.exit(1);
}

console.log('[prepare] build complete: Windows EXE runtime assets are ready.');
