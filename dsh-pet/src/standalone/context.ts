/**
 * 独立模式的伪 Cordis 上下文 —— 让插件的**宿主半边**在 DSH 之外跑起来。
 *
 * 为什么不重写一份路由表：宿主半边（`src/host/index.ts` 的 `apply`）已经把路由表、
 * 配置聚合、状态仓、桌面 Helper 与 bridge 管道全写好了，它对外只要求一个 Cordis `ctx`。
 * 仓库自己的 `src/host/routes.test.ts` 早就用同一个手法（最小 ctx + `apply`）在 DSH 之外
 * 跑这份路由；独立模式把那套手法产品化：DSH 的服务换成本机适配器，
 * `apply` 注册的 prefix handler 接到一个真正的 `node:http` 服务器上（见 `./server`）。
 *
 * 收益：插件以后新增或修改任何端点，独立模式自动跟着变 —— 只有一份路由表，
 * 不存在"第二套实现对不上"的漂移（这正是 `routes.test.ts` 开头记的那类事故）。
 *
 * 独立服务的边界（都是显式失败，不假装成功）：
 *   - `agentDefaultModel.currentSelection()` → 默认使用 `deepseek-official` 和独立版默认模型
 *     → 未配置 Key 时余额路由命中明确的凭证缺失分支
 *   - `credentials.resolve()` → 仅解析 DeepSeek API Key，其他凭据仍为 `undefined`
 *   - `llm.*` → DeepSeek 官方 API；未配置 Key 时生成调用明确失败
 *   - `on(...)` → 不订阅任何事件：独立模式没有 DSH 会话，工作状态因此保持空闲
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { saveDeepSeekApiKey } from './api-key-store';
import {
  deepseekApiKey,
  deepseekApiKeySource,
  deepseekCurrentModel,
  deepseekModels,
  setSavedDeepSeekApiKey,
  streamDeepSeekChat,
} from './deepseek';

/** 独立模式下模型及余额路由使用的 DeepSeek 官方 API 服务商 id。 */
export const STANDALONE_PROVIDER = 'deepseek-official';

/** 独立模式的日志接口（与插件对 `ctx.logger` 的使用面一致） */
export interface StandaloneLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

/** 插件注册到 `ctx.webServer` 的一条路由（字段原样保留，独立模式只做前缀匹配） */
export interface RegisteredRoute {
  /** `prefix`（插件当前只用这一种）或 `exact`，原样透传 */
  kind: string;
  /** 路由路径，例如 `/dsh-pet-7340`；独立模式按它做前缀匹配，不自己硬编码前缀 */
  path: string;
  /** 真实 Node HTTP handler：自己写响应头与 body（与 DSH WebServer 的契约一致） */
  handler: (req: IncomingMessage, res: ServerResponse) => unknown;
}

export interface StandaloneContextOptions {
  /** 插件用它拼桌面 Helper 的 `DSH_PET_CONFIG_URL`；传函数可拿到"监听后才确定"的端口 */
  port: number | (() => number);
  logger: StandaloneLogger;
  /** 注入路由收集数组（独立模式先起服务拿到端口，再 `apply`，两者共用同一个数组） */
  routes?: RegisteredRoute[];
  /** Windows DPAPI 加密凭据文件；不配置时 API Key 只能来自环境变量 */
  apiKeyStorePath?: string;
  /** Electron 硬件/软件合成偏好文件；保存后需重启 Electron Helper 生效 */
  renderModeStorePath?: string;
}

export interface StandaloneContext {
  /** 交给 `apply()` 的伪 ctx */
  ctx: Record<string, unknown>;
  /** `apply()` 期间注册的路由（按注册顺序） */
  routes: RegisteredRoute[];
  /** 初始化期间被记录下来的异常（每项都已按 DSH 的 effect 隔离口径打了日志） */
  failures: string[];
  /** 释放全部 effect：停桌面 Helper、清掉周期定时器 */
  dispose(): Promise<void>;
}

/** 默认日志器：直接写控制台，格式与插件自身的 `[dsh-pet]` 前缀区分开 */
export function createStandaloneLogger(): StandaloneLogger {
  const stamp = (): string => new Date().toISOString().replace('T', ' ').slice(0, 19);
  const write = (level: string, message: string): void => {
    console.log(`[dsh-pet-standalone ${stamp()}] ${level} ${message}`);
  };
  return {
    info: (message) => write('INFO ', message),
    warn: (message) => write('WARN ', message),
    error: (message) => write('ERROR', message),
    debug: (message) => {
      if (process.env.DSH_PET_STANDALONE_DEBUG === '1') write('DEBUG', message);
    },
  };
}

/**
 * 建一个独立模式的伪 ctx。
 * @param options 端口（或端口取值函数）、日志器与可选的路由收集数组
 * @returns 伪 ctx、路由列表、初始化失败记录与释放函数
 */
export function createStandaloneContext(options: StandaloneContextOptions): StandaloneContext {
  const { logger } = options;
  let apiKey = deepseekApiKey();
  const routes = options.routes ?? [];
  const failures: string[] = [];
  /** effect 释放函数（后注册先释放，与 Cordis 的逆序释放一致） */
  const disposers: Array<() => unknown> = [];
  let disposed = false;

  const portOf = (): number => (typeof options.port === 'function' ? options.port() : options.port);

  if (options.apiKeyStorePath) {
    routes.push({
      kind: 'exact',
      path: '/dsh-pet-7340/api-key',
      handler: async (req, res) => {
        const send = (status: number, body: unknown): void => {
          const payload = JSON.stringify(body);
          res.writeHead(status, {
            'content-type': 'application/json; charset=utf-8',
            'content-length': Buffer.byteLength(payload),
            'cache-control': 'no-store',
          });
          res.end(payload);
        };
        if (req.method === 'GET') {
          send(200, { configured: Boolean(apiKey), source: deepseekApiKeySource() });
          return;
        }
        if (req.method !== 'POST') {
          send(405, { error: 'Method not allowed' });
          return;
        }
        if (deepseekApiKeySource() === 'environment') {
          send(409, { error: '当前 API Key 由环境变量提供，请修改启动环境变量。' });
          return;
        }
        const contentLength = Number(req.headers['content-length'] ?? 0);
        if (contentLength > 8192) {
          send(413, { error: 'API Key 请求内容过大。' });
          req.resume();
          return;
        }
        const rawBody = await new Promise<string | undefined>((resolve, reject) => {
          let body = '';
          let tooLarge = false;
          req.setEncoding('utf8');
          req.on('data', (chunk: string) => {
            if (tooLarge) return;
            body += chunk;
            if (Buffer.byteLength(body) > 8192) {
              tooLarge = true;
              body = '';
            }
          });
          req.once('end', () => resolve(tooLarge ? undefined : body));
          req.once('error', reject);
        });
        if (rawBody === undefined) {
          send(413, { error: 'API Key 请求内容过大。' });
          return;
        }
        let request: { apiKey?: unknown };
        try {
          request = JSON.parse(rawBody) as { apiKey?: unknown };
        } catch {
          send(400, { error: '无效的 JSON 请求。' });
          return;
        }
        const next = typeof request.apiKey === 'string' ? request.apiKey.trim() : '';
        if (next.length > 4096) {
          send(400, { error: 'API Key 长度超出限制。' });
          return;
        }
        await saveDeepSeekApiKey(options.apiKeyStorePath as string, next || undefined);
        apiKey = next || undefined;
        setSavedDeepSeekApiKey(apiKey);
        send(200, { configured: Boolean(apiKey), source: deepseekApiKeySource() });
      },
    });
  }

  if (options.renderModeStorePath) {
    const modeOf = (): 'hardware' | 'software' =>
      process.env.DSH_PET_RENDER_MODE === 'software' ? 'software' : 'hardware';
    const sendRenderMode = (res: ServerResponse, status: number, body: unknown): void => {
      const payload = JSON.stringify(body);
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(payload),
        'cache-control': 'no-store',
      });
      res.end(payload);
    };
    routes.push({
      kind: 'exact',
      path: '/dsh-pet-7340/render-mode',
      handler: async (req, res) => {
        const storePath = options.renderModeStorePath as string;
        let savedMode = modeOf();
        try {
          const stored = JSON.parse(await readFile(storePath, 'utf8')) as { renderMode?: unknown };
          if (stored.renderMode === 'hardware' || stored.renderMode === 'software') savedMode = stored.renderMode;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            logger.warn(`读取渲染模式设置失败：${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (req.method === 'GET') {
          sendRenderMode(res, 200, { renderMode: savedMode, activeMode: modeOf() });
          return;
        }
        if (req.method !== 'POST') {
          sendRenderMode(res, 405, { error: 'Method not allowed' });
          return;
        }
        const contentLength = Number(req.headers['content-length'] ?? 0);
        if (contentLength > 1024) {
          sendRenderMode(res, 413, { error: '渲染模式请求内容过大。' });
          req.resume();
          return;
        }
        const rawBody = await new Promise<string | undefined>((resolve, reject) => {
          let body = '';
          let tooLarge = false;
          req.setEncoding('utf8');
          req.on('data', (chunk: string) => {
            if (tooLarge) return;
            body += chunk;
            if (Buffer.byteLength(body) > 1024) {
              tooLarge = true;
              body = '';
            }
          });
          req.once('end', () => resolve(tooLarge ? undefined : body));
          req.once('error', reject);
        });
        if (rawBody === undefined) {
          sendRenderMode(res, 413, { error: '渲染模式请求内容过大。' });
          return;
        }
        let request: { renderMode?: unknown };
        try {
          request = JSON.parse(rawBody) as { renderMode?: unknown };
        } catch {
          sendRenderMode(res, 400, { error: '无效的 JSON 请求。' });
          return;
        }
        if (request.renderMode !== 'hardware' && request.renderMode !== 'software') {
          sendRenderMode(res, 400, { error: '无效的渲染模式。' });
          return;
        }
        const temporary = `${storePath}.${process.pid}.tmp`;
        await mkdir(dirname(storePath), { recursive: true });
        await writeFile(temporary, JSON.stringify({ renderMode: request.renderMode }), {
          encoding: 'utf8',
          mode: 0o600,
        });
        await rename(temporary, storePath);
        sendRenderMode(res, 200, {
          renderMode: request.renderMode,
          activeMode: modeOf(),
          restartRequired: request.renderMode !== modeOf(),
        });
      },
    });
  }

  const webServer = {
    /** 读取时取值：服务先监听、端口确定后才 apply，插件在 launchHelper 里读到的就是真端口 */
    get port(): number {
      return portOf();
    },
    register(spec: RegisteredRoute): () => void {
      routes.push({ kind: spec.kind, path: spec.path, handler: spec.handler });
      return () => {
        const index = routes.findIndex((route) => route.handler === spec.handler);
        if (index >= 0) routes.splice(index, 1);
      };
    },
  };

  const context: Record<string, unknown> = {
    /**
     * 与 Cordis 同语义：跑一次注册函数并收集它返回的释放函数。
     * 单项失败按 DSH 的 effect 隔离口径处理：记录 + 打日志，不让整个插件起不来
     * （源码形态下包内 assets 不可达时，正是这里会抛）。
     */
    effect(fn: () => unknown): unknown {
      try {
        const dispose = fn();
        if (typeof dispose === 'function') disposers.push(dispose as () => unknown);
        return dispose;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(message);
        logger.error(`初始化某项失败（已跳过）：${message}`);
        return undefined;
      }
    },
    /** 独立模式没有 DSH 会话事件：不订阅，工作状态保持空闲 */
    on(): () => void {
      return () => {};
    },
    logger,
    webServer,
    /**
     * 独立模式没有 DSH 的浏览器会话闸门（`./server` 只按前缀匹配路由，裸地址本来就可达），
     * 所以没有令牌可加，原样返回 baseUrl —— 与 DSH 侧 `ctx.connection.authenticatedUrl(baseUrl)`
     * （附加本进程启动令牌，供桌面 Helper 的「打开网站」用）语义对应，只是这一步在独立模式下恒等。
     */
    connection: { authenticatedUrl: (baseUrl: string): string => baseUrl },
    commands: { register: (): (() => void) => () => {} },
    agentDefaultModel: {
      currentSelection: (): { provider: string; model: string } => ({
        provider: STANDALONE_PROVIDER,
        model: deepseekCurrentModel(),
      }),
    },
    credentials: {
      resolve: async (ref: unknown): Promise<{ value: string } | undefined> => {
        const name = typeof ref === 'string' ? ref : (ref as { name?: unknown } | null)?.name;
        return name === 'DEEPSEEK_API_KEY' && apiKey ? { value: apiKey } : undefined;
      },
    },
    llm: {
      listProviders: (): unknown[] => (apiKey ? [{ id: 'deepseek-official', name: 'DeepSeek API', models: [] }] : []),
      listModels: async (provider: string): Promise<unknown[]> =>
        provider === 'deepseek-official' && apiKey ? deepseekModels(apiKey) : [],
      /**
       * 模型元数据查询。DSH 的契约是
       * `resolveModelInfo(provider, model, signal?): Promise<LlmResolvedModelInfo>` —— **异步**。
       * 替身必须同样返回 Promise：同步返回 undefined 时，任何 `.then()` 或不带 `?.` 的取值
       * 都会立刻炸（与 stream 同一类形状错误）。
       *
       * 目前唯一消费方 `supportsReasoningOff` 用 `await` + `?.` + try/catch 包着，所以不炸——
       * 但那是靠消费方防御，不是靠形状正确。形状对不上，就不该指望下一个消费方也这么写。
       */
      resolveModelInfo: async (): Promise<undefined> => undefined,
      /**
       * 生成入口：独立模式将调用转发到 DeepSeek 官方 API；未配置密钥时迭代时报错。
       *
       * 必须是 **AsyncIterable**——DSH 的契约是 `stream(options): AsyncIterable<StreamChunk>`，
       * 调用方一律 `for await (const chunk of llm.stream(...))` 消费。错误在首次 `next()` 时抛出，
       * 正好落在调用方已有的 try/catch 里，转成 `ok:false / generate-error` 的结构化失败。
       *
       * **不能**写成 `async () => { throw ... }`：那返回 Promise 而非 AsyncIterable，
       * `for await` 会立刻抛 TypeError（文案由 V8 生成，形如 "llm.stream(...) is not a function
       * or its return value is not async iterable"），同时那个 rejected promise 无人接管，
       * 以 unhandled rejection **直接终止进程**。0.3.4 的崩溃根因即此：配置里设了
       * whisperModel/chatModel 就必崩，因为只有配了模型才会真的走到这里。
       */
      // 委托给 async generator，保证该 API 代理始终符合 AsyncIterable 契约。
      stream: (request: unknown): AsyncIterable<unknown> => streamDeepSeekChat(apiKey, request),
    },
  };

  return {
    ctx: context,
    routes,
    failures,
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      for (const dispose of disposers.splice(0).reverse()) {
        try {
          await dispose();
        } catch (error) {
          logger.warn(`释放某项失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    },
  };
}
