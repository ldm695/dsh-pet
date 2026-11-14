/**
 * Standalone React settings application bundle loader.
 * @module dsh-pet/src/standalone/settings-app-asset
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PACKAGE_ROOT } from '../host/paths.ts';

let cached: string | undefined;

/** Read the built React settings application; source-only launches report a clear missing asset. */
export function readSettingsAppScript(): string | undefined {
  if (cached !== undefined) return cached;
  try {
    cached = readFileSync(join(PACKAGE_ROOT, 'lib', 'settings-app.js'), 'utf8');
    return cached;
  } catch {
    return undefined;
  }
}
