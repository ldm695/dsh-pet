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
import { join } from 'node:path';

import { flattenPetList, readAllConfig } from '../host/config';
import { dshHomeDir, packageRoot } from '../host/helper-process';
import { apply } from '../host/index';
import { loadProtectedApiKey, saveProtectedApiKey } from './api-key-store';
import { createStandaloneAi } from './ai-provider';
import { migrateMissingChatContextSettings } from './ai-config';
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

/** 启动独立模式：先起服务拿到端口，再 `apply`（插件据此拼桌面 Helper 的 configUrl） */
async function run(logger: StandaloneLogger, options: { port: number }): Promise<void> {
  const home = dshHomeDir();
  const paths = configPathsFor(packageRoot, home);
  const aiApiKeyStorePath = join(home, 'dsh-pet', 'standalone-ai-key.dpapi');
  const aiSettingsPath = join(home, 'dsh-pet', 'standalone-ai.json');
  const hadAiSettings = existsSync(aiSettingsPath);
  let storedApiKey: string | undefined;
  let apiKeyStoreReadFailed = false;
  try {
    // .11's current DPAPI credential remains the supported persisted key source.
    storedApiKey = await loadProtectedApiKey(aiApiKeyStorePath);
  } catch (error) {
    apiKeyStoreReadFailed = true;
    logger.warn(`读取独立 AI DPAPI 密钥失败：${error instanceof Error ? error.message : String(error)}`);
  }
  const environmentApiKey = !hadAiSettings ? standaloneAiEnvironmentApiKey() : undefined;
  let keepEnvironmentKeyBootstrap = false;
  if (!storedApiKey && environmentApiKey && !apiKeyStoreReadFailed) {
    try {
      // The context migration creates standalone-ai.json. Persist the app-specific env key
      // first so that creating that file cannot make this one-time bootstrap disappear.
      await saveProtectedApiKey(aiApiKeyStorePath, environmentApiKey);
      const verifiedApiKey = await loadProtectedApiKey(aiApiKeyStorePath);
      if (verifiedApiKey !== environmentApiKey) throw new Error('DPAPI read-back verification failed');
      storedApiKey = verifiedApiKey;
      logger.info('已将应用环境密钥安全保存到当前 DPAPI 存储。');
    } catch (error) {
      // Keep the env key usable for this run, but leave standalone-ai.json absent so the
      // same app-specific bootstrap remains available on the next run.
      keepEnvironmentKeyBootstrap = true;
      logger.warn(`无法安全保存应用环境密钥，跳过聊天上下文迁移以保留环境变量回退：${error instanceof Error ? error.message : String(error)}`);
    }
  } else if (!storedApiKey && environmentApiKey && apiKeyStoreReadFailed) {
    // Do not overwrite an unreadable key store, and do not create the settings file that
    // would disable the environment fallback on the next launch.
    keepEnvironmentKeyBootstrap = true;
    logger.warn('DPAPI 密钥存储读取失败，已跳过聊天上下文迁移以保留环境变量回退。');
  }
  const legacyAiConfig = readAllConfig(paths).main ?? {};
  if (!keepEnvironmentKeyBootstrap) migrateMissingChatContextSettings(home, legacyAiConfig, logger);
  // Preserve the documented app-specific environment key behavior based on whether the
  // settings file existed before the one-time context migration writes it.
  const aiInitialApiKey = storedApiKey ?? environmentApiKey;
  const security = createRequestSecurity();
  const standaloneAi = createStandaloneAi(home, logger, {
    initialApiKey: aiInitialApiKey,
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
        const html = STANDALONE_SETTINGS_HTML.replace(/__DSH_PET_APP_NAME__/g, appName).replace(
          '</head>',
          `<script>window.DSH_PET_AI_SETTINGS_URL=${JSON.stringify(aiUrl)};</script></head>`,
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
  const portRef = { value: options.port };
  const context = createStandaloneContext({
    port: () => portRef.value,
    logger,
    routes,
    ai: standaloneAi,
    authenticatedUrl: (baseUrl) => security.authenticatedUrl(baseUrl),
    renderModeStorePath: process.env.DSH_PET_RENDER_MODE_FILE,
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
