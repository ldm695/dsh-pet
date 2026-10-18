/** DeepSeek API adapter for the standalone host. Credentials stay in the host process. */

export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-flash';
const API_BASE = 'https://api.deepseek.com';

let savedApiKey: string | undefined;

/** 初始化由 DPAPI 加密保存的凭据；调用方在创建独立上下文前 await。 */
export function initializeSavedDeepSeekApiKey(key: string | undefined): void {
  savedApiKey = key?.trim() || undefined;
}

/** UI 保存 / 清除时更新当前进程内凭据，不需要重启桌宠。 */
export function setSavedDeepSeekApiKey(key: string | undefined): void {
  savedApiKey = key?.trim() || undefined;
}

/** Prefer the app-specific variable so the key is not coupled to unrelated tools. */
export function deepseekApiKey(): string | undefined {
  const key = process.env.DSH_PET_STANDALONE_DEEPSEEK_API_KEY ?? process.env.DEEPSEEK_API_KEY;
  const normalized = key?.trim();
  return normalized || savedApiKey;
}

export function deepseekApiKeySource(): 'environment' | 'saved' | 'none' {
  const envKey = process.env.DSH_PET_STANDALONE_DEEPSEEK_API_KEY ?? process.env.DEEPSEEK_API_KEY;
  if (envKey?.trim()) return 'environment';
  return savedApiKey ? 'saved' : 'none';
}

export function deepseekCurrentModel(): string {
  return process.env.DSH_PET_STANDALONE_DEEPSEEK_MODEL?.trim() || DEFAULT_DEEPSEEK_MODEL;
}

/** Resolve the API model catalog for diagnostics or host consumers. */
export async function deepseekModels(apiKey: string): Promise<unknown[]> {
  const response = await fetch(`${API_BASE}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) return [];
  const body = (await response.json()) as { data?: unknown };
  if (!Array.isArray(body.data)) return [];
  return body.data.filter(
    (item): item is Record<string, unknown> => item !== null && typeof item === 'object' && typeof item.id === 'string',
  );
}

interface ChatRequest {
  provider?: unknown;
  model?: unknown;
  messages?: unknown;
  system?: unknown;
  temperature?: unknown;
  signal?: unknown;
}

function textContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (part === null || typeof part !== 'object') return '';
      const item = part as { type?: unknown; text?: unknown };
      return item.type === 'text' && typeof item.text === 'string' ? item.text : '';
    })
    .join('');
}

function apiError(status: number, body: string): Error {
  let message = body;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } | string; message?: unknown };
    const error = parsed.error;
    const candidate = typeof error === 'string' ? error : (error?.message ?? parsed.message);
    if (typeof candidate === 'string') message = candidate;
  } catch {
    // Keep a short response excerpt when the server did not return JSON.
  }
  return new Error(`DeepSeek API HTTP ${status}${message ? `: ${message.slice(0, 400)}` : ''}`);
}

function messagesFor(request: ChatRequest): Array<{ role: string; content: string }> {
  const result: Array<{ role: string; content: string }> = [];
  if (typeof request.system === 'string' && request.system.trim()) {
    result.push({ role: 'system', content: request.system });
  }
  if (Array.isArray(request.messages)) {
    for (const raw of request.messages) {
      if (raw === null || typeof raw !== 'object') continue;
      const message = raw as { role?: unknown; content?: unknown };
      if (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'system') continue;
      const content = textContent(message.content);
      if (content) result.push({ role: message.role, content });
    }
  }
  return result;
}

/**
 * OpenAI-compatible DeepSeek streaming adapter. Errors are thrown while iterating,
 * matching the host's `for await` error handling contract.
 */
export function streamDeepSeekChat(apiKey: string | undefined, rawRequest: unknown): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
      if (!apiKey) throw new Error('未配置 DeepSeek API Key；请设置 DSH_PET_STANDALONE_DEEPSEEK_API_KEY');
      const request = (rawRequest ?? {}) as ChatRequest;
      if (request.provider !== 'deepseek-official') {
        throw new Error(`独立模式暂不支持模型服务商：${String(request.provider ?? 'unknown')}`);
      }
      const model =
        typeof request.model === 'string' && request.model.trim() ? request.model.trim() : deepseekCurrentModel();
      const messages = messagesFor(request);
      if (messages.length === 0) throw new Error('DeepSeek API 请求缺少对话内容');
      const signal = request.signal instanceof AbortSignal ? request.signal : AbortSignal.timeout(60_000);
      const response = await fetch(`${API_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({
          model,
          messages,
          stream: true,
          thinking: { type: 'disabled' },
          temperature: typeof request.temperature === 'number' ? request.temperature : 1,
        }),
        signal,
      });
      if (!response.ok) throw apiError(response.status, await response.text());
      if (!response.body) throw new Error('DeepSeek API 未返回响应流');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const consumeEvent = (event: string): { text?: string; done?: boolean; error?: Error } => {
        const data = event
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (!data) return {};
        if (data === '[DONE]') return { done: true };
        try {
          const payload = JSON.parse(data) as {
            error?: { message?: unknown } | string;
            choices?: Array<{ delta?: { content?: unknown }; message?: { content?: unknown } }>;
          };
          if (payload.error) {
            const message = typeof payload.error === 'string' ? payload.error : payload.error.message;
            return { error: new Error(typeof message === 'string' ? message : 'DeepSeek API 返回错误') };
          }
          const choice = payload.choices?.[0];
          const content = choice?.delta?.content ?? choice?.message?.content;
          return typeof content === 'string' && content ? { text: content } : {};
        } catch (error) {
          return {
            error: new Error(
              `DeepSeek API 返回无效 SSE 数据：${error instanceof Error ? error.message : String(error)}`,
            ),
          };
        }
      };

      try {
        while (true) {
          const { value, done } = await reader.read();
          buffer += decoder.decode(value, { stream: !done });
          let boundary = buffer.search(/\r?\n\r?\n/);
          while (boundary >= 0) {
            const event = buffer.slice(0, boundary);
            const delimiter = buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0] ?? '\n\n';
            buffer = buffer.slice(boundary + delimiter.length);
            const parsed = consumeEvent(event);
            if (parsed.error) throw parsed.error;
            if (parsed.text) yield { type: 'text', text: parsed.text };
            if (parsed.done) return;
            boundary = buffer.search(/\r?\n\r?\n/);
          }
          if (done) break;
        }
        if (buffer.trim()) {
          const parsed = consumeEvent(buffer);
          if (parsed.error) throw parsed.error;
          if (parsed.text) yield { type: 'text', text: parsed.text };
        }
      } finally {
        reader.releaseLock();
      }
    },
  };
}
