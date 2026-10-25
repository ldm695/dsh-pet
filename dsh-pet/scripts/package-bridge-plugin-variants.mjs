import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicIconRelativePath = join('assets', 'logo-rounded.png');
const personalIcon = join(projectRoot, 'assets', 'dsh-pet-icon-256.png');
const variantFlagIndex = process.argv.indexOf('--variant');
const variantArg = process.argv.find((arg) => arg.startsWith('--variant='))?.slice('--variant='.length)
  ?? (variantFlagIndex >= 0 ? process.argv[variantFlagIndex + 1] : undefined)
  ?? 'public';
if (!['public', 'personal'].includes(variantArg)) {
  throw new Error(`Unsupported plugin package variant: ${variantArg}`);
}
const gitRoot = variantArg === 'public'
  ? resolve(execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: projectRoot,
    encoding: 'utf8',
  }).trim())
  : null;
const releaseRoot = variantArg === 'personal'
  ? join(projectRoot, 'local-only', 'bridge-plugin-variants')
  : join(projectRoot, 'release', 'bridge-plugin-variants');
const buildId = new Date().toISOString().replaceAll(/[-:.TZ]/g, '');
const outputRoot = join(releaseRoot, buildId);

const plugins = [
  {
    directory: 'dsh-pet-work-status-bridge',
    source: join(projectRoot, 'dsh-pet-work-status-bridge'),
    kind: 'dsh',
    manifest: 'package.json',
    publicFiles: [
      'package.json',
      'index.js',
      'client.js',
      'cordis.patch.yml',
      'icon.png',
      'README.md',
    ],
    getVersion: (manifest) => manifest.version,
  },
  {
    directory: 'codex-pet-work-status-bridge',
    source: join(projectRoot, 'codex-pet-work-status-bridge'),
    kind: 'codex',
    manifest: join('.codex-plugin', 'plugin.json'),
    publicFiles: [
      'README.md',
      '.codex-plugin/plugin.json',
      'hooks/hooks.json',
      'hooks/bridge.cjs',
    ],
    getVersion: (manifest) => manifest.version,
  },
  {
    directory: 'claude-code-pet-work-status-bridge',
    source: join(projectRoot, 'claude-code-pet-work-status-bridge'),
    kind: 'claude',
    manifest: join('.claude-plugin', 'plugin.json'),
    publicFiles: [
      'README.md',
      '.claude-plugin/plugin.json',
      'hooks/hooks.json',
      'hooks/bridge.cjs',
    ],
    getVersion: (manifest) => manifest.version,
  },
];

async function assertTrackedPublicFile(sourceRoot, relativePath) {
  const sourcePath = join(sourceRoot, relativePath);
  const repoRelativePath = relative(gitRoot, sourcePath);
  if (!repoRelativePath || repoRelativePath === '..' || repoRelativePath.startsWith(`..${sep}`)) {
    throw new Error(`Public plugin file escapes the repository: ${relativePath}`);
  }

  const indexEntry = execFileSync(
    'git',
    ['ls-files', '--stage', '--error-unmatch', '--', repoRelativePath.split(sep).join('/')],
    { cwd: gitRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
  const match = indexEntry.match(/^([0-7]{6}) [0-9a-f]+ 0\t/);
  if (!match || !['100644', '100755'].includes(match[1])) {
    throw new Error(`Public plugin file must be a tracked regular file: ${repoRelativePath}`);
  }

  const segments = repoRelativePath.split(sep);
  let currentPath = gitRoot;
  for (const [index, segment] of segments.entries()) {
    currentPath = join(currentPath, segment);
    const info = await lstat(currentPath);
    const isFile = index === segments.length - 1;
    if (info.isSymbolicLink() || (isFile ? !info.isFile() || info.nlink > 1 : !info.isDirectory())) {
      throw new Error(`Public plugin file has an unsafe path or file type: ${repoRelativePath}`);
    }
  }

  return sourcePath;
}

async function copyPublicFiles(plugin, destination) {
  for (const relativePath of plugin.publicFiles) {
    const sourcePath = await assertTrackedPublicFile(plugin.source, relativePath);
    const destinationPath = join(destination, relativePath);
    await mkdir(dirname(destinationPath), { recursive: true });
    await cp(sourcePath, destinationPath, { force: false, errorOnExist: true });
  }
}

async function assertPublicStageContents(stagedPlugin, plugin) {
  const expectedFiles = new Set(plugin.publicFiles);
  if (plugin.kind !== 'dsh') expectedFiles.add('assets/logo.png');

  const actualFiles = [];
  async function visit(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        throw new Error(`Public plugin staging contains a symbolic link: ${relativePath}`);
      }
      if (entry.isDirectory()) {
        await visit(join(directory, entry.name), relativePath);
      } else if (entry.isFile()) {
        actualFiles.push(relativePath);
      } else {
        throw new Error(`Public plugin staging contains an unsupported entry: ${relativePath}`);
      }
    }
  }

  await visit(stagedPlugin);
  const unexpected = actualFiles.filter((file) => !expectedFiles.has(file));
  const missing = [...expectedFiles].filter((file) => !actualFiles.includes(file));
  if (unexpected.length || missing.length) {
    throw new Error(
      `Public plugin staging file list mismatch for ${plugin.directory}; `
      + `unexpected: ${unexpected.join(', ') || '(none)'}; `
      + `missing: ${missing.join(', ') || '(none)'}`,
    );
  }
}

async function setVariantIcon(pluginDirectory, plugin, variant) {
  const iconSource = variant === 'personal'
    ? personalIcon
    : await assertTrackedPublicFile(projectRoot, publicIconRelativePath);
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

for (const variant of [variantArg]) {
  const variantOutput = join(outputRoot, variant);
  await mkdir(variantOutput, { recursive: false });

  for (const plugin of plugins) {
    const stageRoot = await mkdtemp(join(tmpdir(), 'dsh-pet-bridge-plugin-'));
    try {
      const stagedPlugin = join(stageRoot, plugin.directory);
      if (variant === 'public') {
        await mkdir(stagedPlugin, { recursive: false });
        await copyPublicFiles(plugin, stagedPlugin);
      } else {
        // Preserve the existing personal package contents and path behavior.
        await cp(plugin.source, stagedPlugin, { recursive: true });
      }
      const version = await setVariantIcon(stagedPlugin, plugin, variant);
      if (variant === 'public') await assertPublicStageContents(stagedPlugin, plugin);
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
