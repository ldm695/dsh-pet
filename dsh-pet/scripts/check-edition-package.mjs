#!/usr/bin/env node
/**
 * Verify edition-specific branding and the optional Win32 native binding in an unpacked application.
 * @module dsh-pet/scripts/check-edition-package
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const edition = process.argv[2];
if (!['public', 'personal'].includes(edition)) {
  console.error('用法：node scripts/check-edition-package.mjs <public|personal>');
  process.exit(2);
}
const appDir = resolve('dist-app', edition, 'win-unpacked');
const asarPath = join(appDir, 'resources', 'app.asar');
const unpackedPath = join(appDir, 'resources', 'app.asar.unpacked');
if (!existsSync(asarPath)) throw new Error(`缺少打包文件：${asarPath}`);
const asarIndex = readFileSync(asarPath).toString('latin1');
const editionAsset = edition === 'public' ? 'dsh-pet-icon-public.ico' : 'dsh-pet-icon.ico';
const forbiddenAsset = edition === 'public' ? 'dsh-pet-icon.ico' : 'dsh-pet-icon-public.ico';
if (!asarIndex.includes(editionAsset)) throw new Error(`${edition} 包缺少专属图标 ${editionAsset}`);
if (asarIndex.includes(forbiddenAsset)) throw new Error(`${edition} 包混入了另一版本的图标 ${forbiddenAsset}`);
if (edition === 'public' && asarIndex.includes('dsh-pet-icon-16.png')) {
  throw new Error('大众包混入了个人版托盘图标');
}
if (!asarIndex.includes('node_modules/koffi/')) throw new Error('桌面包未包含 Koffi 主模块');
const nativeBinding = join(unpackedPath, 'node_modules', '@koromix', 'koffi-win32-x64', 'win32_x64', 'koffi.node');
if (!existsSync(nativeBinding)) throw new Error(`桌面包缺少 Windows 原生绑定：${nativeBinding}`);
console.log(`包资源检查通过：${edition}，专属图标正确，Koffi Windows 绑定已解包。`);
