import type { UiTheme } from '../shared/types';

/** Shared theme and control styles used by both standalone settings pages. */
export const SETTINGS_THEME_CSS = `
@font-face {
  font-family: "ShangshouSoftCandy";
  src: url("/dsh-pet-7340/font/%E4%B8%8A%E9%A6%96%E8%BD%AF%E7%B3%96%E4%BD%93.ttf") format("truetype");
  font-display: swap;
  font-weight: 400;
}
:root, :root[data-dsh-theme="dark"] {
  color-scheme: dark;
  font-family: "ShangshouSoftCandy", "Yuanti SC", "YouYuan", "幼圆", "Comic Sans MS", "PingFang SC", "Microsoft YaHei", sans-serif;
  color: #dedede;
  background: #292929;
  --dsh-page-bg: #292929;
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
  --dsw-alias-tooltip-text: #ffffff;
}
:root[data-dsh-theme="light"] {
  color-scheme: light;
  color: #252525;
  background: #f4f5f7;
  --dsh-page-bg: #f4f5f7;
  --dsw-alias-label-primary: #252525;
  --dsw-alias-label-secondary: #4b5563;
  --dsw-alias-label-tertiary: #687384;
  --dsw-alias-label-dimmed: #929baa;
  --dsw-alias-border-l1: #cbd1da;
  --dsw-alias-border-l2: #d9dee6;
  --dsw-alias-bg-layer-1: #ffffff;
  --dsw-alias-state-business-primary: #347ab8;
  --dsw-alias-state-error-primary: #c73540;
  --dsw-alias-state-error-secondary: #9f2c36;
  --dsw-alias-state-success-primary: #287b46;
  --dsw-alias-button-info-fill: #347ab8;
  --dsw-alias-button-info-hover: #286ca9;
  --dsw-alias-interactive-bg-hover: #edf1f6;
  --dsw-alias-interactive-bg-active: #e3eaf2;
  --dsw-alias-tooltip-bg: #ffffff;
  --dsw-alias-tooltip-text: #252525;
}
@media (prefers-color-scheme: light) {
  :root[data-dsh-theme="system"] {
    color-scheme: light;
    color: #252525;
    background: #f4f5f7;
    --dsh-page-bg: #f4f5f7;
    --dsw-alias-label-primary: #252525;
    --dsw-alias-label-secondary: #4b5563;
    --dsw-alias-label-tertiary: #687384;
    --dsw-alias-label-dimmed: #929baa;
    --dsw-alias-border-l1: #cbd1da;
    --dsw-alias-border-l2: #d9dee6;
    --dsw-alias-bg-layer-1: #ffffff;
    --dsw-alias-state-business-primary: #347ab8;
    --dsw-alias-state-error-primary: #c73540;
    --dsw-alias-state-error-secondary: #9f2c36;
    --dsw-alias-state-success-primary: #287b46;
    --dsw-alias-button-info-fill: #347ab8;
    --dsw-alias-button-info-hover: #286ca9;
    --dsw-alias-interactive-bg-hover: #edf1f6;
    --dsw-alias-interactive-bg-active: #e3eaf2;
    --dsw-alias-tooltip-bg: #ffffff;
    --dsw-alias-tooltip-text: #252525;
  }
}
* { box-sizing: border-box; }
html, body { min-height: 100%; }
body { margin: 0; background: var(--dsh-page-bg); color: var(--dsw-alias-label-primary); font-family: inherit; }
button, input, select, textarea { font-family: inherit; }
#app { width: min(100%, 920px); margin: 0 auto; padding: 22px 24px 32px; }
.dsh-pet-cfg { max-width: none !important; }
@media (max-width: 560px) { #app { padding: 16px 12px 24px; } }
`;

export function applySettingsTheme(value: unknown): UiTheme {
  const theme: UiTheme = value === 'light' || value === 'dark' ? value : 'system';
  document.documentElement.dataset.dshTheme = theme;
  return theme;
}

/** Page-only layout around controls that use the shared dsh-pet-cfg components. */
export const AI_SETTINGS_LAYOUT_CSS = `
.ai-settings { display: flex; flex-direction: column; gap: 12px; }
.ai-settings__intro { margin: 0 0 2px; color: var(--dsw-alias-label-secondary); }
.ai-settings__form { display: flex; flex-direction: column; gap: 12px; }
.ai-settings__fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 16px; }
.ai-settings__fields .is-wide { grid-column: 1 / -1; }
.ai-settings__hint { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }
.ai-settings__keyHeading { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.ai-settings__check { display: flex; align-items: center; gap: 8px; color: var(--dsw-alias-label-primary); }
.ai-settings__check input { flex: none; width: 16px; height: 16px; margin: 0; accent-color: var(--dsw-alias-state-business-primary); }
.ai-settings__notice { margin: 0; padding: 8px 10px; border-radius: 8px; background: var(--dsw-alias-interactive-bg-active); color: var(--dsw-alias-label-secondary); }
.ai-settings__testRow { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.ai-settings__testResult { min-height: 20px; color: var(--dsw-alias-label-secondary); }
.ai-settings__testResult.is-success { color: var(--dsw-alias-state-success-primary); }
.ai-settings__testResult.is-error, .ai-settings__status[data-error="true"] { color: var(--dsw-alias-state-error-primary); }
.ai-settings__footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.ai-settings__status { min-height: 20px; margin: 0; color: var(--dsw-alias-label-secondary); }
.ai-settings__leaveDialog { box-sizing: border-box; width: min(420px, calc(100vw - 32px)); max-width: none; margin: auto; padding: 18px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); box-shadow: 0 12px 36px rgba(0,0,0,.35); }
.ai-settings__leaveDialog::backdrop { background: rgba(0,0,0,.48); }
.ai-settings__leaveDialog p { margin: 10px 0 18px; color: var(--dsw-alias-label-secondary); }
.ai-settings__leaveActions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; }
@media (max-width: 560px) {
  .ai-settings__fields { grid-template-columns: minmax(0, 1fr); }
  .ai-settings__fields .is-wide { grid-column: auto; }
}
`;


export const SETTINGS_COMPONENT_CSS = [
  // 触发器：与设置页其它控件同款描边，右侧箭头表示可展开
  '.dsh-pet-mp{position:relative;min-width:0;display:flex;flex-direction:column;gap:4px}',
  '.dsh-pet-mp__trigger{display:flex;align-items:center;gap:6px;width:100%;max-width:none;height:28px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;text-align:left;cursor:pointer;outline:none}',
  '.dsh-pet-mp__trigger:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary)}',
  '.dsh-pet-mp__trigger:focus-visible{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}',
  '.dsh-pet-mp__trigger:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}',
  '.dsh-pet-mp__label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
  '.dsh-pet-mp__sub{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex-shrink:1000;color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary))}',
  '.dsh-pet-mp__chevron{flex:none;margin-left:auto;color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary));transition:transform .12s}',
  '.dsh-pet-mp__chevron.is-open{transform:rotate(180deg)}',
  // 浮层：position:fixed（与 DSH 一致——脱离设置页的滚动容器，不被 overflow 裁掉）
  // 浮层：position:fixed（与 DSH 一致——脱离设置页的滚动容器，不被 overflow 裁掉）；
  // z-index 取与插件右键菜单同一档（2147483000），保证压得住 DSH 自己的层叠上下文
  '.dsh-pet-mp__panel{position:fixed;z-index:2147483000;display:flex;flex-direction:column;gap:4px;padding:4px;overflow:hidden;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md,10px);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-prominent,0 8px 30px rgba(0,0,0,.35));color:var(--dsw-alias-label-primary);font-family:var(--dsh-pet-font-family,inherit)}',
  '.dsh-pet-mp__search{box-sizing:border-box;width:100%;height:28px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;outline:none}',
  '.dsh-pet-mp__search:focus{border-color:var(--dsw-alias-state-business-primary)}',
  '.dsh-pet-mp__list{display:flex;flex-direction:column;min-height:0;overflow-y:auto;scrollbar-width:thin}',
  '.dsh-pet-mp__group{padding:6px 8px 2px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}',
  '.dsh-pet-mp__item{display:flex;align-items:center;gap:8px;width:100%;padding:6px 8px;border:none;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer}',
  '.dsh-pet-mp__item:hover:not(:disabled),.dsh-pet-mp__item.is-active{background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsh-pet-mp__item[aria-checked="true"]{color:var(--dsw-alias-state-business-primary)}',
  '.dsh-pet-mp__item:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}',
  '.dsh-pet-mp__name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
  '.dsh-pet-mp__check{flex:none;margin-left:auto}',
  '.dsh-pet-mp__status{padding:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',

  // ===================== 设置页骨架（重构后） =====================
  // 这一段只放「伪类 / 悬浮 / 栅格」这类行内样式表达不了的东西；其余排版仍走组件里的行内 style。
  // 类名统一 dsh-pet-cfg__ 前缀，不会撞 DSH 自己的类名。

  // 页面根容器与标题
  '.dsh-pet-cfg{container-type:inline-size;box-sizing:border-box;width:100%;min-width:0;display:flex;flex-direction:column;gap:12px;overflow-x:clip;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;font-family:var(--dsh-pet-font-family,inherit)}',
  '.dsh-pet-cfg__pageHeader{display:flex;align-items:center;flex-wrap:wrap;gap:8px;min-width:0}',
  '.dsh-pet-cfg__titleGroup{display:flex;align-items:center;gap:6px;min-width:0}',
  '.dsh-pet-cfg__title{min-width:0;margin:0;font-size:16px;font-weight:500;line-height:24px}',

  // 卡片：宠物配置 / 全局开关 / AI 模型 / 物理 / 高级配置 / 卸载与存储 统一用这一个框
  '.dsh-pet-cfg__card{display:flex;flex-direction:column;gap:10px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px}',
  '.dsh-pet-cfg__cardHead{display:flex;align-items:center;gap:6px;min-height:20px;min-width:0}',
  '.dsh-pet-cfg__cardHeadActions{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-left:auto;flex:0 0 auto}',
  '.dsh-pet-cfg__cardTitle{min-width:0;margin:0;font-size:13px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-primary)}',
  '.dsh-pet-cfg__scope{margin-left:4px;padding:2px 7px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;font-size:11px;font-weight:400;line-height:16px;color:var(--dsw-alias-label-secondary);white-space:nowrap}',
  '.dsh-pet-cfg__sectionTitle{margin:16px 0 2px;font-size:15px;font-weight:600;line-height:22px;color:var(--dsw-alias-label-primary)}',
  '.dsh-pet-cfg__headerActions{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:8px;min-width:0;max-width:100%;margin-left:auto}',
  '.dsh-pet-cfg__subsection{display:flex;flex-direction:column;gap:10px;margin-top:4px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l2)}',
  '.dsh-pet-cfg__settingsSection{display:flex;flex-direction:column;gap:12px}',
  '.dsh-pet-cfg__pageTabs{display:flex;align-items:center;flex-wrap:wrap;gap:8px;border-bottom:1px solid var(--dsw-alias-border-l2);padding-bottom:8px}',
  '.dsh-pet-cfg__pageTab{display:inline-flex;align-items:center;justify-content:center;min-height:34px;padding:5px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;text-decoration:none;white-space:nowrap;cursor:pointer}',
  '.dsh-pet-cfg__pageTab:hover{background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsh-pet-cfg__pageTab.is-active{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-interactive-bg-active)}',
  '.dsh-pet-cfg__petList{display:flex;flex-direction:column;gap:8px}',
  '.dsh-pet-cfg__petListCard{display:grid;grid-template-columns:minmax(0,1fr) auto auto;align-items:center;gap:14px;width:100%;min-height:48px;padding:8px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer}',
  '.dsh-pet-cfg__petListCard:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsh-pet-cfg__petListCard.is-active{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-interactive-bg-active)}',
  '.dsh-pet-cfg__petListCard:disabled{opacity:.55;cursor:default}',
  '.dsh-pet-cfg__petListName{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.dsh-pet-cfg__petListMeta,.dsh-pet-cfg__petListAction{color:var(--dsw-alias-label-secondary);font-size:12px;white-space:nowrap}',
  '.dsh-pet-cfg__morePets{align-self:center;border:0;background:transparent;color:var(--dsw-alias-state-business-primary);font:inherit;font-size:12px;padding:6px 10px;cursor:pointer}',
  '.dsh-pet-cfg__morePets:disabled{opacity:.5;cursor:default}',
  '.dsh-pet-cfg__addPetCard{width:100%;min-height:48px;border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer}',
  '.dsh-pet-cfg__addPetCard:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
  '.dsh-pet-cfg__addPetCard:disabled{opacity:.55;cursor:default}',
  '.dsh-pet-cfg__cardActions{display:flex;justify-content:flex-end;padding-top:4px}',

  // 栅格：列数固定 → 行与行的控件自然对齐成一列
  '.dsh-pet-cfg__grid3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px 16px;align-items:end}',
  '.dsh-pet-cfg__grid4{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px 16px;align-items:end}',
  '.dsh-pet-cfg__grid5{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px 16px;align-items:end}',
  '.dsh-pet-cfg__grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 16px;align-items:end}',
  '.dsh-pet-cfg__apiKey{display:flex;flex-direction:column;gap:6px;padding:0 0 10px;border-bottom:1px solid var(--dsw-alias-border-l2)}',

  '@container (max-width:600px){.dsh-pet-cfg__grid4{grid-template-columns:repeat(2,minmax(0,1fr))}}',
  '@container (max-width:600px){.dsh-pet-cfg__grid5{grid-template-columns:repeat(2,minmax(0,1fr))}}',
  '@container (max-width:400px){.dsh-pet-cfg__grid2,.dsh-pet-cfg__grid3,.dsh-pet-cfg__grid4,.dsh-pet-cfg__grid5{grid-template-columns:minmax(0,1fr)}}',
  '@container (max-width:520px){.dsh-pet-cfg__petListCard{grid-template-columns:minmax(0,1fr) auto;gap:4px 10px}.dsh-pet-cfg__petListMeta{grid-column:1}.dsh-pet-cfg__petListAction{grid-column:2;grid-row:1 / span 2}}',
  '@media (max-width:560px){.dsh-pet-cfg__headerActions{width:100%;margin-left:0;justify-content:flex-start}}',

  // 字段：标签（+ 问号）在上、控件在下
  '.dsh-pet-cfg__field{display:flex;flex-direction:column;gap:4px;min-width:0}',
  '.dsh-pet-cfg__flabel{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--dsw-alias-label-secondary)}',

  // 输入 / 下拉
  '.dsh-pet-cfg__inp{box-sizing:border-box;width:100%;min-height:28px;padding:4px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none}',
  // 设置页下拉菜单共用同一套触发器、箭头、浮层和选项样式。
  '.dsh-pet-cfg__select{width:100%;max-width:none;height:auto;min-height:28px;padding:4px 10px}',
  '.dsh-pet-cfg__inp:focus{border-color:var(--dsw-alias-state-business-primary)}',
  '.dsh-pet-cfg__inp:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}',

  // 开关（勾选框 + 标题 + 问号）
  '.dsh-pet-cfg__toggle{display:flex;align-items:center;gap:6px;min-width:0;font-size:13px;color:var(--dsw-alias-label-primary)}',
  '.dsh-pet-cfg__toggle>label{display:inline-flex;align-items:center;gap:6px;cursor:pointer;min-width:0}',
  '.dsh-pet-cfg__toggle>label>span{overflow-wrap:anywhere}',
  '.dsh-pet-cfg__toggle input[type=checkbox]{flex:none;width:16px;height:16px;margin:0;accent-color:var(--dsw-alias-state-business-primary);cursor:pointer}',

  // 问号 + 悬浮说明：提示层挂到 body，避免被设置页滚动容器裁切。
  '.dsh-pet-cfg__q{position:relative;display:inline-flex;align-items:center;justify-content:center;flex:none;width:14px;height:14px;border:1px solid var(--dsw-alias-label-tertiary);border-radius:50%;color:var(--dsw-alias-label-tertiary);font-size:10px;font-style:normal;line-height:1;cursor:help;user-select:none}',
  '.dsh-pet-cfg__q:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}',
  '.dsh-pet-cfg__tooltip{position:fixed;z-index:2147483647;box-sizing:border-box;width:max-content;max-width:min(260px,calc(100vw - 24px));padding:6px 10px;border-radius:8px;background:var(--dsw-alias-tooltip-bg,#333);color:var(--dsw-alias-tooltip-text,#fff);font-family:var(--dsh-pet-font-family,inherit);font-size:12px;font-weight:400;line-height:18px;text-align:left;white-space:normal;pointer-events:none;box-shadow:0 6px 20px rgba(0,0,0,.22)}',

  // 按钮
  '.dsh-pet-cfg__btn{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:8px;padding:4px 14px;font:inherit;font-size:12px;line-height:20px;cursor:pointer;white-space:nowrap}',
  // 实心主按钮**必须排除**在通用 hover 之外：interactive-bg-hover 是半透明白（#ffffff14），
  // 直接顶掉 button-info-fill 会让蓝色保存按钮一悬停就变成一块发白的透明块，非常突兀。
  // 实心按钮的 hover 走主题自己的 button-info-hover（更深的蓝）。
  '.dsh-pet-cfg__btn:hover:not(:disabled):not(.is-primary){background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsh-pet-cfg__btn:disabled{opacity:.5;cursor:default}',
  '.dsh-pet-cfg__btn.is-primary{border-color:var(--dsw-alias-button-info-fill);background:var(--dsw-alias-button-info-fill);color:#fff}',
  '.dsh-pet-cfg__btn.is-primary:hover:not(:disabled){border-color:var(--dsw-alias-button-info-hover);background:var(--dsw-alias-button-info-hover)}',
  '.dsh-pet-cfg__btn.is-danger{border-color:var(--dsw-alias-state-error-secondary);color:var(--dsw-alias-state-error-primary)}',
  '.dsh-pet-cfg__btn.is-sm{padding:2px 10px}',
  '.dsh-pet-cfg__btn.is-ghost{border-style:dashed;color:var(--dsw-alias-label-secondary)}',

  // 宠物列表 tab
  '.dsh-pet-cfg__tabs{display:flex;gap:8px;flex-wrap:wrap;align-items:center}',
  '.dsh-pet-cfg__tabsLabel{font-size:12px;color:var(--dsw-alias-label-secondary)}',
  '.dsh-pet-cfg__tab{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:8px;padding:4px 12px;font:inherit;font-size:13px;cursor:pointer}',
  '.dsh-pet-cfg__tab:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsh-pet-cfg__tab:disabled{opacity:.5;cursor:default}',
  '.dsh-pet-cfg__tab.is-active{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-interactive-bg-active)}',
  '.dsh-pet-cfg__tab.is-ghost{border-style:dashed;color:var(--dsw-alias-label-secondary)}',

  // 操作区 / 提示文字 / 路径
  '.dsh-pet-cfg__actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:4px}',
  '.dsh-pet-cfg__savePanel{display:flex;flex-direction:column;gap:10px;margin-top:4px;padding:14px 16px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}',
  '.dsh-pet-cfg__saveHead{display:flex;flex-direction:column;gap:2px}',
  '.dsh-pet-cfg__saveTitle{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}',
  '.dsh-pet-cfg__saveHint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
  '.dsh-pet-cfg__saveRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
  '.dsh-pet-cfg__saveTools{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l2)}',
  '.dsh-pet-cfg__msg{margin-left:4px;font-size:12px;color:var(--dsw-alias-state-success-primary)}',
  '.dsh-pet-cfg__msg.is-err{color:var(--dsw-alias-state-error-primary)}',
  '.dsh-pet-cfg__note{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
  '.dsh-pet-cfg__path{font-size:12px;line-height:18px;word-break:break-all;user-select:text;color:var(--dsw-alias-label-secondary)}',
  '.dsh-pet-cfg__path b{color:var(--dsw-alias-label-primary);font-weight:400}',
  '.dsh-pet-cfg__cmd{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Courier New",monospace;font-size:12px;line-height:18px;word-break:break-all;user-select:text;padding:6px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary)}',
].join('\n');
