import { z } from 'zod';
import { join } from 'node:path';
import { readAiSettings, writeAiSettings } from './ai-storage.ts';
import { saveProtectedApiKey } from './api-key-store.ts';

/**
 * 余额查询可选的服务商，空串表示不查询。
 * `deepseek-account` 不在其中：它读的是 DSH 登录态，独立模式没有账号服务，选了也只会拿到 credential-missing。
 */
export const BALANCE_PROVIDERS = ['', 'deepseek-official', 'opencode-go', 'commandcode'] as const;

/** 对外可见的设置视图：密钥只以 hasKey 表示；AI 是否可用只看地址、模型与密钥是否齐全。 */
export interface StandaloneAiPublicSettings {
  protocol: 'openai-compatible' | 'anthropic' | 'deepseek-official';
  baseUrl: string;
  model: string;
  /** 余额查询走哪个服务商的接口；空串表示不查询。与 baseUrl 无关，用于独立模式复用 host 半侧的余额定义。 */
  balanceProvider: (typeof BALANCE_PROVIDERS)[number];
  /** 兼容旧配置文件的遗留字段，已不参与任何调度；保留只为让旧文件继续通过 strict 校验。 */
  automaticWhispers: boolean;
  /** 兼容旧配置文件的遗留字段；碎碎念周期唯一来源是宠物配置的 `eventsRefreshSec.whisper`。 */
  whisperIntervalSec: number;
  /** 单次回复的输出上限（写入请求的 max_tokens）；页面不再暴露，沿用已存值或默认值。 */
  maxTokens: number;
  chatMemoryRounds: number;
  chatImageLimit: number;
  timeoutMs: number;
  hasKey: boolean;
}
/** 内部成品配置：在公开视图上补回明文密钥，以及只为文件兼容保留的启用位。 */
export type StandaloneAiSettings = Omit<StandaloneAiPublicSettings, 'hasKey'> & {
  apiKey: string;
  /** 兼容旧配置文件的遗留字段，恒为 true；旧文件里的 false 读入后即被覆盖。 */
  enabled: boolean;
};

export const DEFAULT_AI_SETTINGS: Readonly<StandaloneAiSettings> = Object.freeze({
  protocol: 'openai-compatible',
  baseUrl: '',
  model: '',
  balanceProvider: '',
  enabled: true,
  automaticWhispers: false,
  whispersOnlyOffPeak: false,
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
  /** 余额查询的服务商；空串表示不查询。 */
  balanceProvider: z.enum(BALANCE_PROVIDERS),
  /** 只为旧文件兼容保留：保存时一律写 true，可用性由地址、模型与密钥决定。 */
  enabled: z.boolean(),
  automaticWhispers: z.boolean(),
  whispersOnlyOffPeak: z.boolean(),
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

/**
 * 校验未知输入并合并到上一份成品配置。
 * @param input - 调用方给出的补丁，可能只含部分字段。
 * @param previous - 上一份成品配置，用作未提供字段的基线。
 * @returns 校验并合并后的新的成品配置。
 * @throws 字段越界，或清空与写入密钥同时出现时。
 */
export function validateSettings(input: unknown, previous: Readonly<StandaloneAiSettings>): StandaloneAiSettings {
  try {
    const patch = patchSchema.parse(input);
    if (patch.clearApiKey && patch.apiKey) throw new Error('Conflicting key changes');
    const { clearApiKey, ...values } = patch;
    const apiKey = clearApiKey ? '' : values.apiKey || previous.apiKey;
    // 配置填一半只是暂时不可用，不该连保存都拒绝；启用位不再有语义，一律写回 true。
    return persistedSchema.parse({ ...previous, ...values, apiKey, enabled: true });
  } catch {
    throw new Error('Invalid standalone AI settings.');
  }
}

/** 去掉密钥与启用位，只保留是否已保存密钥。 */
function redact(settings: Readonly<StandaloneAiSettings>): StandaloneAiPublicSettings {
  const { apiKey, enabled, ...publicFields } = settings;
  // 启用位只为旧文件保留，不进对外视图；解构出来显式丢弃，否则 lint 会当成未使用变量。
  void enabled;
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

export function createAiConfig(home: string, options: AiConfigOptions = {}): AiConfigStore {
  const apiKeyStorePath = options.apiKeyStorePath ?? join(home, 'dsh-pet', 'standalone-ai-key.dpapi');
  const initial = {
    ...DEFAULT_AI_SETTINGS,
    apiKey: options.initialApiKey?.trim() ?? '',
  };
  let settings: Readonly<StandaloneAiSettings> = Object.freeze(initial);
  try {
    const loaded = readAiSettings(home);
    // 旧配置文件没有后加的字段，先铺默认值再校验；否则升级后 strict 校验会拒绝整个文件，独立模式起不来。
    if (loaded !== undefined)
      settings = Object.freeze(
        validateSettings(persistedSchema.parse({ ...DEFAULT_AI_SETTINGS, ...loaded }), DEFAULT_AI_SETTINGS),
      );
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
