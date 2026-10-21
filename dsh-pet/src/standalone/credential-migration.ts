/** One-time migration of legacy standalone AI credentials into DPAPI-protected storage. */
import { lstat, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { readAiSettings, writeAiSettings } from './ai-storage';
import { loadProtectedApiKey, saveProtectedApiKey } from './api-key-store';

export interface CredentialMigrationLogger {
  warn(message: string): void;
  info?(message: string): void;
}

export interface CredentialMigrationResult {
  /** The verified active key, if the new protected store contains one. */
  apiKey?: string;
}

async function regularFileExists(path: string): Promise<boolean> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('not a regular file');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function keyStoreExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return regularFileExists(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function persistAndVerify(path: string, key: string): Promise<void> {
  await saveProtectedApiKey(path, key);
  const restored = await loadProtectedApiKey(path);
  if (restored !== key.trim()) throw new Error('DPAPI read-back verification failed');
}

function validApiKey(value: string): boolean {
  const key = value.trim();
  return key.length <= 4096 && !/[\s\u0000-\u001f\u007f]/.test(key);
}

async function backupPath(home: string): Promise<string> {
  const directory = join(home, 'dsh-pet');
  const base = join(directory, 'standalone-ai-key-legacy');
  for (let suffix = 0; suffix < 100; suffix += 1) {
    const path = `${base}${suffix ? `-${suffix}` : ''}.dpapi`;
    if (!(await keyStoreExists(path))) return path;
  }
  throw new Error('No free protected legacy key archive path');
}

/**
 * Migrate old values once and then stop reading the legacy formats on normal startup.
 * A differing plaintext key is preserved in a separate encrypted archive instead of
 * replacing the current key. Source files are only rewritten after DPAPI verification.
 */
export async function migrateLegacyStandaloneAiCredentials(
  home: string,
  logger: CredentialMigrationLogger,
): Promise<CredentialMigrationResult> {
  const directory = join(home, 'dsh-pet');
  const protectedPath = join(directory, 'standalone-ai-key.dpapi');
  const oldDeepSeekPath = join(directory, 'deepseek-api-key.dpapi');

  let settings: unknown;
  try {
    settings = readAiSettings(home);
  } catch (error) {
    logger.warn(`无法安全检查旧独立 AI 设置，保留原文件：${error instanceof Error ? error.message : String(error)}`);
    return {};
  }

  let activeKey: string | undefined;
  let protectedStoreExists = false;
  try {
    protectedStoreExists = await keyStoreExists(protectedPath);
    if (protectedStoreExists) activeKey = await loadProtectedApiKey(protectedPath);
  } catch (error) {
    logger.warn(`读取独立 AI 的 DPAPI 密钥失败，保留所有旧凭据：${error instanceof Error ? error.message : String(error)}`);
    // A present but unreadable new store is authoritative. Do not overwrite it from an older source.
    protectedStoreExists = true;
  }

  const settingsObject = settings && typeof settings === 'object' && !Array.isArray(settings)
    ? settings as Record<string, unknown>
    : undefined;
  const legacyJsonKey = typeof settingsObject?.apiKey === 'string' ? settingsObject.apiKey.trim() : '';
  if (legacyJsonKey && !validApiKey(legacyJsonKey)) {
    logger.warn('旧 JSON 密钥格式不符合当前规则，保留原设置文件并跳过该密钥迁移。');
  }

  // The old JSON key was the source used by the experimental standalone AI settings. It
  // takes precedence only while no protected key store exists, matching the former loader.
  if (!protectedStoreExists && legacyJsonKey && validApiKey(legacyJsonKey)) {
    try {
      await persistAndVerify(protectedPath, legacyJsonKey);
      activeKey = legacyJsonKey;
      protectedStoreExists = true;
      logger.info?.('已将旧独立 AI 密钥迁移到当前用户 DPAPI 存储。');
    } catch (error) {
      logger.warn(`迁移旧独立 AI 密钥失败，明文设置保持原样：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // The old DeepSeek-only DPAPI file is consulted only when the new store is absent.
  if (!protectedStoreExists) {
    try {
      if (await keyStoreExists(oldDeepSeekPath)) {
        const oldKey = await loadProtectedApiKey(oldDeepSeekPath);
        if (oldKey) {
          await persistAndVerify(protectedPath, oldKey);
          activeKey = oldKey;
          protectedStoreExists = true;
          logger.info?.('已将旧 DeepSeek 密钥迁移到独立 AI 的 DPAPI 存储。');
        }
      }
    } catch (error) {
      logger.warn(`迁移旧 DeepSeek DPAPI 密钥失败，旧文件已保留：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Clear the legacy plaintext field only after its value is protected and verified.
  // If it differs from the active value, retain it as a separate DPAPI archive first.
  if (settingsObject && Object.prototype.hasOwnProperty.call(settingsObject, 'apiKey')) {
    const rawLegacyValue = settingsObject.apiKey;
    if (typeof rawLegacyValue !== 'string') {
      logger.warn('旧 JSON 密钥字段格式异常，保留原设置文件并跳过密钥迁移。');
    } else {
      const legacyValue = rawLegacyValue.trim();
      const validLegacyValue = validApiKey(legacyValue);
      let canScrub = !legacyValue;
      if (legacyValue && !validLegacyValue) {
        logger.warn('旧 JSON 密钥格式不符合当前规则，保留原设置文件并跳过密钥迁移。');
      } else if (legacyValue && activeKey === legacyValue) {
        canScrub = true;
      } else if (legacyValue) {
        try {
          const archive = await backupPath(home);
          await persistAndVerify(archive, legacyValue);
          canScrub = true;
          logger.info?.('已将与当前密钥不同的旧 JSON 密钥另存为加密归档。');
        } catch (error) {
          logger.warn(`无法安全归档旧 JSON 密钥，明文仍保留在原设置中：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (canScrub) {
        try {
          writeAiSettings(home, settingsObject);
          logger.info?.('已从独立 AI 设置文件中移除明文密钥字段。');
        } catch (error) {
          logger.warn(`无法安全移除旧 JSON 明文密钥，原设置文件已保留：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }

  return { apiKey: activeKey };
}
