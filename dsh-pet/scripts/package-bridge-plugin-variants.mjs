import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const upstreamIcon = join(projectRoot, 'assets', 'logo-rounded.png');
const personalIcon = join(projectRoot, 'assets', 'dsh-pet-icon-16.png');
const releaseRoot = join(projectRoot, 'release', 'bridge-plugin-variants');
const buildId = new Date().toISOString().replaceAll(/[-:.TZ]/g, '');
const outputRoot = join(releaseRoot, buildId);

const plugins = [
  {
    directory: 'dsh-pet-work-status-bridge',
    source: join(projectRoot, 'dsh-pet-work-status-bridge'),
    kind: 'dsh',
    manifest: 'package.json',
    getVersion: (manifest) => manifest.version,
  },
  {
    directory: 'codex-pet-work-status-bridge',
    source: join(projectRoot, 'codex-pet-work-status-bridge'),
    kind: 'codex',
    manifest: join('.codex-plugin', 'plugin.json'),
    getVersion: (manifest) => manifest.version,
  },
  {
    directory: 'claude-code-pet-work-status-bridge',
    source: join(projectRoot, 'claude-code-pet-work-status-bridge'),
    kind: 'claude',
    manifest: join('.claude-plugin', 'plugin.json'),
    getVersion: (manifest) => manifest.version,
  },
];

async function setVariantIcon(pluginDirectory, plugin, variant) {
  const iconSource = variant === 'personal' ? personalIcon : upstreamIcon;
  const manifestPath = join(pluginDirectory, plugin.manifest);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

  if (plugin.kind === 'dsh') {
    // DSH reads the package-level icon field, which already points to icon.png.
    await cp(iconSource, join(pluginDirectory, 'icon.png'));
    return plugin.getVersion(manifest);
  }

  const assetsDirectory = join(pluginDirectory, 'assets');
  await mkdir(assetsDirectory, { recursive: true });
  await cp(iconSource, join(assetsDirectory, 'logo.png'));

  if (plugin.kind === 'codex') {
    manifest.interface ??= {};
    manifest.interface.composerIcon = './assets/logo.png';
    manifest.interface.logo = './assets/logo.png';
  } else {
    // Claude Code ignores this field locally; it is retained for plugin listings.
    manifest.icon = './assets/logo.png';
  }

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return plugin.getVersion(manifest);
}

await mkdir(releaseRoot, { recursive: true });
await mkdir(outputRoot, { recursive: false });

for (const variant of ['personal', 'public']) {
  const variantOutput = join(outputRoot, variant);
  await mkdir(variantOutput, { recursive: false });

  for (const plugin of plugins) {
    const stageRoot = await mkdtemp(join(tmpdir(), 'dsh-pet-bridge-plugin-'));
    try {
      const stagedPlugin = join(stageRoot, plugin.directory);
      await cp(plugin.source, stagedPlugin, { recursive: true });
      const version = await setVariantIcon(stagedPlugin, plugin, variant);
      const suffix = variant === 'personal' ? '-personal' : '';
      const archivePath = join(
        variantOutput,
        `${plugin.directory}-${version}${suffix}.zip`,
      );

      execFileSync(
        'tar',
        ['-a', '-c', '-f', archivePath, '-C', stageRoot, plugin.directory],
        { stdio: 'inherit' },
      );
      console.log(`[package:bridge-plugins] ${variant}: ${archivePath}`);
    } finally {
      // Staging copies are created by this script and contain no user data.
      await rm(stageRoot, { recursive: true, force: true });
    }
  }
}

console.log(`[package:bridge-plugins] Complete. Output: ${outputRoot}`);
