/**
 * Minimal document shell; the settings experience is rendered by one React application.
 * @module dsh-pet/src/standalone/settings-page/chrome
 */

/** Settings document with a single React mount point and no inline code. */
export const settingsPage = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><base href="/"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>桌宠设置</title><link rel="icon" type="image/png" href="/standalone-ai/icon.png"><link rel="stylesheet" href="/standalone-ai/settings.css" data-dsh-pet-settings-css>
<script src="/standalone-ai/settings.js" defer></script></head><body>
<div id="settings-root"></div><noscript>需要启用 JavaScript 才能使用桌宠设置。</noscript>
</body></html>`;
