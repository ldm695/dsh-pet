/** 独立设置浮窗使用的 HTML 外壳；内联以避免便携版解压目录漏带单个静态文件。 */
export const STANDALONE_SETTINGS_HTML = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="dark" />
    <title>__DSH_PET_APP_NAME__ 设置</title>
    <style>
      @font-face {
        font-family: "ShangshouSoftCandy";
        src: url("/dsh-pet-7340/font/%E4%B8%8A%E9%A6%96%E8%BD%AF%E7%B3%96%E4%BD%93.ttf") format("truetype");
        font-display: swap;
        font-weight: 400;
      }
      :root {
        color-scheme: dark;
        font-family: "ShangshouSoftCandy", "Yuanti SC", "YouYuan", "幼圆", "Comic Sans MS", "PingFang SC", "Microsoft YaHei", sans-serif;
        color: #dedede;
        background: #292929;
        --dsw-alias-label-primary: #dedede;
        --dsw-alias-label-secondary: #c5c5c5;
        --dsw-alias-label-tertiary: #a0a0a0;
        --dsw-alias-label-dimmed: #858585;
        --dsw-alias-border-l1: #505050;
        --dsw-alias-border-l2: #454545;
        --dsw-alias-bg-layer-1: #242424;
        --dsw-alias-state-business-primary: #78aee8;
        --dsw-alias-state-error-primary: #ff626b;
        --dsw-alias-state-error-secondary: #a53d43;
        --dsw-alias-state-success-primary: #78c995;
        --dsw-alias-button-info-fill: #78aee8;
        --dsw-alias-button-info-hover: #91bdf0;
        --dsw-alias-interactive-bg-hover: #373737;
        --dsw-alias-interactive-bg-active: #333333;
        --dsw-alias-tooltip-bg: #181818;
      }
      * { box-sizing: border-box; }
      body { margin: 0; min-width: 320px; background: #292929; font-family: inherit; }
      button, input, select, textarea { font-family: inherit; }
      #app { width: min(100%, 920px); margin: 0 auto; padding: 22px 24px 32px; }
      .dsh-pet-cfg { max-width: none !important; }
      @media (max-width: 560px) { #app { padding: 16px 12px 24px; } }
    </style>
  </head>
  <body>
    <main id="app" aria-live="polite"></main>
    <script>window.DSH_PET_APP_NAME = "__DSH_PET_APP_NAME__";</script>
    <script type="module" src="/standalone-settings.js"></script>
  </body>
</html>`;
