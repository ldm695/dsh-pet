import { z } from 'zod';
import type { StandaloneLogger } from './context';
import { createAiConfig, validateSettings } from './ai-config';
import type { StandaloneAiPublicSettings, StandaloneAiSettings } from './ai-config';
import { isAuthenticationFailure, isRateLimitFailure, sdkTextStream } from './ai-transport';
import type { AiFetch, AiRequest, AiTransportEvent } from './ai-transport';

const PROVIDER = 'standalone';
const MAX_INPUT_CHARS = 32_768;
const MAX_OUTPUT_CHARS = 16_384;
const MAX_EVENTS = 4096;
const REQUESTS_PER_MINUTE = 6;
const RATE_WINDOW_MS = 60_000;
const testInputSchema = z
  .object({
    protocol: z.enum(['openai-compatible', 'anthropic', 'deepseek-official']).optional(),
    baseUrl: z.string().max(2048).optional(),
    model: z.string().max(200).optional(),
    apiKey: z.string().max(4096).optional(),
  })
  .strict();
const textBlock = z.object({ type: z.literal('text'), text: z.string().max(MAX_INPUT_CHARS) });
const messageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.union([z.string().max(MAX_INPUT_CHARS), z.array(z.unknown()).max(128)]),
});
const inputSchema = z.object({
  provider: z.enum([PROVIDER, 'deepseek-official']),
  model: z.string().max(200),
  system: z.string().max(MAX_INPUT_CHARS).optional(),
  messages: z.array(messageSchema).min(1).max(64),
  signal: z.custom<AbortSignal>((value) => value instanceof AbortSignal).optional(),
});

export interface StandaloneAiService {
  currentSelection(): { provider: string; model: string };
  listProviders(): Array<{ id: string; name: string }>;
  listModels(provider: string): Promise<Array<{ id: string; name: string }>>;
  resolveModelInfo(
    provider?: string,
    model?: string,
    signal?: AbortSignal,
  ): Promise<undefined | { id: string; name: string }>;
  stream(options: unknown): AsyncIterable<{ type: 'text'; text: string }>;
  getSettings(): StandaloneAiPublicSettings;
  saveSettings(input: unknown): Promise<StandaloneAiPublicSettings>;
  testConnection(input: {
    protocol?: string;
    baseUrl?: string;
    model?: string;
    apiKey?: string;
  }): Promise<{ ok: boolean; message: string; reply?: string }>;
  isReady(): boolean;
  supportsBalance(): boolean;
  canWhisper(): boolean;
  deepSeekApiKey(): string | undefined;
  dispose(): void;
}
/** Optional third argument is an isolated transport/clock seam; production uses official SDKs. */
export interface StandaloneAiDependencies {
  fetch?: AiFetch;
  now?: () => number;
  initialApiKey?: string;
  apiKeyStorePath?: string;
  initialChatMemoryRounds?: number;
  initialChatImageLimit?: number;
}

function parseRequest(
  options: unknown,
  settings: Readonly<ReturnType<ReturnType<typeof createAiConfig>['current']>>,
): { request: AiRequest; signal?: AbortSignal } {
  const parsed = inputSchema.safeParse(options);
  const endpoint = parsed.success ? new URL(settings.baseUrl) : undefined;
  const deepSeekProvider =
    parsed.success &&
    parsed.data.provider === 'deepseek-official' &&
    endpoint?.hostname === 'api.deepseek.com' &&
    (settings.protocol === 'deepseek-official' || settings.protocol === 'openai-compatible');
  if (!parsed.success || parsed.data.model !== settings.model || (parsed.data.provider !== PROVIDER && !deepSeekProvider))
    throw new Error('Invalid standalone AI model selection or input.');
  const { data } = parsed;
  const messages = data.messages
    .map((message) => ({
      role: message.role,
      content:
        typeof message.content === 'string'
          ? message.content
          : message.content
              .map((block) => {
                // Unknown/non-text blocks and DSH source metadata never cross the API boundary.
                if (typeof block !== 'object' || block === null || !('type' in block) || block.type !== 'text')
                  return '';
                const result = textBlock.safeParse(block);
                if (!result.success) throw new Error('Invalid standalone AI text input.');
                return result.data.text;
              })
              .join(''),
    }))
    .filter((message) => message.content.trim().length > 0);
  const system = data.system ?? '';
  const size = system.length + messages.reduce((sum, message) => sum + message.content.length, 0);
  if (
    size > MAX_INPUT_CHARS ||
    messages.length === 0 ||
    messages[0].role !== 'user' ||
    messages[messages.length - 1]?.role !== 'user'
  ) {
    throw new Error('Standalone AI input is empty or exceeds limits.');
  }
  return { request: { system, messages }, signal: data.signal };
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('Standalone AI request cancelled.'));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error('Standalone AI request cancelled.'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function numericStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || !('status' in error)) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

function networkCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export function createStandaloneAi(
  home: string,
  logger: StandaloneLogger,
  dependencies: StandaloneAiDependencies = {},
): StandaloneAiService {
  let store: ReturnType<typeof createAiConfig>;
  try {
    store = createAiConfig(home, {
      initialApiKey: dependencies.initialApiKey,
      apiKeyStorePath: dependencies.apiKeyStorePath,
      initialChatMemoryRounds: dependencies.initialChatMemoryRounds,
      initialChatImageLimit: dependencies.initialChatImageLimit,
    });
  } catch {
    logger.error('Cannot securely load standalone AI settings.');
    // Corrupt/insecure persistence must never enable ambient or old credentials.
    throw new Error('Cannot securely load standalone AI settings.');
  }
  const fetcher = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
  const now = dependencies.now ?? Date.now;
  let disposed = false;
  let paused = false;
  let saving = false;
  let requests: ReadonlyArray<number> = [];
  let active: AbortController | undefined;
  const ready = () =>
    !disposed &&
    !paused &&
    !saving &&
    store.current().enabled &&
    !!store.current().model &&
    !!store.current().baseUrl &&
    !!store.current().apiKey;
  const selection = () => ({
    // Balance checks use the selected provider and saved credential even when chat is disabled.
    provider: store.current().protocol === 'deepseek-official' ? 'deepseek-official' : PROVIDER,
    model: ready() ? store.current().model : '',
  });

  async function* stream(options: unknown): AsyncIterable<{ type: 'text'; text: string }> {
    if (!ready()) throw new Error('Standalone AI is not ready. Configure and enable the model first.');
    const settings = store.current();
    const { request, signal: callerSignal } = parseRequest(options, settings);
    if (callerSignal?.aborted) throw new Error('Standalone AI request cancelled.');
    if (active) throw new Error('Standalone AI is busy. Please wait.');
    const recent = requests.filter((time) => now() - time < RATE_WINDOW_MS);
    if (recent.length >= REQUESTS_PER_MINUTE) throw new Error('Standalone AI rate limit reached. Please wait.');
    requests = [...recent, now()];
    const controller = new AbortController();
    active = controller;
    const abort = () => controller.abort();
    callerSignal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, settings.timeoutMs);
    const iterator = sdkTextStream(settings, request, controller.signal, fetcher)[Symbol.asyncIterator]();
    let emitted = 0;
    let events = 0;
    try {
      while (true) {
        const part: IteratorResult<AiTransportEvent> = await abortable(iterator.next(), controller.signal);
        if (controller.signal.aborted || !ready()) throw new Error('Standalone AI request cancelled.');
        if (part.done) break;
        if (++events > MAX_EVENTS) throw new Error('Standalone AI response exceeds limits.');
        if (part.value.refusal) throw new Error('Standalone AI could not answer this request.');
        const text = part.value.text;
        if (!text) continue;
        emitted += text.length;
        if (emitted > MAX_OUTPUT_CHARS) throw new Error('Standalone AI response exceeds limits.');
        yield { type: 'text', text };
      }
      if (emitted === 0) throw new Error('Standalone AI returned no text.');
    } catch (error) {
      if (isAuthenticationFailure(error)) {
        paused = true;
        logger.warn('Standalone AI authentication failed; save settings again to resume.');
        throw new Error('Standalone AI authentication failed. Check credentials and save settings again.', {
          cause: error,
        });
      }
      if (controller.signal.aborted) {
        throw new Error('Standalone AI request cancelled or timed out.', { cause: error });
      }
      if (isRateLimitFailure(error)) {
        throw new Error('Standalone AI provider rate limit reached. Please wait.', { cause: error });
      }
      // Only our fixed messages are safe; never propagate SDK errors, URLs, headers, or bodies.
      if (
        error instanceof Error &&
        [
          'Standalone AI could not answer this request.',
          'Standalone AI returned no text.',
          'Standalone AI response exceeds limits.',
        ].includes(error.message)
      )
        throw error;
      logger.warn('Standalone AI request failed.');
      throw new Error('Standalone AI request failed. Check the endpoint and model settings.', { cause: error });
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', abort);
      controller.abort();
      if (active === controller) active = undefined;
      // return() may await a pending transport read. Observe it, but never block cancellation.
      void iterator.return?.().catch(() => logger.debug('Standalone AI transport closed.'));
    }
  }

  return {
    currentSelection: selection,
    listProviders: () => {
      if (!ready()) return [];
      const providers = [{ id: PROVIDER, name: '独立模式 AI' }];
      if (store.current().protocol === 'deepseek-official') {
        providers.push({ id: 'deepseek-official', name: 'DeepSeek' });
      }
      return providers;
    },
    listModels: async (provider) =>
      ready() &&
      (provider === PROVIDER || (provider === 'deepseek-official' && store.current().protocol === 'deepseek-official'))
        ? [{ id: settingsModel(), name: settingsModel() }]
        : [],
    resolveModelInfo: async (provider = PROVIDER, model = settingsModel(), signal) =>
      ready() &&
      !signal?.aborted &&
      (provider === PROVIDER || (provider === 'deepseek-official' && store.current().protocol === 'deepseek-official')) &&
      model === settingsModel()
        ? { id: model, name: model }
        : undefined,
    stream,
    getSettings: () => store.publicSettings(),
    async saveSettings(input) {
      if (disposed) throw new Error('Standalone AI is disposed.');
      if (saving) throw new Error('Standalone AI settings are being saved.');
      saving = true;
      active?.abort();
      try {
        const result = await store.save(input);
        if (!disposed) paused = false;
        return result;
      } catch (error) {
        paused = true;
        throw error;
      } finally {
        saving = false;
      }
    },
    isReady: ready,
    supportsBalance: () => store.current().protocol === 'deepseek-official',
    async testConnection(input: { protocol?: string; baseUrl?: string; model?: string; apiKey?: string }) {
      if (disposed) return { ok: false, message: '服务已关闭' };
      const current = store.current();
      const parsedInput = testInputSchema.safeParse(input);
      if (!parsedInput.success) return { ok: false, message: '测试参数无效：请检查协议、地址、模型名称与密钥。' };
      const draft = parsedInput.data;
      let testSettings: StandaloneAiSettings;
      try {
        testSettings = validateSettings(
          {
            ...current,
            protocol: draft.protocol ?? current.protocol,
            baseUrl: draft.baseUrl?.trim() ?? current.baseUrl,
            model: draft.model?.trim() ?? current.model,
            apiKey: draft.apiKey?.trim() || current.apiKey,
            enabled: true,
            automaticWhispers: false,
            maxTokens: 128,
            timeoutMs: 15_000,
          },
          current,
        );
      } catch {
        return { ok: false, message: '测试参数无效：请检查协议、地址、模型名称与密钥。' };
      }

      if (!testSettings.baseUrl) {
        return { ok: false, message: '请先填写接口地址（Base URL）' };
      }
      if (!testSettings.model) {
        return { ok: false, message: '请先填写模型名称' };
      }
      if (!testSettings.apiKey) {
        return { ok: false, message: '请先填写 API 密钥' };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        const testStream = sdkTextStream(
          testSettings,
          { system: '', messages: [{ role: 'user', content: 'hi' }] },
          controller.signal,
          fetcher,
        );
        let reply = '';
        for await (const chunk of testStream) {
          if (chunk.refusal) {
            return { ok: false, message: '模型拒绝回答该测试请求' };
          }
          if (chunk.text) {
            reply += chunk.text;
            if (reply.length >= 40) break;
          }
        }
        if (!reply.trim()) {
          return { ok: true, message: '连接成功！接口已成功响应。', reply: '(模型返回了空白内容)' };
        }
        return { ok: true, message: '连接成功！模型响应正常。', reply: reply.trim() };
      } catch (error) {
        if (controller.signal.aborted) {
          return { ok: false, message: '连接超时（15 秒未响应）：请检查网络连通性或服务器状态' };
        }
        if (isAuthenticationFailure(error)) {
          return { ok: false, message: '身份验证失败 (HTTP 401/403)：请检查 API 密钥是否正确' };
        }
        if (isRateLimitFailure(error)) {
          return { ok: false, message: '请求受限或配额超限 (HTTP 429)：请检查 API 账户余额或调用频率' };
        }
        const status = numericStatus(error);
        if (status === 404) {
          return { ok: false, message: '接口路径或模型不存在 (HTTP 404)：请检查接口地址（通常以 /v1 结尾）与模型名称' };
        }
        if (
          ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH'].includes(networkCode(error) ?? '') ||
          (error instanceof Error && error.message === 'fetch failed')
        ) {
          return { ok: false, message: '无法连接到目标服务器：请检查地址与端口是否正确、服务器是否正在运行' };
        }
        return { ok: false, message: '连接失败：请检查接口兼容性、服务器状态与网络设置。' };
      } finally {
        clearTimeout(timer);
      }
    },
    canWhisper: () => ready() && store.current().automaticWhispers,
    deepSeekApiKey: () =>
      store.current().protocol === 'deepseek-official'
        ? store.current().apiKey
        : undefined,
    dispose() {
      disposed = true;
      active?.abort();
    },
  };
  function settingsModel(): string {
    return store.current().model;
  }
}
