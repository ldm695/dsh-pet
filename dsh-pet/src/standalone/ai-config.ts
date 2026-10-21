import { z } from 'zod';
import { join } from 'node:path';
import { saveProtectedApiKey } from './api-key-store';
import { readAiSettings, writeAiSettings } from './ai-storage';

export interface StandaloneAiPublicSettings {
  protocol: 'openai-compatible' | 'anthropic' | 'deepseek-official';
  baseUrl: string;
  model: string;
  enabled: boolean;
  automaticWhispers: boolean;
  whisperIntervalSec: number;
  maxTokens: number;
  chatMemoryRounds: number;
  chatImageLimit: number;
  timeoutMs: number;
  hasKey: boolean;
}
export type StandaloneAiSettings = Omit<StandaloneAiPublicSettings, 'hasKey'> & { apiKey: string };

export const DEFAULT_AI_SETTINGS: Readonly<StandaloneAiSettings> = Object.freeze({
  protocol: 'openai-compatible',
  baseUrl: '',
  model: '',
  enabled: false,
  automaticWhispers: false,
  whisperIntervalSec: 300,
  maxTokens: 1024,
  chatMemoryRounds: 5,
  chatImageLimit: 10,
  timeoutMs: 30_000,
  apiKey: '',
});

function safeEndpoint(value: string): boolean {
  if (!value) return true;
  if (value !== value.trim() || /[\s\\]/.test(value)) return false;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || value.includes('?') || value.includes('#')) {
      return false;
    }
    return ['http:', 'https:'].includes(url.protocol);
  } catch {
    return false;
  }
}

function containsControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if ((code >= 0 && code <= 31) || code === 127) return true;
  }
  return false;
}

const fields = {
  protocol: z.enum(['openai-compatible', 'anthropic', 'deepseek-official']),
  baseUrl: z.string().max(2048).refine(safeEndpoint),
  model: z
    .string()
    .trim()
    .max(200)
    .refine((s) => !containsControlChar(s)),
  enabled: z.boolean(),
  automaticWhispers: z.boolean(),
  whisperIntervalSec: z.number().int().min(60).max(86400),
  maxTokens: z.number().int().min(128).max(4096),
  chatMemoryRounds: z.number().min(0),
  chatImageLimit: z.number().min(0),
  timeoutMs: z.number().int().min(1000).max(60_000),
  apiKey: z
    .string()
    .max(4096)
    .refine((s) => !containsControlChar(s) && !/\s/.test(s)),
};
const persistedSchema = z.object(fields).strict();
const patchSchema = persistedSchema.partial().extend({ clearApiKey: z.boolean().optional() }).strict();

export function validateSettings(input: unknown, previous: Readonly<StandaloneAiSettings>): StandaloneAiSettings {
  try {
    const patch = patchSchema.parse(input);
    if (patch.clearApiKey && patch.apiKey) throw new Error('Conflicting key changes');
    const { clearApiKey, ...values } = patch;
    const apiKey = clearApiKey ? '' : values.apiKey || previous.apiKey;
    const next = persistedSchema.parse({ ...previous, ...values, apiKey });
    if (next.protocol === 'deepseek-official' && next.baseUrl !== 'https://api.deepseek.com') {
      throw new Error('DeepSeek official API must use its official endpoint.');
    }
    if (next.enabled && (!next.model || !next.baseUrl || !next.apiKey)) throw new Error('Incomplete settings');
    return next;
  } catch {
    throw new Error('Invalid standalone AI settings.');
  }
}

function redact(settings: Readonly<StandaloneAiSettings>): StandaloneAiPublicSettings {
  const { apiKey, ...publicFields } = settings;
  return { ...publicFields, hasKey: apiKey.length > 0 };
}

export interface AiConfigStore {
  current(): Readonly<StandaloneAiSettings>;
  publicSettings(): StandaloneAiPublicSettings;
  save(input: unknown): Promise<StandaloneAiPublicSettings>;
}

export interface AiConfigOptions {
  /** Loaded from the current per-user DPAPI store. */
  initialApiKey?: string;
  apiKeyStorePath?: string;
}

function contextSetting(value: unknown, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Copy .11's global chat context values into standalone AI settings exactly once. */
export function migrateMissingChatContextSettings(
  home: string,
  legacy: Record<string, unknown>,
  logger: { warn(message: string): void; info?(message: string): void },
): void {
  try {
    const loaded = readAiSettings(home);
    const hasCurrentFile = loaded !== undefined;
    if (hasCurrentFile && (!loaded || typeof loaded !== 'object' || Array.isArray(loaded))) {
      throw new Error('Current standalone AI settings are not an object');
    }
    const current = hasCurrentFile ? (loaded as Record<string, unknown>) : {};
    if (typeof current.apiKey === 'string' && current.apiKey.trim()) {
      throw new Error('Legacy plaintext API key requires migration by version .11');
    }
    if (current.apiKey !== undefined && current.apiKey !== '') {
      throw new Error('Unexpected legacy API key value');
    }
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
    logger.warn(`迁移独立 AI 聊天上下文设置失败，原配置保留：${error instanceof Error ? error.message : String(error)}`);
    throw new Error('Cannot migrate standalone AI chat context settings.');
  }
}

export function createAiConfig(home: string, options: AiConfigOptions = {}): AiConfigStore {
  const apiKeyStorePath = options.apiKeyStorePath ?? join(home, 'dsh-pet', 'standalone-ai-key.dpapi');
  const initial = {
    ...DEFAULT_AI_SETTINGS,
    apiKey: options.initialApiKey?.trim() ?? '',
  };
  let settings: Readonly<StandaloneAiSettings> = Object.freeze(initial);
  try {
    const loaded = readAiSettings(home);
    if (loaded !== undefined) {
      // Never fall back to a key from JSON; only the current DPAPI store or allowed
      // environment bootstrap may supply the credential.
      settings = Object.freeze(
        validateSettings({ ...(loaded as Record<string, unknown>), apiKey: initial.apiKey }, initial),
      );
    }
  } catch {
    throw new Error('Cannot securely load standalone AI settings.');
  }
  return {
    current: () => settings,
    publicSettings: () => redact(settings),
    async save(input) {
      const next = validateSettings(input, settings);
      try {
        // Keep the credential protected by Windows DPAPI. If settings persistence fails after
        // changing the key, restore the prior credential before surfacing the error.
        await saveProtectedApiKey(apiKeyStorePath, next.apiKey || undefined);
        try {
          writeAiSettings(home, next);
        } catch (error) {
          await saveProtectedApiKey(apiKeyStorePath, settings.apiKey || undefined).catch(() => {});
          throw error;
        }
      } catch {
        throw new Error('Cannot securely save standalone AI settings.');
      }
      settings = Object.freeze(next);
      return redact(settings);
    },
  };
}
