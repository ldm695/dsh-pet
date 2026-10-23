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
 *   - `agentDefaultModel.currentSelection()` → 已启用时使用用户配置的独立 AI 模型，否则模型未就绪
 *   - `credentials.resolve()` → 仅提供 DeepSeek 官方 API Key，供兼容的余额路由使用
 *   - `llm.*` → 有独立 AI 服务时走用户配置的模型接口；未注入时仅提供明确失败的空服务
 *   - `on(...)` → 不订阅任何事件：独立模式没有 DSH 会话，工作状态因此保持空闲
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { deepseekApiKey } from './deepseek';
import type { StandaloneAiService } from './ai-provider';

/** 独立模式下模型及余额路由使用的 DeepSeek 官方 API 服务商 id。 */
export const STANDALONE_PROVIDER = 'deepseek-official';

interface AutoStartState {
  available: boolean;
  enabled: boolean;
}

interface PendingAutoStartRequest {
  resolve(state: AutoStartState): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
}

const pendingAutoStartRequests = new Map<string, PendingAutoStartRequest>();
let autoStartMessageListenerAttached = false;

function requestAutoStart(action: 'get' | 'set', enabled?: boolean): Promise<AutoStartState> {
  if (process.env.DSH_PET_AUTOSTART_SUPPORTED !== '1') {
    return Promise.resolve({ available: false, enabled: false });
  }
  const ipcProcess = process as NodeJS.Process & {
    send?: (message: unknown, callback?: (error: Error | null) => void) => boolean;
  };
  if (typeof ipcProcess.send !== 'function') return Promise.resolve({ available: false, enabled: false });

  if (!autoStartMessageListenerAttached) {
    ipcProcess.on('message', (message: unknown) => {
      if (typeof message !== 'object' || message === null) return;
      const response = message as {
        channel?: unknown;
        requestId?: unknown;
        ok?: unknown;
        state?: unknown;
        error?: unknown;
      };
      if (response.channel !== 'dsh-pet:auto-start:result' || typeof response.requestId !== 'string') return;
      const pending = pendingAutoStartRequests.get(response.requestId);
      if (!pending) return;
      clearTimeout(pending.timeout);
      pendingAutoStartRequests.delete(response.requestId);
      if (response.ok === true && typeof response.state === 'object' && response.state !== null) {
        const state = response.state as Partial<AutoStartState>;
        pending.resolve({ available: state.available === true, enabled: state.enabled === true });
      } else {
        pending.reject(new Error(typeof response.error === 'string' ? response.error : '读取 Windows 自启动状态失败。'));
      }
    });
    autoStartMessageListenerAttached = true;
  }

  const requestId = randomUUID();
  return new Promise<AutoStartState>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingAutoStartRequests.delete(requestId);
      reject(new Error('与桌面程序通信超时，请重启后重试。'));
    }, 5000);
    pendingAutoStartRequests.set(requestId, { resolve, reject, timeout });
    ipcProcess.send?.({ channel: 'dsh-pet:auto-start', requestId, action, enabled }, (error) => {
      if (!error) return;
      clearTimeout(timeout);
      pendingAutoStartRequests.delete(requestId);
      reject(error);
    });
  });
}

/** 独立模式的日志接口，供桌面宿主模块使用。 */
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
  /** Node HTTP handler：自行写入响应头与响应体。 */
  handler: (req: IncomingMessage, res: ServerResponse) => unknown;
}

export interface StandaloneContextOptions {
  /** 插件用它拼桌面 Helper 的 `DSH_PET_CONFIG_URL`；传函数可拿到"监听后才确定"的端口 */
  port: number | (() => number);
  logger: StandaloneLogger;
  /** 注入路由收集数组（独立模式先起服务拿到端口，再 `apply`，两者共用同一个数组） */
  routes?: RegisteredRoute[];
  /** Electron 硬件/软件合成偏好文件；保存后需重启 Electron Helper 生效 */
  renderModeStorePath?: string;
  ai?: StandaloneAiService;
  authenticatedUrl?: (baseUrl: string) => string;
}

export interface StandaloneContext {
  /** 交给宿主初始化函数的运行时上下文适配层 */
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
  const ai = options.ai;
  const apiKey = deepseekApiKey();
  const routes = options.routes ?? [];
  const failures: string[] = [];
  const services = new Map<string, unknown>();
  /** effect 释放函数（后注册先释放，与 Cordis 的逆序释放一致） */
  const disposers: Array<() => unknown> = [];
  let disposed = false;

  const portOf = (): number => (typeof options.port === 'function' ? options.port() : options.port);

  const sendAiJson = (res: ServerResponse, status: number, value: unknown): void => {
    const payload = JSON.stringify(value);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
      'cache-control': 'no-store',
    });
    res.end(payload);
  };
  const readAiBody = (req: IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => (body += chunk));
      req.once('end', () => resolve(body));
      req.once('error', reject);
    });
  if (ai) {
    routes.push(
      {
        kind: 'exact',
        path: '/standalone-ai/settings',
        handler: async (req, res) => {
          if (req.method === 'GET') {
            sendAiJson(res, 200, ai.getSettings());
            return;
          }
          if (req.method !== 'POST') {
            sendAiJson(res, 405, { error: 'Method not allowed' });
            return;
          }
          try {
            sendAiJson(res, 200, await ai.saveSettings(JSON.parse(await readAiBody(req)) as unknown));
          } catch (error) {
            sendAiJson(res, 400, { error: error instanceof Error ? error.message : '设置无效' });
          }
        },
      },
      {
        kind: 'exact',
        path: '/standalone-ai/test',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendAiJson(res, 405, { error: 'Method not allowed' });
            return;
          }
          try {
            const input = JSON.parse(await readAiBody(req)) as Parameters<StandaloneAiService['testConnection']>[0];
            sendAiJson(res, 200, await ai.testConnection(input));
          } catch (error) {
            sendAiJson(res, 400, { ok: false, message: error instanceof Error ? error.message : '请求无效' });
          }
        },
      },
    );
  }

  if (options.renderModeStorePath) {
    const modeOf = (): 'hardware' | 'software' =>
      process.env.DSH_PET_RENDER_MODE === 'hardware' ? 'hardware' : 'software';
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

  const sendAutoStart = (res: ServerResponse, status: number, body: unknown): void => {
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
    path: '/dsh-pet-7340/auto-start',
    handler: async (req, res) => {
      if (req.method === 'GET') {
        try {
          sendAutoStart(res, 200, await requestAutoStart('get'));
        } catch (error) {
          sendAutoStart(res, 503, {
            available: true,
            enabled: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }
      if (req.method !== 'POST') {
        sendAutoStart(res, 405, { error: 'Method not allowed' });
        return;
      }
      const contentLength = Number(req.headers['content-length'] ?? 0);
      if (contentLength > 1024) {
        sendAutoStart(res, 413, { error: '自启动设置请求内容过大。' });
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
        sendAutoStart(res, 413, { error: '自启动设置请求内容过大。' });
        return;
      }
      let request: { enabled?: unknown };
      try {
        request = JSON.parse(rawBody) as { enabled?: unknown };
      } catch {
        sendAutoStart(res, 400, { error: '无效的 JSON 请求。' });
        return;
      }
      if (typeof request.enabled !== 'boolean') {
        sendAutoStart(res, 400, { error: '无效的自启动设置。' });
        return;
      }
      try {
        sendAutoStart(res, 200, await requestAutoStart('set', request.enabled));
      } catch (error) {
        sendAutoStart(res, 503, {
          available: true,
          enabled: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  });

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
    /** Cordis 服务在独立宿主中按名称登记；未提供的可选服务返回 undefined。 */
    provide(name: string, value: unknown): Record<string, unknown> {
      services.set(name, value);
      context[name] = value;
      return context;
    },
    get(name: string, _required = false): unknown {
      return services.get(name) ?? context[name];
    },
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
    connection: { authenticatedUrl: options.authenticatedUrl ?? ((baseUrl: string): string => baseUrl) },
    commands: { register: (): (() => void) => () => {} },
    agentDefaultModel: {
      currentSelection: (): { provider: string; model: string } =>
        ai?.currentSelection() ?? { provider: STANDALONE_PROVIDER, model: '' },
    },
    credentials: {
      resolve: async (ref: unknown): Promise<{ value: string } | undefined> => {
        const name = typeof ref === 'string' ? ref : (ref as { name?: unknown } | null)?.name;
        const key = ai?.deepSeekApiKey() ?? apiKey;
        return name === 'DEEPSEEK_API_KEY' && key ? { value: key } : undefined;
      },
    },
    ...(ai
      ? {
          standaloneAi: {
            isReady: () => ai.isReady(),
            balanceQuerySupported: () => ai.supportsBalance(),
            canWhisper: () => ai.canWhisper(),
            chatEnabled: () => ai.getSettings().enabled,
            whisperIntervalSec: () => ai.getSettings().whisperIntervalSec,
            chatMemoryRounds: () => ai.getSettings().chatMemoryRounds,
            chatImageLimit: () => ai.getSettings().chatImageLimit,
          },
        }
      : {}),
    llm: ai
      ? {
          listProviders: (): unknown[] => ai.listProviders(),
          listModels: (provider: string): Promise<unknown[]> => ai.listModels(provider),
          resolveModelInfo: (provider?: string, model?: string, signal?: AbortSignal): Promise<unknown> =>
            ai.resolveModelInfo(provider, model, signal),
          stream: (request: unknown): AsyncIterable<unknown> => ai.stream(request),
        }
      : {
          listProviders: (): unknown[] => [],
          listModels: async (): Promise<unknown[]> => [],
          resolveModelInfo: async (): Promise<undefined> => undefined,
          stream: (): AsyncIterable<unknown> => ({
            async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
              throw new Error('独立模式未接入模型');
            },
          }),
        },
  };

  return {
    ctx: context,
    routes,
    failures,
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      ai?.dispose();
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
