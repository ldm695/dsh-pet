/**
 * Standalone user-data migrations.
 *
 * Keep compatibility work here so startup does not grow version-specific branches.
 * Migrations are idempotent: legacy inputs remain available until their replacement
 * has been written and verified.
 */
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
  renameSync,
  type Stats,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';

import { flattenPetList, readAllConfig, readUserConfig } from '../host/config';
import { createAiConfig, DEFAULT_AI_SETTINGS } from './ai-config';
import { loadProtectedApiKey, saveProtectedApiKey } from './api-key-store';
import { readAiSettings, writeAiSettings, writePrivateJsonAsync, writePrivateTextAsync } from './ai-storage';
import { configPathsFor } from './options';

const MAX_LEGACY_CONFIG_BYTES = 8 * 1024 * 1024;
const BACKUP_COPY_CHUNK_BYTES = 256 * 1024;
const BACKUP_COPY_ATTEMPTS = 3;
const MAX_BACKUP_MANIFEST_BYTES = 16 * 1024 * 1024;

export interface MigrationLogger {
  warn(message: string): void;
  info?(message: string): void;
}

export interface StandaloneMigrationResult {
  initialApiKey?: string;
  recoveredFromMigrationError?: boolean;
  backupDirectory?: string;
}

interface BackupFileRecord {
  path: string;
  size: number;
  sha256: string;
}

interface MigrationBackup {
  directory: string;
  fileCount: number;
  totalBytes: number;
}

interface BackupManifest {
  formatVersion: 1;
  status: 'complete';
  sourceRoot: string;
  fileCount: number;
  totalBytes: number;
  files: BackupFileRecord[];
}

interface RecoveryState {
  formatVersion: 1;
  status: 'available' | 'restoring' | 'restored';
  updatedAtUtc: string;
}

export interface MigrationRecoveryInfo {
  backupDirectory: string;
  fileCount: number;
  totalBytes: number;
}

class BackupSourceChangedError extends Error {}

function currentUserSid(): string | undefined {
  if (process.platform !== 'win32') return undefined;
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const identity = execFileSync(join(systemRoot, 'System32', 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const sid = identity.match(/\bS-1-\d+(?:-\d+)+\b/)?.[0];
  if (!sid) throw new Error('无法确定当前 Windows 用户，不能安全创建迁移备份。');
  return sid;
}

function restrictBackupPath(path: string, isDirectory: boolean, sid: string | undefined): void {
  if (process.platform !== 'win32') {
    chmodSync(path, isDirectory ? 0o700 : 0o600);
    return;
  }
  if (!sid) throw new Error('无法确定当前 Windows 用户，不能安全创建迁移备份。');
  const icacls = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe');
  const permission = isDirectory ? '(OI)(CI)F' : 'F';
  execFileSync(icacls, [path, '/inheritance:r', '/grant:r', `*${sid}:${permission}`], {
    stdio: 'pipe',
    windowsHide: true,
  });
}

function ensureBackupDirectory(path: string, sid: string | undefined): void {
  let info;
  try {
    info = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    mkdirSync(path, { mode: 0o700 });
    info = lstatSync(path);
  }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`迁移备份目录不安全：${path}`);
  restrictBackupPath(path, true, sid);
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  if (left.dev !== right.dev) return false;
  if (left.ino && right.ino) return left.ino === right.ino;
  return true;
}

function hashRegularFile(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(BACKUP_COPY_CHUNK_BYTES);
  try {
    while (true) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest('hex');
  } finally {
    closeSync(fd);
  }
}

function writeAll(fd: number, buffer: Buffer, length: number): void {
  let offset = 0;
  while (offset < length) {
    const bytesWritten = writeSync(fd, buffer, offset, length - offset, null);
    if (bytesWritten <= 0) throw new Error('迁移备份写入未能完成。');
    offset += bytesWritten;
  }
}

function copyBackupFile(
  sourcePath: string,
  destinationPath: string,
  relativePath: string,
  sid: string | undefined,
): BackupFileRecord {
  const appendOnlyLog = relativePath === 'logs.txt' || relativePath.startsWith('logs/');
  for (let attempt = 0; attempt < BACKUP_COPY_ATTEMPTS; attempt += 1) {
    let sourceFd: number | undefined;
    let destinationFd: number | undefined;
    let temporaryPath: string | undefined;
    try {
      const beforeOpen = lstatSync(sourcePath);
      if (!beforeOpen.isFile() || beforeOpen.isSymbolicLink()) {
        throw new Error(`迁移备份遇到非普通文件：${relativePath}`);
      }
      sourceFd = openSync(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = fstatSync(sourceFd);
      if (!opened.isFile() || !sameFileIdentity(beforeOpen, opened)) {
        throw new BackupSourceChangedError(`备份期间源文件发生变化：${relativePath}`);
      }

      temporaryPath = `${destinationPath}.${process.pid}.${randomUUID()}.backup.tmp`;
      destinationFd = openSync(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      restrictBackupPath(temporaryPath, false, sid);

      const hash = createHash('sha256');
      const buffer = Buffer.allocUnsafe(BACKUP_COPY_CHUNK_BYTES);
      let copiedBytes = 0;
      while (copiedBytes < opened.size) {
        const remaining = Math.min(buffer.length, opened.size - copiedBytes);
        const bytesRead = readSync(sourceFd, buffer, 0, remaining, copiedBytes);
        if (bytesRead === 0) {
          throw new BackupSourceChangedError(`备份期间源文件被截断：${relativePath}`);
        }
        const chunk = buffer.subarray(0, bytesRead);
        hash.update(chunk);
        writeAll(destinationFd, chunk, bytesRead);
        copiedBytes += bytesRead;
      }
      fsyncSync(destinationFd);

      const afterRead = fstatSync(sourceFd);
      const afterPath = lstatSync(sourcePath);
      const stableIdentity = sameFileIdentity(opened, afterRead) && sameFileIdentity(opened, afterPath);
      const stableContent = appendOnlyLog
        ? afterPath.size >= opened.size && (afterRead.size > opened.size || afterRead.mtimeMs === opened.mtimeMs)
        : afterRead.size === opened.size &&
          afterPath.size === opened.size &&
          afterRead.mtimeMs === opened.mtimeMs &&
          afterPath.mtimeMs === opened.mtimeMs;
      if (!stableIdentity || !stableContent) {
        throw new BackupSourceChangedError(`备份期间源文件持续变化：${relativePath}`);
      }

      closeSync(sourceFd);
      sourceFd = undefined;
      closeSync(destinationFd);
      destinationFd = undefined;
      renameSync(temporaryPath, destinationPath);
      temporaryPath = undefined;

      const expectedHash = hash.digest('hex');
      const savedInfo = lstatSync(destinationPath);
      if (!savedInfo.isFile() || savedInfo.size !== copiedBytes || hashRegularFile(destinationPath) !== expectedHash) {
        throw new Error(`迁移备份校验失败：${relativePath}`);
      }
      return { path: relativePath, size: copiedBytes, sha256: expectedHash };
    } catch (error) {
      if (sourceFd !== undefined) closeSync(sourceFd);
      if (destinationFd !== undefined) closeSync(destinationFd);
      if (temporaryPath && existsSync(temporaryPath)) unlinkSync(temporaryPath);
      if (error instanceof BackupSourceChangedError && attempt + 1 < BACKUP_COPY_ATTEMPTS) continue;
      throw error;
    }
  }
  throw new Error(`无法获得稳定的迁移备份快照：${relativePath}`);
}

function copyBackupTree(
  sourceDirectory: string,
  destinationDirectory: string,
  relativeDirectory: string,
  sid: string | undefined,
  files: BackupFileRecord[],
): void {
  const entries = readdirSync(sourceDirectory, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  for (const entry of entries) {
    const sourcePath = join(sourceDirectory, entry.name);
    const destinationPath = join(destinationDirectory, entry.name);
    const childRelativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    const info = lstatSync(sourcePath);
    if (info.isSymbolicLink()) throw new Error(`迁移备份拒绝跟随符号链接：${childRelativePath}`);
    if (info.isDirectory()) {
      mkdirSync(destinationPath, { mode: 0o700 });
      restrictBackupPath(destinationPath, true, sid);
      copyBackupTree(sourcePath, destinationPath, childRelativePath, sid, files);
      continue;
    }
    if (!info.isFile()) throw new Error(`迁移备份遇到不支持的文件类型：${childRelativePath}`);
    files.push(copyBackupFile(sourcePath, destinationPath, childRelativePath, sid));
  }
}

async function createFullMigrationBackup(home: string, purpose = 'migration-failure'): Promise<MigrationBackup> {
  const homeInfo = lstatSync(home);
  if (!homeInfo.isDirectory() || homeInfo.isSymbolicLink()) throw new Error(`DSH_HOME 不是安全的普通目录：${home}`);

  const sid = currentUserSid();
  const backupParent = join(home, 'dsh-pet-migration-backups');
  ensureBackupDirectory(backupParent, sid);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDirectory = join(backupParent, `${purpose}-${timestamp}-${randomUUID()}`);
  mkdirSync(backupDirectory, { mode: 0o700 });
  restrictBackupPath(backupDirectory, true, sid);
  const backedUpData = join(backupDirectory, 'dsh-pet');
  mkdirSync(backedUpData, { mode: 0o700 });
  restrictBackupPath(backedUpData, true, sid);

  const sourceRoot = join(home, 'dsh-pet');
  const files: BackupFileRecord[] = [];
  try {
    if (existsSync(sourceRoot)) {
      const sourceInfo = lstatSync(sourceRoot);
      if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) {
        throw new Error('配置根目录不是安全的普通目录。');
      }
      copyBackupTree(sourceRoot, backedUpData, '', sid, files);
    }

    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    const manifest = {
      formatVersion: 1,
      status: 'complete',
      createdAtUtc: new Date().toISOString(),
      sourceRoot,
      fileCount: files.length,
      totalBytes,
      files,
    };
    const manifestPath = join(backupDirectory, 'manifest.json');
    await writePrivateJsonAsync(manifestPath, manifest, 2);
    const writtenManifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    if (writtenManifest.status !== 'complete' || writtenManifest.fileCount !== files.length) {
      throw new Error('迁移备份清单校验失败。');
    }
    return { directory: backupDirectory, fileCount: files.length, totalBytes };
  } catch (error) {
    try {
      await writePrivateJsonAsync(join(backupDirectory, 'manifest.incomplete.json'), {
        formatVersion: 1,
        status: 'incomplete',
        createdAtUtc: new Date().toISOString(),
        sourceRoot,
        completedFileCount: files.length,
        completedBytes: files.reduce((sum, file) => sum + file.size, 0),
      });
    } catch {
      // Keep the partial directory as-is; no active configuration is reset on backup failure.
    }
    throw new Error(
      `全量迁移备份失败，部分文件位于 ${backupDirectory}：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function readBackupManifest(home: string, backupDirectory: string): BackupManifest | undefined {
  try {
    const backupParent = resolve(home, 'dsh-pet-migration-backups');
    const candidate = resolve(backupDirectory);
    const childPath = relative(backupParent, candidate);
    if (!childPath || childPath === '..' || childPath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
      return undefined;
    }
    if (dirname(candidate) !== backupParent || !/^migration-failure-[\w.-]+$/i.test(basename(candidate)))
      return undefined;
    const directoryInfo = lstatSync(candidate);
    const manifestPath = join(candidate, 'manifest.json');
    const manifestInfo = lstatSync(manifestPath);
    if (
      !directoryInfo.isDirectory() ||
      directoryInfo.isSymbolicLink() ||
      !manifestInfo.isFile() ||
      manifestInfo.isSymbolicLink()
    ) {
      return undefined;
    }
    if (manifestInfo.size > MAX_BACKUP_MANIFEST_BYTES) return undefined;
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as Partial<BackupManifest>;
    if (
      parsed.formatVersion !== 1 ||
      parsed.status !== 'complete' ||
      typeof parsed.sourceRoot !== 'string' ||
      !Number.isSafeInteger(parsed.fileCount) ||
      !Number.isSafeInteger(parsed.totalBytes) ||
      !Array.isArray(parsed.files) ||
      parsed.fileCount !== parsed.files.length
    ) {
      return undefined;
    }
    let totalBytes = 0;
    const paths = new Set<string>();
    for (const file of parsed.files) {
      if (
        typeof file?.path !== 'string' ||
        !file.path ||
        file.path.includes('\\') ||
        file.path.startsWith('/') ||
        file.path.split('/').some((part) => !part || part === '.' || part === '..') ||
        !Number.isSafeInteger(file.size) ||
        file.size < 0 ||
        !/^[a-f0-9]{64}$/.test(file.sha256) ||
        paths.has(file.path)
      ) {
        return undefined;
      }
      paths.add(file.path);
      totalBytes += file.size;
    }
    if (totalBytes !== parsed.totalBytes) return undefined;
    return parsed as BackupManifest;
  } catch {
    return undefined;
  }
}

function readRecoveryState(backupDirectory: string): RecoveryState | undefined {
  try {
    const statePath = join(backupDirectory, 'recovery-state.json');
    const info = lstatSync(statePath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16_384) return undefined;
    const parsed = JSON.parse(readFileSync(statePath, 'utf8')) as Partial<RecoveryState>;
    if (
      parsed.formatVersion !== 1 ||
      !['available', 'restoring', 'restored'].includes(String(parsed.status)) ||
      typeof parsed.updatedAtUtc !== 'string'
    ) {
      return undefined;
    }
    return parsed as RecoveryState;
  } catch {
    return undefined;
  }
}

async function writeRecoveryState(backupDirectory: string, status: RecoveryState['status']): Promise<void> {
  await writePrivateJsonAsync(join(backupDirectory, 'recovery-state.json'), {
    formatVersion: 1,
    status,
    updatedAtUtc: new Date().toISOString(),
  } satisfies RecoveryState);
}

/** Latest complete exception backup exposed to the standalone settings page. */
export function getMigrationRecovery(home: string): MigrationRecoveryInfo | undefined {
  const backupParent = join(home, 'dsh-pet-migration-backups');
  try {
    const parentInfo = lstatSync(backupParent);
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) return undefined;
    const candidates = readdirSync(backupParent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^migration-failure-[\w.-]+$/i.test(entry.name))
      .map((entry) => join(backupParent, entry.name))
      .sort((left, right) => basename(right).localeCompare(basename(left)));
    for (const directory of candidates) {
      const manifest = readBackupManifest(home, directory);
      if (!manifest) continue;
      if (readRecoveryState(directory)?.status === 'restored') return undefined;
      return { backupDirectory: resolve(directory), fileCount: manifest.fileCount, totalBytes: manifest.totalBytes };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Restore the last complete exception snapshot. Keep a verified copy of the current state first. */
export async function restoreMigrationConfiguration(home: string): Promise<MigrationRecoveryInfo> {
  const recovery = getMigrationRecovery(home);
  if (!recovery) throw new Error('没有可还原的迁移异常备份。');
  const manifest = readBackupManifest(home, recovery.backupDirectory);
  if (!manifest) throw new Error('迁移备份清单无效或已损坏，拒绝还原。');

  const homeInfo = lstatSync(home);
  if (!homeInfo.isDirectory() || homeInfo.isSymbolicLink()) throw new Error('DSH_HOME 不是安全的普通目录。');
  const backupData = join(recovery.backupDirectory, 'dsh-pet');
  const backupDataInfo = lstatSync(backupData);
  if (!backupDataInfo.isDirectory() || backupDataInfo.isSymbolicLink()) throw new Error('迁移备份中的配置目录缺失。');

  const sid = currentUserSid();
  const activeDirectory = join(home, 'dsh-pet');
  const stagingDirectory = join(home, `.dsh-pet-restore-${randomUUID()}`);
  mkdirSync(stagingDirectory, { mode: 0o700 });
  restrictBackupPath(stagingDirectory, true, sid);
  try {
    const copiedFiles: BackupFileRecord[] = [];
    copyBackupTree(backupData, stagingDirectory, '', sid, copiedFiles);
    if (copiedFiles.length !== manifest.fileCount) throw new Error('还原暂存文件数量与备份清单不一致。');
    const expected = new Map(manifest.files.map((file) => [file.path, `${file.size}:${file.sha256}`]));
    for (const file of copiedFiles) {
      if (expected.get(file.path) !== `${file.size}:${file.sha256}`) {
        throw new Error(`还原校验失败：${file.path}`);
      }
    }

    const activeInfo = existsSync(activeDirectory) ? lstatSync(activeDirectory) : undefined;
    if (activeInfo && (!activeInfo.isDirectory() || activeInfo.isSymbolicLink())) {
      throw new Error('当前桌宠配置目录不是安全的普通目录。');
    }
    await createFullMigrationBackup(home, 'restore-safety');
    const displacedDirectory = join(home, `.dsh-pet-replaced-${randomUUID()}`);
    await writeRecoveryState(recovery.backupDirectory, 'restoring');

    let displaced = false;
    try {
      if (activeInfo) {
        renameSync(activeDirectory, displacedDirectory);
        displaced = true;
      }
      renameSync(stagingDirectory, activeDirectory);
    } catch (error) {
      if (displaced && !existsSync(activeDirectory)) renameSync(displacedDirectory, activeDirectory);
      throw error;
    }

    if (displaced) {
      try {
        rmSync(displacedDirectory, { recursive: true, force: true });
      } catch {
        // A verified safety backup exists; a leftover displaced folder is harmless to the app.
      }
    }
    await writeRecoveryState(recovery.backupDirectory, 'restored').catch(() => {});
    return recovery;
  } catch (error) {
    if (existsSync(stagingDirectory)) rmSync(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
}

function copyLegacyMainConfig(userConfigPath: string, logger: MigrationLogger): void {
  const userRoot = dirname(userConfigPath);
  const legacyPath = join(userRoot, 'main-config.json');
  if (existsSync(userConfigPath) || !existsSync(legacyPath)) return;

  let sourceFd: number | undefined;
  let temporaryPath: string | undefined;
  let destinationFd: number | undefined;
  try {
    const beforeOpen = lstatSync(legacyPath);
    if (!beforeOpen.isFile() || beforeOpen.isSymbolicLink() || beforeOpen.size > MAX_LEGACY_CONFIG_BYTES) {
      throw new Error('旧主配置不是安全的普通文件，或超过大小限制。');
    }

    sourceFd = openSync(legacyPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(sourceFd);
    if (!opened.isFile() || (beforeOpen.ino && opened.ino && beforeOpen.ino !== opened.ino)) {
      throw new Error('旧主配置在读取期间发生变化。');
    }
    if (opened.size > MAX_LEGACY_CONFIG_BYTES) throw new Error('旧主配置超过大小限制。');
    const contents = readFileSync(sourceFd);
    const afterRead = fstatSync(sourceFd);
    if (contents.length !== afterRead.size || contents.length > MAX_LEGACY_CONFIG_BYTES) {
      throw new Error('旧主配置在读取期间发生变化。');
    }
    closeSync(sourceFd);
    sourceFd = undefined;

    temporaryPath = `${userConfigPath}.${process.pid}.${randomUUID()}.migration.tmp`;
    destinationFd = openSync(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeFileSync(destinationFd, contents);
    fsyncSync(destinationFd);
    closeSync(destinationFd);
    destinationFd = undefined;

    // A hard-link creation is atomic and fails if another process created the target.
    // The temporary file is on the same volume and is removed after the link succeeds.
    linkSync(temporaryPath, userConfigPath);
    unlinkSync(temporaryPath);
    temporaryPath = undefined;
    logger.info?.('已兼容上游旧主配置：复制为 main-config.jsonc，原文件保留。');
  } catch (error) {
    if (sourceFd !== undefined) closeSync(sourceFd);
    if (destinationFd !== undefined) closeSync(destinationFd);
    if (temporaryPath && existsSync(temporaryPath)) unlinkSync(temporaryPath);
    if (existsSync(userConfigPath)) return;
    logger.warn(`兼容上游旧主配置失败，原文件保留：${error instanceof Error ? error.message : String(error)}`);
    throw new Error('Cannot migrate legacy main configuration.');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSafeLegacyApiKey(value: string): boolean {
  if (!value || value.length > 4096 || value !== value.trim() || /\s/.test(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if ((code >= 0 && code <= 31) || code === 127) return false;
  }
  return true;
}

async function migrateUpstreamStandaloneApiKey(
  home: string,
  apiKeyStorePath: string,
  storedApiKey: string | undefined,
  apiKeyStoreReadFailed: boolean,
  logger: MigrationLogger,
): Promise<string | undefined> {
  const loaded = readAiSettings(home);
  if (loaded === undefined) return storedApiKey;
  if (!isRecord(loaded)) throw new Error('独立 AI 配置不是有效对象，已保留原文件。');
  if (!Object.prototype.hasOwnProperty.call(loaded, 'apiKey')) return storedApiKey;

  const legacyApiKey = loaded.apiKey;
  if (typeof legacyApiKey !== 'string') {
    throw new Error('上游独立 AI 配置中的密钥格式无效，已保留原文件。');
  }

  if (legacyApiKey && !isSafeLegacyApiKey(legacyApiKey)) {
    throw new Error('上游独立 AI 配置中的密钥不符合安全格式，已保留原文件。');
  }
  if (!legacyApiKey) {
    writeAiSettings(home, loaded);
    return storedApiKey;
  }
  if (apiKeyStoreReadFailed) {
    throw new Error('发现上游明文密钥，但现有 DPAPI 密钥存储无法读取；原配置已保留。');
  }
  if (storedApiKey && storedApiKey !== legacyApiKey) {
    throw new Error('上游配置密钥与当前 DPAPI 密钥不同；为避免覆盖任一密钥，原配置已保留。');
  }

  let protectedApiKey = storedApiKey;
  if (!protectedApiKey) {
    await saveProtectedApiKey(apiKeyStorePath, legacyApiKey);
    protectedApiKey = await loadProtectedApiKey(apiKeyStorePath);
    if (protectedApiKey !== legacyApiKey) {
      throw new Error('上游密钥加密后的回读校验失败；原配置已保留。');
    }
  }

  try {
    // writeAiSettings removes apiKey and writes the remaining settings atomically.
    writeAiSettings(home, loaded);
  } catch {
    throw new Error('上游密钥已加密保存，但无法从 JSON 配置中移除明文；原文件已保留。');
  }
  logger.info?.('已将上游独立 AI 密钥迁移到 DPAPI，并从 JSON 配置中移除明文。');
  return protectedApiKey;
}

function contextSetting(value: unknown, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function migrateMissingChatContextSettings(
  home: string,
  legacy: Record<string, unknown>,
  logger: MigrationLogger,
): void {
  try {
    const loaded = readAiSettings(home);
    const hasCurrentFile = loaded !== undefined;
    if (hasCurrentFile && !isRecord(loaded)) throw new Error('当前独立 AI 配置不是有效对象');
    const current = hasCurrentFile ? (loaded as Record<string, unknown>) : {};
    if (typeof current.apiKey === 'string' && current.apiKey.trim()) {
      throw new Error('上游明文密钥尚未迁移到 DPAPI');
    }
    if (current.apiKey !== undefined && current.apiKey !== '') throw new Error('独立 AI 密钥字段格式无效');
    const missingRounds = !Object.prototype.hasOwnProperty.call(current, 'chatMemoryRounds');
    const missingImageLimit = !Object.prototype.hasOwnProperty.call(current, 'chatImageLimit');
    if (!missingRounds && !missingImageLimit) return;

    const next: Record<string, unknown> = hasCurrentFile ? { ...current } : { ...DEFAULT_AI_SETTINGS };
    if (missingRounds) {
      next.chatMemoryRounds = contextSetting(legacy.chatMemoryRounds, DEFAULT_AI_SETTINGS.chatMemoryRounds);
    }
    if (missingImageLimit) {
      next.chatImageLimit = contextSetting(legacy.chatImageLimit, DEFAULT_AI_SETTINGS.chatImageLimit);
    }
    writeAiSettings(home, next);
    logger.info?.('已将缺失的聊天上下文设置写入独立 AI 配置。');
  } catch (error) {
    logger.warn(
      `迁移独立 AI 聊天上下文设置失败，原配置保留：${error instanceof Error ? error.message : String(error)}`,
    );
    throw new Error('Cannot migrate standalone AI chat context settings.');
  }
}

async function runStandaloneMigrations(options: {
  home: string;
  packageRoot: string;
  environmentApiKey?: string;
  logger: MigrationLogger;
}): Promise<StandaloneMigrationResult> {
  const { home, packageRoot, environmentApiKey, logger } = options;
  const paths = configPathsFor(packageRoot, home);
  if (existsSync(paths.userFile) && readUserConfig(paths) === undefined) {
    throw new Error('当前主配置文件无法解析。');
  }
  copyLegacyMainConfig(paths.userFile, logger);

  const apiKeyStorePath = join(home, 'dsh-pet', 'standalone-ai-key.dpapi');
  const aiSettingsPath = join(home, 'dsh-pet', 'standalone-ai.json');
  const hadAiSettings = existsSync(aiSettingsPath);
  let storedApiKey: string | undefined;
  let apiKeyStoreReadFailed = false;
  try {
    storedApiKey = await loadProtectedApiKey(apiKeyStorePath);
  } catch (error) {
    apiKeyStoreReadFailed = true;
    logger.warn(`读取独立 AI DPAPI 密钥失败：${error instanceof Error ? error.message : String(error)}`);
  }

  storedApiKey = await migrateUpstreamStandaloneApiKey(
    home,
    apiKeyStorePath,
    storedApiKey,
    apiKeyStoreReadFailed,
    logger,
  );

  const resolvedEnvironmentApiKey = !hadAiSettings ? environmentApiKey : undefined;
  let keepEnvironmentKeyBootstrap = false;
  if (!storedApiKey && resolvedEnvironmentApiKey && !apiKeyStoreReadFailed) {
    try {
      await saveProtectedApiKey(apiKeyStorePath, resolvedEnvironmentApiKey);
      const verifiedApiKey = await loadProtectedApiKey(apiKeyStorePath);
      if (verifiedApiKey !== resolvedEnvironmentApiKey) throw new Error('DPAPI read-back verification failed');
      storedApiKey = verifiedApiKey;
      logger.info?.('已将应用环境密钥安全保存到当前 DPAPI 存储。');
    } catch (error) {
      keepEnvironmentKeyBootstrap = true;
      logger.warn(
        `无法安全保存应用环境密钥，跳过聊天上下文迁移以保留环境变量回退：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } else if (!storedApiKey && resolvedEnvironmentApiKey && apiKeyStoreReadFailed) {
    keepEnvironmentKeyBootstrap = true;
    logger.warn('DPAPI 密钥存储读取失败，已跳过聊天上下文迁移以保留环境变量回退。');
  }

  if (!keepEnvironmentKeyBootstrap) {
    const legacyAiConfig = readAllConfig(paths).main ?? {};
    migrateMissingChatContextSettings(home, legacyAiConfig, logger);
  }

  // Validate the same inputs that the runtime will consume before declaring migration complete.
  // This catches malformed AI settings during migration, so the recovery path can back them up.
  createAiConfig(home, { initialApiKey: storedApiKey ?? resolvedEnvironmentApiKey });
  flattenPetList(readAllConfig(paths));
  return { initialApiKey: storedApiKey ?? resolvedEnvironmentApiKey };
}

async function writeSafeFallbackConfiguration(home: string, paths: ReturnType<typeof configPathsFor>): Promise<void> {
  const defaultInfo = lstatSync(paths.defaultFile);
  if (!defaultInfo.isFile() || defaultInfo.isSymbolicLink()) {
    throw new Error('安装包中的默认主配置不是安全的普通文件。');
  }
  const userDirectory = join(home, 'dsh-pet');
  try {
    mkdirSync(userDirectory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const userDirectoryInfo = lstatSync(userDirectory);
  if (!userDirectoryInfo.isDirectory() || userDirectoryInfo.isSymbolicLink()) {
    throw new Error('用户配置目录不是安全的普通目录。');
  }

  const defaultConfig = readFileSync(paths.defaultFile, 'utf8');
  await writePrivateTextAsync(paths.userFile, defaultConfig);
  writeAiSettings(home, DEFAULT_AI_SETTINGS);

  const parsedMain = readUserConfig(paths);
  if (!parsedMain) throw new Error('回退主配置写入后仍无法解析。');
  const pets = flattenPetList(readAllConfig(paths));
  if (pets.length === 0) throw new Error('回退配置没有可运行的默认桌宠。');
  const ai = createAiConfig(home, { initialApiKey: '' }).current();
  if (ai.enabled || ai.automaticWhispers || ai.apiKey) {
    throw new Error('回退独立 AI 配置未达到安全默认状态。');
  }
}

/**
 * Run migrations and recover from any migration failure as one transaction boundary:
 * first create and verify a complete private copy of DSH_HOME/dsh-pet, then write bundled
 * defaults with AI disabled. If the backup cannot be verified, leave active data untouched.
 */
export async function prepareStandaloneMigrations(options: {
  home: string;
  packageRoot: string;
  environmentApiKey?: string;
  logger: MigrationLogger;
}): Promise<StandaloneMigrationResult> {
  const { home, packageRoot, logger } = options;
  try {
    return await runStandaloneMigrations(options);
  } catch (migrationError) {
    const reason = migrationError instanceof Error ? migrationError.message : String(migrationError);
    logger.warn(`迁移过程中发生异常：${reason}；正在先备份全部用户数据，再恢复安全默认配置。`);

    const backup = await createFullMigrationBackup(home);
    const paths = configPathsFor(packageRoot, home);
    try {
      await writeSafeFallbackConfiguration(home, paths);
    } catch (fallbackError) {
      const fallbackReason = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      throw new Error(
        `迁移异常数据已完整备份到 ${backup.directory}，但安全默认配置写入失败，程序无法继续启动：${fallbackReason}`,
      );
    }

    try {
      await writeRecoveryState(backup.directory, 'available');
    } catch (stateError) {
      logger.warn(
        `备份恢复标记未能写入；设置页仍会扫描备份目录：${stateError instanceof Error ? stateError.message : String(stateError)}`,
      );
    }

    logger.warn(
      `已将迁移前的全部用户数据备份到 ${backup.directory}（${backup.fileCount} 个文件，${backup.totalBytes} 字节）；` +
        '主配置已恢复为安装包默认值，独立 AI 已关闭，可在程序启动后重新配置。',
    );
    return { recoveredFromMigrationError: true, backupDirectory: backup.directory };
  }
}
