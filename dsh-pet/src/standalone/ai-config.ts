import { z } from 'zod';
import { join } from 'node:path';
import { saveProtectedApiKey } from './api-key-store';
import { readAiSettings, writeAiSettings } from './ai-storage';

export interface StandaloneAiPublicSettings {
  protocol: 'openai-compatible' | 'anthropic';
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
  protocol: z.enum(['openai-compatible', 'anthropic']),
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
  /** Loaded from the per-user DPAPI store (or migrated from the previous DeepSeek-only store). */
  initialApiKey?: string;
  apiKeyStorePath?: string;
  initialChatMemoryRounds?: number;
  initialChatImageLimit?: number;
}

export function createAiConfig(home: string, options: AiConfigOptions = {}): AiConfigStore {
  const apiKeyStorePath = options.apiKeyStorePath ?? join(home, 'dsh-pet', 'standalone-ai-key.dpapi');
  const initial = {
    ...DEFAULT_AI_SETTINGS,
    chatMemoryRounds: Number.isFinite(options.initialChatMemoryRounds) && (options.initialChatMemoryRounds as number) >= 0 ? options.initialChatMemoryRounds as number : DEFAULT_AI_SETTINGS.chatMemoryRounds,
    chatImageLimit: Number.isFinite(options.initialChatImageLimit) && (options.initialChatImageLimit as number) >= 0 ? options.initialChatImageLimit as number : DEFAULT_AI_SETTINGS.chatImageLimit,
    apiKey: options.initialApiKey?.trim() ?? '',
  };
  let settings: Readonly<StandaloneAiSettings> = Object.freeze(initial);
  try {
    const loaded = readAiSettings(home);
    if (loaded !== undefined) {
      // Older experimental builds stored the key in the JSON file. Prefer the DPAPI key; only
      // accept the legacy field as a one-time migration source, then the next save removes it.
      const legacyKey =
        loaded && typeof loaded === 'object' && typeof (loaded as Record<string, unknown>).apiKey === 'string'
          ? String((loaded as Record<string, unknown>).apiKey)
          : '';
      settings = Object.freeze(
        validateSettings({ ...(loaded as Record<string, unknown>), apiKey: initial.apiKey || legacyKey }, initial),
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
