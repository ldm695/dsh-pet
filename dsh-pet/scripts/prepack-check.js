#!/usr/bin/env node
/** Verify that the Windows application build contains only standalone runtime assets. */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const fail = (message) => {
  console.error(`[desktop-package-check] FAIL: ${message}`);
  process.exitCode = 1;
};
const ok = (message) => console.log(`[desktop-package-check] ok: ${message}`);

const required = [
  'desktop-main.cjs',
  'lib/standalone.js',
  'lib/standalone-settings.js',
  'runtime/electron-helper/main.js',
  'runtime/electron-helper/pointer-target.js',
  'runtime/electron-helper/host-liveness.js',
  'runtime/electron-helper/topmost-watchdog.js',
  'runtime/electron-helper/dpi-linearization.js',
  'runtime/electron-helper/tray-platform.js',
  'runtime/electron-helper/desktop-geometry.js',
  'runtime/electron-helper/move-targets.js',
  'runtime/electron-helper/move-ipc.js',
  'runtime/electron-helper/win32-fullscreen.js',
  'runtime/electron-helper/preload.js',
  'runtime/electron-helper/renderer.js',
  'runtime/electron-helper/shared-core.js',
  'runtime/electron-helper/index.html',
  'assets/config.jsonc',
  'assets/webm/待机呼吸休闲.webm',
];
for (const file of required) {
  existsSync(join(ROOT, file)) ? ok(`exists ${file}`) : fail(`missing ${file}`);
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
if (pkg.private === true) ok('package is private and cannot be published as a DSH Web plugin');
else fail('package.json must set private=true');
if (!pkg.dsh) ok('no DSH plugin registration metadata');
else fail('package.json still contains DSH plugin registration metadata');
if (!pkg.exports?.['./client']) ok('no browser client export');
else fail('package.json still exports a DSH Web client');
const runtimeDshDependencies = ['dependencies', 'optionalDependencies', 'peerDependencies'].flatMap((section) =>
  Object.keys(pkg[section] ?? {}).filter((name) => name.startsWith('@deepseek-ai/')),
);
if (runtimeDshDependencies.length === 0) ok('no DSH runtime dependencies are bundled into the EXE');
else fail(`DSH-only build dependencies must stay out of the EXE: ${runtimeDshDependencies.join(', ')}`);

const packagedFiles = Array.isArray(pkg.files) ? pkg.files : [];
for (const file of ['lib/standalone.js', 'lib/standalone-settings.js', 'runtime/electron-helper']) {
  if (packagedFiles.includes(file)) ok(`package file list includes ${file}`);
  else fail(`package file list is missing ${file}`);
}
for (const file of ['lib/**', 'src', 'cordis.patch.yml', 'lib/client.js', 'lib/index.js']) {
  if (packagedFiles.includes(file)) fail(`package file list must exclude ${file}`);
}
for (const file of ['cordis.patch.yml', 'tsconfig.types.json', 'scripts/gen-types.mjs', 'lib/client.js', 'lib/index.js', 'lib/types']) {
  if (existsSync(join(ROOT, file))) fail(`obsolete DSH Web source/build residue remains: ${file}`);
  else ok(`no obsolete DSH Web residue at ${file}`);
}

for (const config of ['electron-builder.yml', 'electron-builder.public.yml']) {
  const content = readFileSync(join(ROOT, config), 'utf8');
  if (content.includes('lib/**')) fail(`${config} includes all lib outputs`);
  else ok(`${config} excludes unneeded bundles`);
  if (content.includes('lib/standalone.js') && content.includes('lib/standalone-settings.js')) {
    ok(`${config} includes the EXE host and embedded settings page`);
  } else fail(`${config} is missing EXE bundles`);
  if (content.includes('cordis.patch.yml') || content.includes('lib/client.js')) {
    fail(`${config} includes a DSH Web plugin entry`);
  }
}

if (process.exitCode) console.error('\n[desktop-package-check] fix the failures before building the EXE.');
else console.log('\n[desktop-package-check] standalone package contents are ready.');
