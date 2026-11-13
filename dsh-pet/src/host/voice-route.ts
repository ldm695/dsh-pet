/**
 * 语音 API：校验路由方法与 JSON，并将合成结果映射为 MP3 文件或结构化错误。
 * 合成、排队和缓存由 voice 服务负责；此模块不直接访问网络或文件系统。
 * @module dsh-pet/src/host/voice-route
 */
import type { RouteRequest, RouteResult } from './route-contract';
import type { VoiceService } from './voice/speak';

/** 创建语音 API 路由处理器。 */
export function createVoiceRoute(voice: VoiceService): (request: RouteRequest) => Promise<RouteResult | undefined> {
  return async ({ rest, method, body }) => {
    if (rest === 'voice/voices') {
      if (method !== 'GET') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
      return { kind: 'json', status: 200, obj: { ok: true, voices: voice.listVoices() } };
    }
    if (rest !== 'voice/speak') return undefined;
    if (method !== 'POST') return { kind: 'json', status: 405, obj: { error: 'method not allowed' } };
    let input: unknown;
    try {
      input = JSON.parse(body ?? 'null');
    } catch {
      return { kind: 'json', status: 400, obj: { ok: false, reason: 'bad-request', message: 'invalid JSON body' } };
    }
    const result = await voice.speak(input);
    return result.ok
      ? { kind: 'file', file: result.file, contentType: 'audio/mpeg' }
      : { kind: 'json', status: 200, obj: result };
  };
}
