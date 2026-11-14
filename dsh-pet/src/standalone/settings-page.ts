/**
 * 本机设置页的 HTML 与 CSS；React 脚本作为独立构建产物提供。
 *
 * 只在本机回环上由 ./server 提供；不包含构建步骤，也不依赖外部 CDN。
 * 页面脚本从地址片段读一次令牌后立刻清掉片段；不内联脚本，CSP 保持 default-src 'none'。
 * @module dsh-pet/src/standalone/settings-page
 */
import { settingsPage } from './settings-page/chrome.ts';
import { settingsStyle } from './settings-page/style.ts';
import { SETTINGS_CSS } from '../client/settings/css.ts';

export { settingsPage };
export { settingsStyle };
export const standaloneSettingsStyle = settingsStyle + SETTINGS_CSS;
