// ESLint 扁平配置（ESLint 9 flat config）
// 规则基调：js recommended + typescript-eslint recommended（未使用变量/类型相关规则）
//           + react-hooks 钩子规则（桌面设置页是 React 代码）
// 忽略：构建产物、发布前检查脚本、素材、本地归档与运行产物，以及独立发布的桥接插件目录。
// 类型正确性交给 tsc，因此 TS 文件关闭 no-undef，避免 window/fetch 等全局误报。
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: [
      'lib/**',
      'scripts/**',
      'assets/**',
      'runtime/**',
      'node_modules/**',
      'portable-dist/**',
      'portable-dist-*/**',
      'local-only/**',
      'release/**',
      'test-runtime/**',
      '.build-temp-icon-*/**',
      'dsh-pet-work-status-bridge/**',
      'codex-pet-work-status-bridge/**',
      'claude-code-pet-work-status-bridge/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Electron 启动入口必须是 CommonJS，单独放开 CJS 环境规则。
    files: ['desktop-main.cjs'],
    rules: {
      'no-undef': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    // TS 文件：类型正确性由 tsc 负责，关闭 no-undef（避免 window/fetch 等全局误报）
    files: ['**/*.ts'],
    rules: {
      'no-undef': 'off',
    },
  },
  {
    // 桌面设置页是 React 代码（hooks + 手写 h() 元素）：
    // rules-of-hooks 强制 hook 调用顺序稳定；exhaustive-deps 提醒 useEffect 依赖遗漏
    files: ['src/standalone/**/*.ts'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    // 配置文件本身用的 ESM import，无浏览器代码，no-undef 放开
    files: ['eslint.config.js'],
    rules: {
      'no-undef': 'off',
    },
  },
);
