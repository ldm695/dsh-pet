/** 独立设置浮窗使用的 HTML 外壳；内联以避免便携版解压目录漏带单个静态文件。 */
import { SETTINGS_THEME_CSS } from './settings-style';

export const STANDALONE_SETTINGS_HTML = `<!doctype html>
<html lang="zh-CN" data-dsh-theme="system">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <title>__DSH_PET_APP_NAME__ 设置</title>
    <style>${SETTINGS_THEME_CSS}</style>
  </head>
  <body>
    <main id="app" aria-live="polite"></main>
    <script>window.DSH_PET_APP_NAME = "__DSH_PET_APP_NAME__";</script>
    <script type="module" src="/standalone-settings.js"></script>
  </body>
</html>`;
