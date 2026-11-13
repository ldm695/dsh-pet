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

// 类型声明是构建产物、不入 git，克隆后靠这一步补齐；漏跑则 exports 声明的 types 路径全空。
console.log('[prepare] generating types (npm run types)...');
const typesRun = process.platform === 'win32' ? 'cmd /c npm run types' : 'npm run types';
const buildTypes = spawnSync(typesRun, { cwd: ROOT, stdio: 'inherit', shell: true });
if (buildTypes.status !== 0) {
  console.error(`[prepare] 类型声明生成失败 (exit ${buildTypes.status})`);
  process.exit(1);
}

// files 收敛为发布清单：这是本脚本唯一的写操作，幂等，不备份旧值。
const pkg = JSON.parse(readFileSync(PKG, 'utf8'));
const keep = [
  'lib',
  'src',
  'assets/webm',
  'runtime/electron-helper',
  'assets/fonts',
  'assets/pic',
  // 表情包：宿主半侧只从包内 assets/memes 读图，并与配置的 memes 键配对，漏掉即配图功能整体失效。
  // 本数组每次发布都覆盖 package.json 的 files，所以必须加在这里，只在 package.json 里加一行无效。
  'assets/memes',
  // 点击音效：宿主半侧的 /sound 路由只读包内这一份，漏掉则点击静音；同 memes，必须加在本数组。
  'assets/sound',
  'assets/config.jsonc',
  // 插件图标：package.json 顶层 icon 指向这张图；缺图时读取方 dsh-app-boot 的 iconOf 会抛错、退回默认插画。
  'assets/logo.png',
  // 角色参考图：/character 的包内兜底只读 `<素材根>-character.<ext>`，漏发则第三方拿不到官方参考图。
  // 新增内置角色时在这里补一行（文件名里的素材根跟着角色走）。
  'assets/main-character.png',
  'scripts/ensure-electron.mjs',
  'cordis.patch.yml',
];
writeFileSync(PKG, JSON.stringify({ ...pkg, files: keep }, null, 2) + '\n', 'utf8');
console.log(`[prepare] ✓ package.json files=[${keep.join(', ')}]`);
console.log('[prepare] ready to publish: npm publish --tag latest');
