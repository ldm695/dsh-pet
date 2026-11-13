/** Discover model IDs from a configured OpenAI-compatible, Anthropic, or official DeepSeek endpoint. */
import type { StandaloneAiSettings } from './ai-config';
import type { AiFetch } from './ai-transport';

export interface DiscoveredModel {
  id: string;
  name: string;
}

export type ModelDiscoveryResult =
  | { ok: true; models: DiscoveredModel[] }
  | { ok: false; code: string; message: string };

export interface ModelDiscoveryInput {
  protocol?: string;
  baseUrl?: string;
  apiKey?: string;
}

const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const PAGE_LIMIT = 1000;
const FAILURES: Record<string, string> = {
  input: '请先填写有效的接口地址与 API 密钥。',
  auth: '身份验证失败 (HTTP 401/403)：请检查 API 密钥。',
  'rate-limit': '请求受限 (HTTP 429)：请检查账户余额或调用频率。',
  'not-found': '该地址未提供模型列表 (HTTP 404)：请检查接口地址。',
  contract: '端点没有返回可识别的模型清单。',
  timeout: '拉取模型列表超时，请检查网络或服务器状态。',
  network: '无法连接到目标服务器，请检查地址与端口。',
  http: '接口请求失败，请检查地址与凭据。',
};

function failure(code: string): ModelDiscoveryResult {
  return { ok: false, code, message: FAILURES[code] ?? FAILURES.http! };
}

function parseEndpoint(raw: string): string | undefined {
  if (!raw || raw !== raw.trim() || /[\\\s]/.test(raw)) return undefined;
  try {
    const url = new URL(raw);
    if (url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol)) {
      return undefined;
    }
    return (url.origin + url.pathname).replace(/\/+$/, '');
  } catch {
    return undefined;
  }
}

function candidates(protocol: string, base: string): string[] {
  if (protocol === 'anthropic') {
    const versioned = /\/v\d+$/.test(base);
    return [`${versioned ? base : `${base}/v1`}/models?limit=${PAGE_LIMIT}`];
  }
  if (/\/v\d+$/.test(base)) return [`${base}/models`];
  return [`${base}/models`, `${base}/v1/models`];
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asEntries(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (object(value)) {
    const values = Object.values(value);
    return values.length ? values : undefined;
  }
  return undefined;
}

function findEntries(payload: unknown): unknown[] | undefined {
  if (!object(payload)) return undefined;
  const data = payload.data;
  if (Array.isArray(data)) return data;
  if (object(data)) {
    const nested = asEntries(data.models);
    if (nested) return nested;
    const values = Object.values(data);
    if (values.length > 0) return values;
  }
  return asEntries(payload.models);
}

function normalize(entries: readonly unknown[]): DiscoveredModel[] {
  const ids = new Set<string>();
  const models: DiscoveredModel[] = [];
  for (const entry of entries) {
    if (!object(entry) || typeof entry.id !== 'string') continue;
    const id = entry.id.trim();
    if (!id || ids.has(id)) continue;
    ids.add(id);
    const label = [entry.name, entry.display_name].find((value) => typeof value === 'string' && value.trim());
    models.push({ id, name: typeof label === 'string' ? label.trim() : id });
  }
  return models;
}

async function readBounded(response: Response): Promise<string | undefined> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

/** Fetches model IDs using the unsaved settings draft; credentials never enter errors or logs. */
export async function discoverModels(
  fetcher: AiFetch,
  current: Readonly<StandaloneAiSettings>,
  input: ModelDiscoveryInput,
  signal?: AbortSignal,
): Promise<ModelDiscoveryResult> {
  const protocol = typeof input.protocol === 'string' ? input.protocol : current.protocol;
  if (!['openai-compatible', 'anthropic', 'deepseek-official'].includes(protocol)) return failure('input');
  const draftBase = typeof input.baseUrl === 'string' ? input.baseUrl.trim() : '';
  const base = parseEndpoint(draftBase || current.baseUrl);
  const draftKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  const apiKey = (draftKey || current.apiKey).trim();
  if (!base || !apiKey || /[\u0000-\u0020\u007f]/.test(apiKey)) return failure('input');
  if (protocol === 'deepseek-official' && base !== 'https://api.deepseek.com') return failure('input');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const abort = (): void => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const headers = new Headers({ accept: 'application/json' });
  if (protocol === 'anthropic') {
    headers.set('x-api-key', apiKey);
    headers.set('anthropic-version', '2023-06-01');
  } else {
    headers.set('authorization', `Bearer ${apiKey}`);
  }
  try {
    for (const url of candidates(protocol, base)) {
      let response: Response;
      try {
        response = await fetcher(url, { method: 'GET', headers, signal: controller.signal, redirect: 'error' });
      } catch {
        return failure(controller.signal.aborted ? 'timeout' : 'network');
      }
      if (response.status === 404) continue;
      if (response.status === 401 || response.status === 403) return failure('auth');
      if (response.status === 429) return failure('rate-limit');
      if (!response.ok) return failure('http');
      const text = await readBounded(response);
      if (text === undefined) return failure('contract');
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        return failure('contract');
      }
      const entries = findEntries(payload);
      return entries ? { ok: true, models: normalize(entries) } : failure('contract');
    }
    return failure('not-found');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    controller.abort();
  }
}
