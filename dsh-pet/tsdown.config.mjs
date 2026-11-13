// DSH Pet Windows EXE 构建入口：只生成独立宿主和 EXE 内嵌设置页。
// DSH Web 宠物客户端与 DSH 插件宿主 bundle 不再构建或发布。
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsdown';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)));
const shim = (name) => join(packageRoot, 'src', 'standalone', 'shims', `${name}.ts`);

const shared = {
  format: ['esm'],
  platform: 'node',
  target: 'es2020',
  dts: false,
  outDir: 'lib',
  clean: false,
};

export default defineConfig([
  {
    ...shared,
    // Node ≥ 22.12 可直接运行这些 class field，无需引入 @oxc-project/runtime。
    target: 'es2022',
    entry: {
      standalone: 'src/standalone/cli.ts',
    },
    // 这三个 DSH 依赖由独立模式的本地替代实现提供；其他 DSH 模块不得进入 EXE。
    noExternal: [
      /^@deepseek-ai\/(?:dsh-home-paths|dsh-credentials|dsh-llm)$/,
      /^openai$/,
      /^@anthropic-ai\/sdk$/,
      // 语音合成按需加载；独立应用产物没有 node_modules，需连依赖一起内联。
      /^@andresaya\/edge-tts$/,
    ],
    external: [/^@electron\//, /^node:/, /^@deepseek-ai\/(?!dsh-home-paths$|dsh-credentials$|dsh-llm$)/],
    alias: {
      '@deepseek-ai/dsh-home-paths': shim('dsh-home-paths'),
      '@deepseek-ai/dsh-credentials': shim('dsh-credentials'),
      '@deepseek-ai/dsh-llm': shim('dsh-llm'),
    },
  },
  {
    ...shared,
    platform: 'browser',
    target: 'es2020',
    entry: {
      app: 'src/app/main.ts',
    },
    // zod 打进包：应用产物要做到「不依赖 node_modules」，而配置校验每次启动都要用。
    // openai / @anthropic-ai/sdk 同样必须打进包：它们由 src/standalone/ai-transport.ts 顶层静态
    // import，而 electron-builder 的 files 白名单不带 node_modules；留成外部裸 import 时，产物
    // 一旦离开项目目录（例如解压到 Downloads）就会 ERR_MODULE_NOT_FOUND。
    // @electron/get 与 @electron-internal/extract-zip 保持外部——它们只在「下载 Electron」时被
    // 动态解析，应用模式永远不走那条路（见 src/host/helper-process.ts 的 import 注释）。
    alias: {
      '@deepseek-ai/dsh-home-paths': shim('dsh-home-paths'),
      '@deepseek-ai/dsh-credentials': shim('dsh-credentials'),
      '@deepseek-ai/dsh-llm': shim('dsh-llm'),
    },
    // This is the EXE's embedded settings page, not a DSH Web client.
    noExternal: [
      /^@deepseek-ai\/(?:dsh-home-paths|dsh-credentials|dsh-llm)$/,
      /^zod$/,
      /^openai$/,
      /^@anthropic-ai\/sdk$/,
      /^@andresaya\/edge-tts$/,
      /^react(?:-dom)?(?:\/.*)?$/,
    ],
    external: ['electron', /^@electron\//, /^node:/, /^@deepseek-ai\/(?!dsh-home-paths$|dsh-credentials$|dsh-llm$)/],
  },
  {
    ...shared,
    // 独立模式设置页里的对话面板（lib/chat-panel.js）：跑在浏览器里，既没有 DSH 注入也没有
    // node_modules，所以 react / react-dom 必须打进产物——这与 client 那份正好相反（那边由宿主提供）。
    // platform 覆盖成 browser，否则 tsdown 会按 node 口径解析并留下 node: 内置依赖。
    platform: 'browser',
    target: 'es2020',
    entry: {
      'chat-panel': 'src/standalone/settings-page/chat-mount.ts',
    },
    noExternal: [/^react(\/|$)/, /^react-dom(\/|$)/],
    external: [/^node:/],
    // 与 client 同理：设置页刷新会重跑脚本，包一层 IIFE 免得顶层声明重复触发 SyntaxError。
    outputOptions: { banner: ';(()=>{', footer: '})();' },
  },
]);
