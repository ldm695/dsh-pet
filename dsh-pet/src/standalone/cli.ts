#!/usr/bin/env node
/**
 * dsh-pet 独立模式入口 —— 不打开 DSH 也能养桌宠。
 *
 * 它把三件事串起来（每一步都复用插件自己的实现，没有第二份业务逻辑）：
 *   1. `./context` 造一个伪 Cordis ctx，把插件的宿主半边（`src/host/index.ts` 的 `apply`）跑起来；
 *   2. `./server` 起一个真正的 `node:http` 服务，把 `apply` 注册的 prefix handler 接上去
 *      （路由表仍然只有插件那一份）；
 *   3. 插件自己的 `launchHelper` 因此照常探测 Electron、按配置拉起透明置顶小窗，
 *      并与宿主经 bridge 管道通信 —— 与 DSH 内运行完全同一条路径。
 *
 * 用法：
 *   npx dsh-pet-standalone              # 插件装好后直接跑（package.json 的 bin）
 *   npm run standalone                  # 仓库里跑（先 npm install：prepare 会构建 lib/）
 *   node lib/standalone.js --port 6952
 *   node lib/standalone.js --check      # 只体检，不开窗口
 *
 * 独立模式可配置 DeepSeek、OpenAI 兼容或 Anthropic 模型用于对话与碎碎念；桌面通知只覆盖
 * 独立模式自己的对话回复；若 DSH 同时运行且安装了 dsh-pet，可选中对话状态经本地文件桥接同步。
 */
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { flattenPetList, readAllConfig } from '../host/config';
import { dshHomeDir, packageRoot } from '../host/helper-process';
import { apply } from '../host/index';
import { createStandaloneAi } from './ai-provider';
import { settingsPage as standaloneAiPage } from './ai-settings-page';
import { runCheck, packageVersion } from './check';
import {
  createStandaloneContext,
  createStandaloneLogger,
  type RegisteredRoute,
  type StandaloneLogger,
} from './context';
import { configPathsFor, describePets, isDesktopVisible, parseArgs, USAGE } from './options';
import { STANDALONE_SETTINGS_HTML } from './settings-page';
import { listenStandaloneServer } from './server';
import { standaloneAiEnvironmentApiKey } from './deepseek';
import { createRequestSecurity } from './request-security';
import { getMigrationRecovery, prepareStandaloneMigrations, restoreMigrationConfiguration } from './migrations';

/** 启动独立模式：先起服务拿到端口，再 `apply`（插件据此拼桌面 Helper 的 configUrl） */
async function run(logger: StandaloneLogger, options: { port: number }): Promise<void> {
  const home = dshHomeDir();
  const paths = configPathsFor(packageRoot, home);
  const aiApiKeyStorePath = join(home, 'dsh-pet', 'standalone-ai-key.dpapi');
  const migration = await prepareStandaloneMigrations({
    home,
    packageRoot,
    environmentApiKey: standaloneAiEnvironmentApiKey(),
    logger,
  });
  const security = createRequestSecurity();
  // The packaged Electron shell owns the native tray and sends authenticated local API requests.
  // Pass the per-run capability only through the private child-process IPC channel; never log it.
  const ipcProcess = process as NodeJS.Process & { send?: (message: unknown) => boolean };
  ipcProcess.send?.({ channel: 'dsh-pet:request-token', token: security.token });
  const pendingFolderOpen = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  process.on('message', (message: unknown) => {
    if (!message || typeof message !== 'object') return;
    const response = message as { channel?: unknown; requestId?: unknown; ok?: unknown; error?: unknown };
    if (response.channel !== 'dsh-pet:open-migration-backup-result' || typeof response.requestId !== 'string') return;
    const pending = pendingFolderOpen.get(response.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingFolderOpen.delete(response.requestId);
    if (response.ok === true) pending.resolve();
    else pending.reject(new Error(typeof response.error === 'string' ? response.error : '无法打开备份文件夹。'));
  });
  const openBackupFolder = (backupDirectory: string): Promise<void> =>
    new Promise((resolve, reject) => {
      if (!ipcProcess.send) {
        reject(new Error('请从桌面应用内打开备份文件夹。'));
        return;
      }
      const requestId = randomUUID();
      const timer = setTimeout(() => {
        pendingFolderOpen.delete(requestId);
        reject(new Error('桌面应用打开备份文件夹超时。'));
      }, 10_000);
      timer.unref();
      pendingFolderOpen.set(requestId, { resolve: () => resolve(), reject, timer });
      try {
        if (ipcProcess.send({ channel: 'dsh-pet:open-migration-backup', requestId, path: backupDirectory })) return;
        clearTimeout(timer);
        pendingFolderOpen.delete(requestId);
        reject(new Error('桌面应用当前无法打开备份文件夹。'));
      } catch (error) {
        clearTimeout(timer);
        pendingFolderOpen.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  const standaloneAi = createStandaloneAi(home, logger, {
    initialApiKey: migration.initialApiKey,
    apiKeyStorePath: aiApiKeyStorePath,
  });

  // 预检：包内默认配置读不到时宿主半边必然每请求失败；早给可操作的诊断，别让用户对着空桌面猜
  if (!existsSync(paths.defaultFile)) {
    logger.error(
      `包内默认配置缺失：${paths.defaultFile}。若你是在直接跑源码（包根被解析成了 src/），` +
        '请改用构建产物：npm run bundle 后 node lib/standalone.js（或 npm run standalone）。',
    );
    process.exitCode = 1;
    return;
  }

  const routes: RegisteredRoute[] = [];
  routes.push(
    {
      kind: 'exact',
      path: '/settings',
      handler: (_req, res) => {
        const appName = process.env.DSH_PET_DISPLAY_NAME === 'DSH Pet' ? 'DSH Pet' : '哦鲸鲸';
        const aiUrl = security.authenticatedUrl(`http://127.0.0.1:${portRef.value}`);
        const authBootstrap = `<script>
window.DSH_PET_AI_SETTINGS_URL=${JSON.stringify(aiUrl)};
(() => {
  const token=${JSON.stringify(security.token)};
  const originalFetch=window.fetch.bind(window);
  window.fetch=(input,init={})=>{
    let url;
    try { url=new URL(typeof input==='string'||input instanceof URL?input:input.url,window.location.href); }
    catch { return originalFetch(input,init); }
    if(url.origin!==window.location.origin||!url.pathname.startsWith('/dsh-pet-7340/')) return originalFetch(input,init);
    const headers=new Headers(input instanceof Request?input.headers:undefined);
    new Headers(init.headers).forEach((value,name)=>headers.set(name,value));
    headers.set('X-DSH-Pet-Token',token);
    return originalFetch(input,{...init,headers});
  };
})();
</script>`;
        const html = STANDALONE_SETTINGS_HTML.replace(/__DSH_PET_APP_NAME__/g, appName).replace(
          '</head>',
          `${authBootstrap}</head>`,
        );
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-length': Buffer.byteLength(html),
        });
        res.end(html);
      },
    },
    {
      kind: 'exact',
      path: '/standalone-ai/',
      handler: (_req, res) => {
        const appName = process.env.DSH_PET_DISPLAY_NAME === 'DSH Pet' ? 'DSH Pet' : '哦鲸鲸';
        const html = standaloneAiPage.replace(/__DSH_PET_APP_NAME__/g, appName);
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-length': Buffer.byteLength(html),
          'cache-control': 'no-store',
        });
        res.end(html);
      },
    },
    {
      kind: 'exact',
      path: '/standalone-settings.js',
      handler: (_req, res) => {
        const bundle = readFileSync(join(packageRoot, 'lib', 'standalone-settings.js'));
        res.writeHead(200, {
          'content-type': 'text/javascript; charset=utf-8',
          'content-length': bundle.length,
          'cache-control': 'no-store',
        });
        res.end(bundle);
      },
    },
  );
  const sendRecoveryJson = (res: Parameters<RegisteredRoute['handler']>[1], status: number, body: unknown): void => {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
      'cache-control': 'no-store',
    });
    res.end(payload);
  };
  routes.push(
    {
      kind: 'exact',
      path: '/dsh-pet-7340/migration-recovery',
      handler: (req, res) => {
        if (req.method !== 'GET') {
          sendRecoveryJson(res, 405, { error: 'Method not allowed' });
          return;
        }
        const recovery = getMigrationRecovery(home);
        sendRecoveryJson(res, 200, recovery ? { available: true, ...recovery } : { available: false });
      },
    },
    {
      kind: 'exact',
      path: '/dsh-pet-7340/migration-recovery/open',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendRecoveryJson(res, 405, { error: 'Method not allowed' });
          return;
        }
        try {
          const recovery = getMigrationRecovery(home);
          if (!recovery) throw new Error('没有可打开的迁移异常备份。');
          await openBackupFolder(join(recovery.backupDirectory, 'dsh-pet'));
          sendRecoveryJson(res, 200, { ok: true });
        } catch (error) {
          sendRecoveryJson(res, 503, { error: error instanceof Error ? error.message : String(error) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/dsh-pet-7340/migration-recovery/restore',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendRecoveryJson(res, 405, { error: 'Method not allowed' });
          return;
        }
        try {
          await restoreMigrationConfiguration(home);
          sendRecoveryJson(res, 200, { ok: true, stopping: true });
          setTimeout(() => forwardShutdown(), 100);
        } catch (error) {
          sendRecoveryJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
        }
      },
    },
  );
  const portRef = { value: options.port };
  const context = createStandaloneContext({
    port: () => portRef.value,
    logger,
    routes,
    ai: standaloneAi,
    authenticatedUrl: (baseUrl) => security.authenticatedUrl(baseUrl),
  });
  // /shutdown 的回调要在服务构造时给出去，而停机函数要在服务之后定义：
  // 用一个可替换的转发器解耦（服务构造时只拿到"将来会是谁"）。
  let forwardShutdown: () => void = () => {};
  const server = await listenStandaloneServer({
    routes,
    logger,
    port: options.port,
    status: () => ({
      name: process.env.DSH_PET_DISPLAY_NAME === 'DSH Pet' ? 'DSH Pet' : '哦鲸鲸',
      plugin: { root: packageRoot, version: packageVersion(packageRoot) },
      port: portRef.value,
      uptimeSec: Math.round(process.uptime()),
    }),
    onShutdown: () => forwardShutdown(),
    requestSecurity: security,
  });
  portRef.value = server.port;

  let shuttingDown = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`收尾（${reason}）…`);
    // 先释放插件注册的 effect（停桌面 Helper、清周期定时器），再关服务
    await context.dispose();
    await server.close();
    logger.info('已退出。');
  };
  const requestShutdown = (reason: string): void => {
    shutdown(reason)
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        logger.error(`收尾失败：${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      });
  };
  forwardShutdown = () => requestShutdown('POST /shutdown');
  process.on('SIGINT', () => requestShutdown('SIGINT'));
  process.on('SIGTERM', () => requestShutdown('SIGTERM'));

  // 起插件宿主半边：路由表、状态仓、桌面 Helper（含 bridge 管道）都在这一句里
  process.env.DSH_PET_STANDALONE = '1';
  apply(context.ctx);

  let pets: Record<string, unknown>[] = [];
  let configSource = paths.userFile;
  try {
    pets = flattenPetList(readAllConfig(paths));
    if (!existsSync(paths.userFile)) configSource = `${paths.userFile}（不存在 → 用包内默认）`;
  } catch (error) {
    logger.warn(
      `读配置失败（服务照常运行，相关端点会显式报错）：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const desktopVisible = pets.filter(isDesktopVisible);
  for (const line of [
    '',
    '===== dsh-pet 独立模式（可独立运行；DSH 状态桥接可选）=====',
    `  插件        dsh-pet@${packageVersion(packageRoot)}  ${packageRoot}`,
    `  路由        http://127.0.0.1:${server.port}/dsh-pet-7340/`,
    `  配置        ${configSource}`,
    `  宠物        ${describePets(pets)}`,
    desktopVisible.length === 0
      ? '  桌面小窗    0 只：请将至少一只宠物的 display 设为 desktop（服务仍在运行）'
      : `  桌面小窗    ${desktopVisible.length} 只`,
    aiStatusLine(standaloneAi),
    '  退出        Ctrl+C，或 POST /shutdown',
    '',
  ]) {
    logger.info(line);
  }
  if (context.failures.length > 0) {
    logger.warn(`初始化期间有 ${context.failures.length} 项失败（见上方日志）；路由仍可用，相关端点会显式报错`);
  }
}

function aiStatusLine(ai: ReturnType<typeof createStandaloneAi>): string {
  const settings = ai.getSettings();
  if (settings.enabled) return `  独立模式 AI 已启用  模型 ${settings.model}`;
  return settings.hasKey
    ? '  独立模式 AI 已配置但未启用  可在设置页配置并测试连接'
    : '  独立模式 AI 未配置  可在设置页设置模型端点与密钥';
}

/** CLI 入口 */
async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if ('error' in parsed) {
    console.error(`dsh-pet-standalone: ${parsed.error}\n`);
    console.error(USAGE);
    return 2;
  }
  const { options } = parsed;
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  const logger = createStandaloneLogger();
  if (options.check) return runCheck(logger);
  await run(logger, options);
  return 0;
}

// 本文件就是可执行入口（package.json 的 bin 指向构建产物 lib/standalone.js），
// 因此无条件启动：不做 import.meta.main / argv[1] 比较之类的守卫 ——
// import.meta.main 要 Node 24+，而 argv[1] 比较在 pnpm 的 bin 符号链接下会判错。
main()
  .then((code) => {
    if (code !== 0) process.exit(code);
  })
  .catch((error: unknown) => {
    console.error(`dsh-pet-standalone: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    process.exit(1);
  });
