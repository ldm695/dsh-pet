/**
 * 独立设置页的桌宠 React 配置脚本，从同包 `lib/pet-config.js` 读取。
 * @module dsh-pet/src/standalone/pet-config-asset
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PACKAGE_ROOT } from '../host/paths.ts';

let cached: string | undefined;

/**
 * 读取桌宠配置脚本；未构建或文件不可读时返回 undefined。
 */
export function readPetConfigScript(): string | undefined {
  if (cached !== undefined) return cached;
  try {
    cached = readFileSync(join(PACKAGE_ROOT, 'lib', 'pet-config.js'), 'utf8');
    return cached;
  } catch {
    return undefined;
  }
}
