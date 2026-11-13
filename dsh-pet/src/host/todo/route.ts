/** 用户待办的 HTTP/bridge 业务路由，共用持久化服务。 */
import type { RouteHandler, RouteRequest, RouteResult } from '../route-contract';
import type { LoggerLike } from '../log-file';
import { normalizeTodoDueAt, normalizeTodoText, TODO_BODY_MAX_BYTES, TODO_TEXT_MAX } from './types';
import type { TodoStore } from './store';

const bad = (message: string, status = 200): RouteResult => ({
  kind: 'json', status, obj: { ok: false, message },
});

function parseBody(body: string | undefined): Record<string, unknown> | null {
  if (!body || Buffer.byteLength(body, 'utf8') > TODO_BODY_MAX_BYTES) return null;
  try {
    const value: unknown = JSON.parse(body);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 创建 GET/POST /todos 与 PATCH/DELETE /todos/{id} 路由。 */
export function createTodoRoute(deps: { todos: TodoStore; log: LoggerLike }): RouteHandler {
  const { todos, log } = deps;
  return async (request: RouteRequest): Promise<RouteResult | undefined> => {
    const { body, method, rest } = request;
    if (rest !== 'todos' && !rest.startsWith('todos/')) return undefined;
    try {
      if (rest === 'todos') {
        if (method === 'GET') return { kind: 'json', status: 200, obj: { ok: true, todos: await todos.list() } };
        if (method !== 'POST') return bad('仅支持 GET 或 POST。', 405);
        const raw = parseBody(body);
        if (!raw) return bad('请求 JSON 无效或超过 16 KiB。', body && Buffer.byteLength(body) > TODO_BODY_MAX_BYTES ? 413 : 400);
        const text = normalizeTodoText(raw.text);
        if (!text) return bad(`正文必须是非空文本，最多 ${TODO_TEXT_MAX} 个字符。`);
        const due = normalizeTodoDueAt(raw.dueAt);
        if (!due.ok) return bad('到期时间必须是毫秒时间戳或 null。');
        return { kind: 'json', status: 200, obj: { ok: true, todo: await todos.create({ text, dueAt: due.value }) } };
      }

      const id = rest.slice('todos/'.length);
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return bad('待办编号无效。');
      if (method === 'DELETE') return { kind: 'json', status: 200, obj: { ok: true, removed: await todos.remove(id) } };
      if (method !== 'PATCH') return bad('仅支持 PATCH 或 DELETE。', 405);
      const raw = parseBody(body);
      if (!raw) return bad('请求 JSON 无效或超过 16 KiB。', body && Buffer.byteLength(body) > TODO_BODY_MAX_BYTES ? 413 : 400);
      const patch: { text?: string; dueAt?: number | null; done?: boolean } = {};
      if (Object.prototype.hasOwnProperty.call(raw, 'text')) {
        const text = normalizeTodoText(raw.text);
        if (!text) return bad(`正文必须是非空文本，最多 ${TODO_TEXT_MAX} 个字符。`);
        patch.text = text;
      }
      if (Object.prototype.hasOwnProperty.call(raw, 'dueAt')) {
        const due = normalizeTodoDueAt(raw.dueAt);
        if (!due.ok) return bad('到期时间必须是毫秒时间戳或 null。');
        patch.dueAt = due.value;
      }
      if (Object.prototype.hasOwnProperty.call(raw, 'done')) {
        if (typeof raw.done !== 'boolean') return bad('完成状态必须是布尔值。');
        patch.done = raw.done;
      }
      if (Object.keys(patch).length === 0) return bad('没有可更新的字段。');
      const todo = await todos.update(id, patch);
      return todo ? { kind: 'json', status: 200, obj: { ok: true, todo } } : bad('找不到这条待办。');
    } catch (error) {
      log.warn?.(`[dsh-pet] 待办读写失败：${error instanceof Error ? error.message : String(error)}`);
      return bad('待办读写失败。');
    }
  };
}
