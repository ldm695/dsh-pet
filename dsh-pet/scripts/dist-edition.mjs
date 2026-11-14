#!/usr/bin/env node
/**
 * Build an isolated public or personal Windows application, including a fast-start zip and optional portable exe.
 * @module dsh-pet/scripts/dist-edition
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const edition = process.argv[2];
if (process.platform !== 'win32' || !['public', 'personal'].includes(edition)) {
  console.error('用法：node scripts/dist-edition.mjs <public|personal>（仅支持 Windows）');
  process.exit(2);
}

const metadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const output = join(root, 'dist-app', edition);
const config = join(root, `electron-builder.${edition}.yml`);
const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
const electronDist = process.env.DSH_PET_ELECTRON_DIST || join(dshHome, 'electron');
if (!existsSync(join(electronDist, 'electron.exe'))) {
  console.error(`找不到本机 Electron：${electronDist}\nelectron 下载目录由 DSH_PET_ELECTRON_DIST 或 DSH_HOME 指定。`);
  process.exit(1);
}
const builder = join(root, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');
const env = {
  ...process.env,
  ELECTRON_BUILDER_BINARIES_MIRROR:
    process.env.ELECTRON_BUILDER_BINARIES_MIRROR || 'https://npmmirror.com/mirrors/electron-builder-binaries/',
  ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/',
  ELECTRON_SKIP_BINARY_DOWNLOAD: '1',
  CSC_IDENTITY_AUTO_DISCOVERY: 'false',
};

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: 'inherit', ...options });
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? resolvePromise() : reject(new Error(`${command} exited ${code}`))));
  });
}

const builderArgs = (target) => [
  builder,
  '--win',
  target,
  '--config',
  config,
  `--config.electronDist=${electronDist}`,
  `--config.directories.output=${output}`,
];

try {
  await run(process.execPath, builderArgs('dir'));
  const unpacked = join(output, 'win-unpacked');
  if (!existsSync(join(unpacked, 'resources', 'app.asar'))) {
    throw new Error(`解包应用缺失：${unpacked}`);
  }
  await run(process.execPath, [join(root, 'scripts', 'check-edition-package.mjs'), edition]);
  const zipName =
    edition === 'public' ? `DSH-Pet-${metadata.version}-win-x64.zip` : `哦鲸鲸-${metadata.version}-win-x64.zip`;
  const zipPath = join(output, zipName);
  const escapedDir = unpacked.replaceAll("'", "''");
  const escapedZip = zipPath.replaceAll("'", "''");
  const zipCommand = `Compress-Archive -Path (Join-Path '${escapedDir}' '*') -DestinationPath '${escapedZip}' -Force`;
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', zipCommand]);
  await run(process.execPath, builderArgs('portable'));
  console.log(`构建完成：${output}`);
  console.log(`快速启动包：${zipPath}`);
  console.log(`便携 exe：${output}`);
} catch (error) {
  console.error(`构建失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
