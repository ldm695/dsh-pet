'use strict';

/** Resolve a writable, edition-specific Electron profile without touching application data. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function prepareWritableDir(dir, fileSystem = fs) {
  let probe;
  try {
    fileSystem.mkdirSync(dir, { recursive: true });
    probe = path.join(dir, `.dsh-pet-write-probe-${process.pid}-${Math.random().toString(16).slice(2)}`);
    fileSystem.writeFileSync(probe, '', { flag: 'wx' });
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error };
  } finally {
    if (probe) {
      try {
        fileSystem.unlinkSync(probe);
      } catch {
        // A failed probe is only a diagnostic artifact; do not hide the original write failure.
      }
    }
  }
}

function dshHomeDir(env = process.env, home = os.homedir()) {
  return env.DSH_HOME || path.join(env.USERPROFILE || env.HOME || home, '.dsh');
}

function resolveUserDataDir({ currentDir, dshHome, standalone, edition }) {
  const primary = prepareWritableDir(currentDir);
  if (primary.ok) return { dir: currentDir, fallback: false, error: null };

  const mode = standalone ? 'app-profile' : 'electron-profile';
  const fallbackDir = path.join(dshHome, 'dsh-pet', mode, edition === 'public' ? 'public' : 'personal');
  const fallback = prepareWritableDir(fallbackDir);
  if (fallback.ok) return { dir: fallbackDir, fallback: true, error: primary.error };
  return { dir: currentDir, fallback: false, error: fallback.error };
}

module.exports = { dshHomeDir, resolveUserDataDir };
