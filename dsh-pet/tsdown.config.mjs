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
      'standalone-settings': 'src/standalone/settings-ui.ts',
    },
    // This is the EXE's embedded settings page, not a DSH Web client.
    noExternal: [/^react(?:-dom)?(?:\/.*)?$/],
    external: [],
  },
]);
