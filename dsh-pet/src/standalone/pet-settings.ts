/**
 * 桌面应用内的桌宠配置表单。
 *
 * - 多开：管理多个桌宠，每个宠物独立 id/name/size/位置（corner + marginX/Y）
 * - 数据流：设置页持有「main 条目宠物列表」→ 保存时全量 PUT /dsh-pet-7340/config
 *   （写用户层 main-config.jsonc = 可编辑层，文件宠物永不回写）
 * - 数据入口：配置由 host readAllConfig 合并为**成品**（GET /dsh-pet-7340/config），
 *   设置页只读 main 条目（可编辑）+ 统计文件宠物条数，不做任何校验
 * - 即时生效：保存/同步后用 host 返回的**成品聚合**调用 petBridge.reload，
 *   容器走同一份 flattenConfigPets 重新渲染，无需刷新页面（设置页不自己拼任何条目级字段）
 *
 * 样式沿用 DSH 主题 token；页面由独立应用的设置窗口加载。
 */
import { flattenConfigPets, PET_DISPLAYS } from '../shared/config';
import { SettingsCardHeader, SettingsHelp, SettingsPageHeader, SettingsPageTab, SettingsPageTabs } from './settings-components';
import { applySettingsTheme, SETTINGS_COMPONENT_CSS } from './settings-style';
import { DEFAULT_FONT, FONT_PRESETS, FONT_SIZE_MAX, FONT_SIZE_MIN, fontStackOf } from '../shared/fonts';
import { NOTIFY_ICONS as NOTIFY_ICON_NAMES } from '../shared/notify';
import { DEFAULT_PHYSICS } from '../shared/physics';
import type {
  Corner,
  FontConfig,
  FontFamilyId,
  Pet,
  PetDisplay,
  PetDisplayPriority,
  PhysicsParams,
  UiTheme,
} from '../shared/types';
import type { ChangeEvent, Dispatch, FunctionComponent, SetStateAction } from 'react';
import type * as ReactNS from 'react';
import type { jsx } from 'react/jsx-runtime';

type NotificationPermissionResult =
  | { ok: true }
  | { ok: false; reason: 'unsupported' | 'denied' | 'rejected' | 'error'; message?: string };

async function requestNotificationPermission(): Promise<NotificationPermissionResult> {
  if (typeof Notification === 'undefined') return { ok: false, reason: 'unsupported' };
  if (Notification.permission === 'granted') return { ok: true };
  if (Notification.permission === 'denied') return { ok: false, reason: 'denied' };
  try {
    const permission = await Notification.requestPermission();
    if (permission === 'granted') return { ok: true };
    if (permission === 'denied') return { ok: false, reason: 'rejected' };
    return { ok: false, reason: 'error', message: '权限未授予（' + permission + '）' };
  } catch (error) {
    return { ok: false, reason: 'error', message: error instanceof Error ? error.message : String(error) };
  }
}

const NOTIFY_TEST_ICON = '/dsh-pet-7340/pic/' + NOTIFY_ICON_NAMES.test + '.png';

/** 容器与设置页共享的桥（同一 bundle 单例）：
 * current=最新完整宠物列表（**成品拍平**，含条目级字段与文件宠物，默认空；容器是唯一写入方）；
 * reload=容器注册的重载回调（未注册时为无操作函数）：传 host 保存接口返回的成品聚合即直接拍平，
 *   缺省则由容器自行 GET /config；template=main 条目的宠物[0]（「添加宠物」用它作为默认配置） */
export const petBridge: {
  current: Pet[];
  reload: (merged?: Record<string, Record<string, unknown>>) => void;
  template: Pet | undefined;
} = {
  current: [],
  reload: () => {},
  template: undefined,
};

/** 字典命名空间 */
export const NS = 'pet.config';

/** 设置页共用样式：包含统一风格的自定义选择器与表单布局。 */
const SETTINGS_CSS = SETTINGS_COMPONENT_CSS;

const settingsCssTag = 'dsh-pet/settings.css';
/** 注入设置页 CSS（只注入一次；与宠物页面 injectCss 同一套 data-plugin-css 去重） */
function injectSettingsCss(): void {
  if (typeof document === 'undefined') return;
  if (document.querySelector('style[data-plugin-css="' + settingsCssTag + '"]') !== null) return;
  const tag = document.createElement('style');
  tag.dataset.plugin = 'dsh-pet';
  tag.dataset.pluginCss = settingsCssTag;
  tag.textContent = SETTINGS_CSS;
  document.head.appendChild(tag);
}

export const zh = {
  nav: '桌宠配置',
  intro: '管理多个桌宠：每个宠物可独立设置大小与首次启动位置（保存后即时生效）。',
  // 卡片标题 + 卡片级说明（说明都进问号，不再占一行小字）
  petCardHint:
    '每只宠物独立配置：名字 / 大小 / 显示位置 / 首次启动位置与偏移 / 功能与移动开关。修改后点击顶部的「保存设置」应用。',
  globalControlsTitle: '通知与显示',
  petSettingsList: '桌宠设置',
  globalSettingsList: '全局设置',
  showMorePets: '显示更多桌宠（还有 {n} 只）',
  collapsePets: '收起列表',
  addPetCard: '+ 添加桌宠',
  newPetTitle: '新桌宠设置',
  savePet: '保存桌宠',
  cancelAddPet: '取消新增',
  allPetsScope: '所有桌宠共用',
  globalDefaultScope: '全局默认，可覆盖',
  appWideScope: '应用级',
  applicationTitle: '应用本身',
  globalHint: '通知与显示设置作用于全部桌宠，修改后点击“保存设置”应用；“应用本身”中的设置按各自控件保存。',
  cornerHint:
    '首次启动或没有位置记录时，宠物按这里选择的角落出现；之后启动会恢复上次位置。右键「回到初始位置」也会回到这里（桌面端按主显示器工作区计算）。',
  marginXHint: '首次启动位置距所选角落的水平距离（px）；右键「回到初始位置」时也使用此值。',
  marginYHint: '首次启动位置距所选角落的垂直距离（px）；右键「回到初始位置」时也使用此值。',
  // 「/」命令菜单里的行标题（图标由 app.ts 经 command-faces.ts 补上）
  'cmd.chat': '对话',
  'cmd.pet': '桌宠',
  'cmd.balance': '余额',
  petsLabel: '宠物列表',
  add: '添加宠物',
  remove: '删除',
  confirmRemove: '确定删除宠物「{id}」吗？确认后会保存当前设置并重载桌宠。',
  confirmTitle: '确认操作',
  cancel: '取消',
  ok: '知道了',
  atLeastOne: '至少保留一个宠物。',
  emptyPets: '暂无宠物，点击「添加宠物」创建。',
  sizeLabel: '大小（宽度 px）',
  sizeHint: '高度自动 = 宽度 × 9/16。',
  personaLabel: '人设（可选）',
  personaHint: '只影响这只桌宠。留空时跟随所属配置的人设；名字和当前时间由系统自动追加。',
  nameLabel: '名字',
  nameHint: '显示名：鼠标悬浮宠物时弹出，也会加进 AI 人设（你的名字是 X）。可重复，留空按宠物 id 处理。',
  balanceEnabled: '余额功能',
  balanceEnabledHint: '启用后该宠物触发余额动画并显示余额气泡。',
  whisperEnabled: '碎碎念',
  whisperEnabledHint: '启用后该宠物参加定时自动碎碎念；全局开关和间隔在独立 AI 设置页配置。右键菜单手动触发不受此项限制。',
  workStatusEnabled: '工作状态联动',
  workStatusEnabledHint:
    '启用后该宠物跟随 DSH 工作状态：思考/工作中/等待确认/完成/出错时自动切对应动画并弹气泡（动画池在配置顶层，仅监听不调用模型）。',
  fixedEnabled: '宠物固定',
  fixedEnabledHint:
    '启用后随机动画不再让宠物自己转向或走开，只播原地待机与随机小动作；右键菜单点播、接口触发、余额/碎碎念/工作状态动画不受影响。',
  horizontalOnly: '仅允许横向移动',
  horizontalOnlyHint:
    '启用后自动漫游和右键菜单中的移动动作只沿水平方向行走，不再纵向移动或走斜线；拖拽与抛掷仍按你的操作执行。',
  displayLabel: '显示位置',
  displayHint: '桌宠只在 Windows 桌面显示，也可关闭显示。',
  'display.desktop': '仅桌面',
  'display.none': '不显示',
  cornerLabel: '首次启动位置',
  'corner.top-left': '左上角',
  'corner.top-right': '右上角',
  'corner.bottom-left': '左下角',
  'corner.bottom-right': '右下角',
  marginX: '水平偏移',
  marginY: '垂直偏移',
  save: '保存设置',
  saveHintPets: '保存桌宠设置，并同时保存已修改的全局设置，随后应用到桌宠。“应用本身”中的设置按各自控件保存。',
  saveHintGlobal: '保存全局设置，并同时保存已修改的桌宠设置，随后应用到桌宠。“应用本身”中的设置按各自控件保存。',
  sync: '恢复默认配置',
  confirmSync: '确定恢复默认配置吗？这会用项目内置默认配置覆盖用户配置，当前自定义内容会丢失。',
  corruptTitle: '用户配置已损坏，未保存',
  corruptConfirm: '强行保存',
  corruptBody:
    '用户配置文件解析不了（内容已损坏，不是合法 JSON/JSONC）：{path}。继续保存会按白名单重建这个文件——它里面现有的内容（animations / physics / memes 等自定义字段）会全部丢失。取消 = 不动文件（先去把配置改回合法再保存）；确认 = 强行保存（丢弃文件里现有的内容）。',
  syncHint:
    '「恢复默认配置」会把项目内置默认配置（含注释与全部高级字段）写入用户配置文件，覆盖当前自定义内容。此文件生成后属于显式覆盖层，插件升级不会自动覆盖它；本页点击「保存设置」会按白名单重写此文件，保留字段值但移除注释。',
  configMeta: '高级配置（文件）',
  configMetaHint:
    '用户配置可覆盖宠物列表 / 动画池 / 播放权重。手动修改后，使用桌宠右键菜单中的「重载配置」应用；默认配置为完整参考。',
  defaultConfig: '默认配置（只读，完整参考）',
  userConfig: '用户配置（自定义覆盖）',
  animationDir: '动画素材目录（可自定义/扩充动画）',
  memesDir: '表情包目录（可自定义/扩充配图）',
  saved: '已保存，桌宠即时生效。',
  loadError: '加载配置失败',
  loading: '正在加载配置…',
  retry: '重试',
  invalid: '请检查输入：大小需为正数，边距可为任意数字。',
  busy: '保存中…',
  extraPetsHint:
    '另 {n} 只额外宠物由 pet/ 目录文件定义（<名>-config.json + <名>-animation/ + <名>-memes/），它们不在此列表——修改文件后使用桌宠右键菜单中的「重载配置」应用。',
  notifyToggle: 'DSH 通知',
  notifyToggleHint: '控制 DSH 工作流和桌宠对话回复的通知。',
  whisperImageToggle: '碎碎念配图',
  whisperImageToggleHint:
    '碎碎念时从表情包池随机抽一张，连同那句话一起显示（图片映射在配置文件顶层 memes）。token：碎碎念本来就每次生成都要调一次模型，配图只是把抽中那张的名称+描述（约 100 字符 / ≈60 token）加进同一次请求，增量可忽略。',
  chatImageToggle: '对话配图',
  chatImageToggleHint:
    '对话时由 AI 按当前语境从表情包池挑一张配图（可不挑；图片映射在配置文件顶层 memes）。token：每条消息都要把整张清单附进请求，当前约 1.1k 字符（≈650 token，约碎碎念配图的 11 倍），并随图片数量线性增长；关掉则一个字符都不附。',
  confineToggle: '抛掷锁定在当前屏幕',
  confineToggleHint:
    '多屏用户：甩出去的宠物只在松手时所在那块屏幕内弹（屏缝当墙，不飞到隔壁屏）；关掉则照常跨屏飞行。',
  trayToggle: '系统托盘',
  trayToggleHint:
    '关闭后隐藏系统托盘图标。桌面仍有宠物时，可从桌宠右键菜单打开设置或退出；没有桌面宠物时会自动打开设置页，关闭设置页将退出应用。保存后生效。',
  displayPriorityLabel: '桌宠显示层级',
  displayPriorityHint:
    '全局设置，只影响桌面模式。Windows 可检测前台全屏应用；选择“全屏或最大化时自动隐藏”时，也会检测最大化窗口并隐藏其所在显示器上的桌宠。macOS 跟随全屏空间隐藏，Linux 暂不支持检测其它应用窗口。',
  'displayPriority.always-on-top': '始终置顶',
  'displayPriority.hide-on-fullscreen': '全屏时自动隐藏',
  'displayPriority.hide-on-fullscreen-or-maximized': '全屏或最大化时自动隐藏',
  'displayPriority.normal': '不置顶',
  physicsTitle: '物理（拖拽抛掷手感）',
  physicsHint:
    '全局默认，所有宠物共用（pet pack 可在自己种类文件里单独覆盖）；点击「保存」后写入配置并重载桌宠窗口。',
  'physics.gravity': '重力 gravity',
  'physics.gravityHint': 'px/s²，越大落得越快；0 = 无重力（抛出去匀速直线飞）',
  'physics.restitution': '弹性 restitution',
  'physics.restitutionHint': '0~1，碰壁 / 落地反弹保留的速度比例（1 = 完全弹性，0 = 撞上即停）',
  'physics.groundFriction': '地面摩擦 groundFriction',
  'physics.groundFrictionHint': '/s，落地后水平速度的衰减率；0 = 冰面不减速',
  'physics.throwPower': '总力度 throwPower',
  'physics.throwPowerHint': '> 0，弹簧跟手与甩出初速的整体倍率（1 = 默认；越大越跟手、甩得越猛）',
  physicsCeilingBounce: '顶部反弹 ceilingBounce',
  physicsCeilingBounceHint: '关掉后抛掷可飞出屏幕顶部（重力仍会把它拉回来）',
  physicsPetCollision: '宠物互撞 petCollision',
  physicsPetCollisionHint: '飞行中的宠物撞到别的宠物按动量守恒弹开（质量 ∝ 尺寸²）',
  invalidPhysics: '请检查物理参数：重力 / 地面摩擦 ≥ 0，弹性 0~1，总力度 > 0。',
  fontTitle: '外观与字体',
  uiThemeLabel: '主题',
  uiThemeHint: '控制设置界面和桌宠右键菜单的外观；自适应主题会跟随 Windows 外观。保存后应用。',
  'uiTheme.system': '自适应主题',
  'uiTheme.light': '白天',
  'uiTheme.dark': '黑夜',
  fontHint:
    '字体种类作用于现在用软糖体的全部文字：宠物气泡、悬浮提示、对话窗、得分弹窗；字号只作用于宠物气泡与悬浮提示（对话窗与得分弹窗的字号不变）。全局默认，所有宠物共用（pet pack 可在自己种类文件里单独覆盖）；点击「保存」后写入配置并重载桌宠窗口。',
  fontFamilyLabel: '字体',
  fontFamilyHint:
    '「软糖体（内置）」随插件提供；其余为系统字体，机器上没装时自动回退到字体栈里的下一个（不会空白或报错）。',
  fontSizeLabel: '字号（px）',
  fontSizeHint: '气泡正文字号；悬浮提示与气泡内的小字按既有比例派生。范围 4~200。',
  fontFollowToggle: '字号随宠物大小缩放',
  fontFollowToggleHint:
    '开启（默认）：宠物调大时字号等比放大，462 宽时正好是上面设定的字号；关闭：字号恒定，不随宠物大小变化。',
  invalidFont: '请检查字体设置：字体需在下拉列表内，字号需为 4~200 的数字。',
  'font.candy': '软糖体（内置）',
  'font.yahei': '微软雅黑 / 苹方',
  'font.youyuan': '幼圆',
  'font.kaiti': '楷体',
  'font.simsun': '宋体',
  'font.comic': '漫画体',
  'font.system': '系统默认',
  notifyTest: '测试弹窗',
  notifyTestOk: '测试通知已发送，请查看桌面右下角。',
  notifyDenyUnsupported: '当前环境不支持系统通知。',
  notifyDenyBlocked: '系统通知权限已被阻止。',
  notifyDenyRejected: '你在权限询问弹窗中选择了「阻止」。',
  notifyDenyError: '申请权限时出错',
  notifyGuide: '请在 Windows 设置的“系统 > 通知”中允许 DSH Pet 发送通知。',
  standaloneStorageTitle: '数据与缓存',
  standaloneStorageHint: '独立版运行所需的数据目录与缓存位置。用户数据包含自定义配置、对话记忆和自定义素材。',
  standaloneStorageNote:
    '退出桌宠请使用系统托盘菜单中的「退出 DSH Pet」。删除用户数据会清除配置、对话记忆和自定义素材。',
  'storage.userData':
    '插件用户数据：自定义配置 main-config.jsonc、对话记忆 memory.json、自定义动画素材 main-animation/、文件宠物 pet/',
  'storage.electron': '桌面宠物用的 Electron 运行时（体积较大；删除后下次启动会自动重新下载）',
  'storage.desktopCache': '桌面宠物窗口的缓存与主屏缩放缓存（可删，会自动重建）',
  storageMissing: '（尚未创建）',
};

export const en = {
  nav: 'Pet Config',
  intro: 'Manage multiple pets: each pet has its own size and first-launch position (applies instantly after saving).',
  // Card titles + card-level help (all hints move into the "?" bubble)
  petCardHint:
    'Per-pet settings: name / size / display / first-launch position and offsets / feature and movement switches. Click “Save Settings” in the page header to apply changes.',
  globalControlsTitle: 'Notifications & display',
  petSettingsList: 'Pet settings',
  globalSettingsList: 'Global settings',
  showMorePets: 'Show more pets ({n} remaining)',
  collapsePets: 'Show fewer',
  addPetCard: '+ Add a pet',
  newPetTitle: 'New pet settings',
  savePet: 'Save pet',
  cancelAddPet: 'Cancel',
  allPetsScope: 'All pets',
  globalDefaultScope: 'Global default; overridable',
  appWideScope: 'App-wide',
  applicationTitle: 'Application',
  globalHint: 'Notification and display settings apply to all pets; click Save Settings to apply them. Use each control to save settings under Application.',
  cornerHint:
    'Used on the first launch or when no saved position exists; later launches restore the last position. The right-click “Go home” action also returns here (primary display work area in desktop mode).',
  marginXHint: 'Horizontal offset (px) for the first-launch position and the right-click “Go home” position.',
  marginYHint: 'Vertical offset (px) for the first-launch position and the right-click “Go home” position.',
  // Row titles in the "/" command menu (icons are added by app.ts)
  'cmd.chat': 'Chat',
  'cmd.pet': 'Pet',
  'cmd.balance': 'Balance',
  petsLabel: 'Pets',
  add: 'Add pet',
  remove: 'Remove',
  confirmRemove: 'Delete pet "{id}"? Current settings will be saved and the pets reloaded.',
  confirmTitle: 'Confirm action',
  cancel: 'Cancel',
  ok: 'Got it',
  atLeastOne: 'Keep at least one pet.',
  emptyPets: 'No pets yet — click "Add pet" to create one.',
  sizeLabel: 'Size (width px)',
  sizeHint: 'Height is automatic = width × 9/16.',
  personaLabel: 'Persona (optional)',
  personaHint: 'Applies to this pet only. Leave empty to follow the entry persona; the name and current time are appended automatically.',
  nameLabel: 'Name',
  nameHint:
    'Shown on hover and added to AI personas ("your name is X"). Duplicates allowed; empty falls back to the pet id.',
  balanceEnabled: 'Balance',
  balanceEnabledHint: 'When enabled, this pet plays balance animations and shows the balance bubble.',
  whisperEnabled: 'Whisper',
  whisperEnabledHint:
    'When enabled, this pet can join scheduled whispers. The global switch and interval are in Standalone AI Settings. Manual menu actions are unaffected.',
  workStatusEnabled: 'Work status',
  workStatusEnabledHint:
    'When enabled, this pet follows DSH work state: thinking / working / waiting / done / error switch animations and show bubbles (pool in top-level config; listening only, no model calls).',
  fixedEnabled: 'Pin in place',
  fixedEnabledHint:
    'When enabled, the random chain no longer turns this pet or walks it away — only idle and in-place actions play. Right-click picks, API triggers and balance / whisper / work-status animations are unaffected.',
  horizontalOnly: 'Horizontal movement only',
  horizontalOnlyHint:
    'Automatic wandering and context-menu movement stay at the same height and use a 0° path. Dragging and throwing still follow your input.',
  displayLabel: 'Display',
  displayHint: 'Show the pet on the Windows desktop, or hide it.',
  'display.desktop': 'Desktop only',
  'display.none': 'Hidden',
  cornerLabel: 'First-launch position',
  'corner.top-left': 'Top-left',
  'corner.top-right': 'Top-right',
  'corner.bottom-left': 'Bottom-left',
  'corner.bottom-right': 'Bottom-right',
  marginX: 'Horizontal offset',
  marginY: 'Vertical offset',
  save: 'Save settings',
  saveHintPets: 'Save pet settings and any changed global settings, then apply them to the pets. Use the controls under Application to save those settings.',
  saveHintGlobal: 'Save global settings and any changed pet settings, then apply them to the pets. Use the controls under Application to save those settings.',
  sync: 'Restore defaults',
  confirmSync:
    'Restore the default configuration? This overwrites the user config with the bundled defaults and removes current customizations.',
  corruptTitle: 'User config is corrupted — not saved',
  corruptConfirm: 'Save anyway',
  corruptBody:
    'The user config file cannot be parsed (corrupted, not valid JSON/JSONC): {path}. Saving now rebuilds it from the whitelist — everything currently in that file (animations / physics / memes …) will be lost. Cancel = leave the file untouched (fix it and save again); Confirm = save anyway (discard what is in the file).',
  syncHint:
    '"Restore defaults" writes the bundled default config (including comments and advanced fields) to the user config file, overwriting customizations. Once created, this file is an override layer and will not be replaced automatically on plugin upgrades. Clicking "Save settings" rewrites it from a whitelist, preserving values but removing comments.',
  configMeta: 'Advanced (files)',
  configMetaHint:
    'User config may override pets / animation pools / weights. After editing files, use a desktop pet’s “Reload config” menu item to apply them. The default config is the complete reference.',
  defaultConfig: 'Default config (read-only, complete reference)',
  userConfig: 'User config (custom overrides)',
  animationDir: 'Animation assets dir (add/customize animations here)',
  memesDir: 'Meme images dir (add/customize images here)',
  saved: 'Saved — the pets updated instantly.',
  loadError: 'Failed to load config',
  loading: 'Loading config…',
  retry: 'Retry',
  invalid: 'Check your input: size must be positive; margins can be any number.',
  busy: 'Saving…',
  extraPetsHint:
    '{n} extra pet(s) are file-defined in the pet/ directory (<name>-config.json + <name>-animation/ + <name>-memes/). They are not in this list — after editing the files, use a desktop pet’s “Reload config” menu item.',
  notifyToggle: 'DSH notifications',
  notifyToggleHint: 'Controls notifications for DSH workflow events and pet chat replies.',
  whisperImageToggle: 'Whisper images',
  whisperImageToggleHint:
    'Attach one random meme from the pool to each whisper line (image mapping lives in the top-level `memes` config field). Tokens: a whisper already calls the model every cycle, so the image only appends the name + description of that one meme (~100 chars / ~60 tokens) to the same request — negligible.',
  chatImageToggle: 'Chat images',
  chatImageToggleHint:
    'Let the AI pick one meme from the pool that fits the current context (optional; mapping lives in the top-level `memes` config field). Tokens: every message carries the whole catalog — currently ~1.1k chars (~650 tokens, about 11x the whisper case) and growing with the number of images; turning this off appends nothing at all.',
  confineToggle: 'Lock throws to the current screen',
  confineToggleHint:
    'Multi-monitor: a thrown pet bounces only inside the screen it was released on (screen seams act as walls, so it never flies to the neighbouring monitor); turn this off to let it cross screens as usual.',
  trayToggle: 'System tray',
  trayToggleHint:
    'Hides the system tray icon when turned off. If a desktop pet is visible, open settings or quit from its right-click menu. If no desktop pets are visible, the settings page opens automatically; closing it exits the app. Applies after saving.',
  displayPriorityLabel: 'Pet window priority',
  displayPriorityHint:
    'Global desktop-mode setting. Windows detects foreground fullscreen apps; “Hide during fullscreen or maximized windows” also detects maximized windows and hides pets on that monitor. macOS follows fullscreen Spaces; Linux does not detect other application windows.',
  'displayPriority.always-on-top': 'Always on top',
  'displayPriority.hide-on-fullscreen': 'Hide during fullscreen',
  'displayPriority.hide-on-fullscreen-or-maximized': 'Hide during fullscreen or maximized windows',
  'displayPriority.normal': 'Normal window level',
  physicsTitle: 'Physics (drag & throw feel)',
  physicsHint:
    'Global default, shared by every pet (a pet pack may override it in its own kind file); clicking “Save” writes it and reloads the pet windows.',
  'physics.gravity': 'Gravity',
  'physics.gravityHint': 'px/s² — the higher, the faster it falls; 0 = weightless (flies straight forever)',
  'physics.restitution': 'Bounciness',
  'physics.restitutionHint':
    '0–1, speed kept when bouncing off a wall or the floor (1 = perfectly elastic, 0 = stops dead)',
  'physics.groundFriction': 'Ground friction',
  'physics.groundFrictionHint': 'per second, horizontal damping while on the ground; 0 = frictionless ice',
  'physics.throwPower': 'Throw power',
  'physics.throwPowerHint':
    '> 0, overall multiplier for spring tracking and release speed (1 = default; higher = tighter tracking, harder throws)',
  physicsCeilingBounce: 'Ceiling bounce',
  physicsCeilingBounceHint:
    'Turn this off to let a throw fly out through the top of the screen (gravity still pulls it back)',
  physicsPetCollision: 'Pet collisions',
  physicsPetCollisionHint: 'A flying pet bounces off the others with momentum conservation (mass ∝ size²)',
  invalidPhysics: 'Check the physics values: gravity / ground friction ≥ 0, bounciness 0–1, throw power > 0.',
  fontTitle: 'Appearance & font',
  uiThemeLabel: 'Theme',
  uiThemeHint: 'Controls the settings interface and pet context menu. System follows the Windows appearance. Save to apply.',
  'uiTheme.system': 'System',
  'uiTheme.light': 'Light',
  'uiTheme.dark': 'Dark',
  fontHint:
    'The family applies to every place that currently uses the candy font: pet bubble, hover tooltip, chat popup, score popup. The size applies only to the pet bubble and the hover tooltip (chat and score popups keep their own size). Global default, shared by every pet (a pet pack may override it in its own kind file); clicking “Save” writes it and reloads the pet windows.',
  fontFamilyLabel: 'Font',
  fontFamilyHint:
    '"Candy (bundled)" ships with the plugin; the others are system fonts. If a font is missing on this machine, it falls back to the next one in the stack (never blank, never an error).',
  fontSizeLabel: 'Font size (px)',
  fontSizeHint:
    'Bubble body text size; the tooltip and the smaller lines inside the bubble scale proportionally. Range 4–200.',
  fontFollowToggle: 'Scale font with pet size',
  fontFollowToggleHint:
    'On (default): the font grows with the pet — at 462 px width it is exactly the size above. Off: the size stays fixed regardless of pet size.',
  invalidFont:
    'Check the font settings: the family must be in the list and the size must be a number between 4 and 200.',
  'font.candy': 'Candy (bundled)',
  'font.yahei': 'Microsoft YaHei / PingFang',
  'font.youyuan': 'YouYuan',
  'font.kaiti': 'KaiTi',
  'font.simsun': 'SimSun',
  'font.comic': 'Comic Sans MS',
  'font.system': 'System default',
  notifyTest: 'Test notification',
  notifyTestOk: 'Test notification sent — check the bottom-right of your desktop.',
  notifyDenyUnsupported: 'System notifications are not supported in this environment (no Notification API).',
  notifyDenyBlocked: 'System notification permission is blocked.',
  notifyDenyRejected: 'You chose "Block" in the permission prompt.',
  notifyDenyError: 'Failed to request permission',
  notifyGuide: 'Allow DSH Pet notifications in Windows Settings under System > Notifications.',
  standaloneStorageTitle: 'Data and cache',
  standaloneStorageHint:
    'Local data and cache paths used by the standalone app. User data contains custom config, chat memory, and custom assets.',
  standaloneStorageNote:
    'Quit the app from the DSH Pet system tray menu. Deleting user data removes config, chat memory, and custom assets.',
  'storage.userData':
    'Plugin user data: custom config main-config.jsonc, chat memory memory.json, custom animation assets main-animation/, file pets pet/',
  'storage.electron': 'Electron runtime used by the desktop pet (large; re-downloaded automatically the next time the app starts)',
  'storage.desktopCache':
    'Desktop pet window cache and primary-monitor scale cache (safe to delete, rebuilt automatically)',
  'storage.electronCache': 'Electron installer download cache (safe to delete, re-downloaded when needed)',
  storageMissing: ' (not created yet)',
};

/**
 * 制造「桌宠配置」设置页组件（工厂函数）。
 *
 * 设置窗口在运行时提供 React 能力，因此把组件依赖作为参数传入，
 * 在工厂内创建设置页组件，避免将 React 打入桌宠宿主 bundle。
 *
 * @param rt        运行时注入的依赖集合
 * @param rt.h      react/jsx-runtime 的 jsx 函数（即 factory 里的 `h`）——
 *                  用于手写 React 元素，如 `h('button', { onClick, children: '保存' })`
 * @param rt.useState react 的 useState hook——管理页面内可变状态
 *                  （宠物列表 / 选中项 / 忙碌 / 保存消息），值变化时自动重渲染
 * @param rt.useRef react 的 useRef hook——「AI 模型」单下拉选择器用它拿触发器/浮层节点
 *                  （浮层定位与"点外面关闭"判定），与宠物页面同一份注入
 * @param rt.t      设置页的翻译函数，取中英文文案，如 `t('nav')` → '桌宠配置' / 'Pet Config'
 * @returns PetConfigSection 组件：即整个「桌宠配置」设置页
 *          （props 仅有 close，由设置页外壳提供，本页当前未使用）
 */
export function makePetConfigSection(rt: {
  h: typeof jsx;
  useState: <T>(init: T) => [T, Dispatch<SetStateAction<T>>];
  // 用 React 命名空间类型而非 typeof：type-only import 的 hook 无法进入声明导出（TS4078）
  useEffect: (effect: ReactNS.EffectCallback, deps?: ReactNS.DependencyList) => void;
  useRef: <T>(initial: T) => ReactNS.MutableRefObject<T>;
  useCallback: typeof ReactNS.useCallback;
  createPortal?: (children: ReactNS.ReactNode, container: Element | DocumentFragment) => ReactNS.ReactPortal;
  t: (key: string) => string;
  notificationIcon?: string;
  notificationAppName?: string;
  standaloneAddon?: ReactNS.ReactNode;
}): FunctionComponent<{ close?: () => void }> {
  const { h, useState, useEffect, useRef, useCallback, t } = rt;
  const notificationIcon = rt.notificationIcon ?? NOTIFY_TEST_ICON;
  const notificationAppName = rt.notificationAppName ?? 'DSH Pet';
  const floating = (node: ReactNS.ReactNode): ReactNS.ReactNode =>
    rt.createPortal ? rt.createPortal(node, document.body) : node;
  const displayOptions: PetDisplay[] = PET_DISPLAYS;

  // 设置页样式（自定义下拉菜单的 hover、焦点环和箭头动画需要样式表）。
  injectSettingsCss();

  const CORNERS: Corner[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
  const cornerLabel = (c: Corner): string => t('corner.' + c);

  const inputClass = 'dsh-pet-cfg__inp';

  /** 等宽字体栈（路径与命令展示用；不引外部字体，走系统栈，避免多拉一份资源） */

  /** 生成一个未占用的宠物 id（pet-2、pet-3…） */
  const nextId = (list: Pet[]): string => {
    let n = 2;
    for (; ; n++) {
      const id = 'pet-' + n;
      if (!list.some((p) => p.id === id)) return id;
    }
  };

  /** 全局与桌宠设置共用同一套可键盘访问、不会被滚动容器裁切的帮助提示。 */
  const q = (tip: string, end = false, key?: string): ReturnType<typeof h> => h(SettingsHelp, { tip, end }, key);

  /** Native select popups ignore CSS corner radius on Windows; render these two short lists in-page. */
  const ConfigSelect: FunctionComponent<{
    label: string;
    value: string;
    fontFamily: string;
    options: Array<{ value: string; label: string }>;
    disabled: boolean;
    onChange: (value: string) => void;
  }> = (props) => {
    const [open, setOpen] = useState(false);
    const [active, setActive] = useState(
      Math.max(
        0,
        props.options.findIndex((o) => o.value === props.value),
      ),
    );
    const [pos, setPos] = useState<null | { left: number; top: number; width: number; maxHeight: number }>(null);
    const rootRef = useRef<HTMLDivElement | null>(null);
    const panelRef = useRef<HTMLDivElement | null>(null);
    const selected = props.options.find((o) => o.value === props.value) ?? props.options[0];

    useEffect(() => {
      if (!open) return;
      const place = (): void => {
        const root = rootRef.current;
        if (!root) return;
        const r = root.getBoundingClientRect();
        const below = Math.max(0, window.innerHeight - r.bottom - 8);
        const above = Math.max(0, r.top - 8);
        // 每项高 32px；面板另有 4px 间距、上下各 4px 内边距和 1px 边框。
        // 旧值只算了条目和内边距，面板因此比内容短，overflow:hidden 会裁掉末项的 Hover 背景。
        const desired = Math.min(240, props.options.length * 32 + Math.max(0, props.options.length - 1) * 4 + 10);
        const up = below < desired && above > below;
        const maxHeight = Math.max(32, Math.min(desired, up ? above : below));
        setPos({
          left: Math.max(8, Math.min(r.left, window.innerWidth - r.width - 8)),
          top: up ? Math.max(8, r.top - maxHeight - 4) : r.bottom + 4,
          width: r.width,
          maxHeight,
        });
      };
      place();
      const onDown = (e: MouseEvent): void => {
        const target = e.target as Node | null;
        if (target && (rootRef.current?.contains(target) === true || panelRef.current?.contains(target) === true))
          return;
        setOpen(false);
      };
      const onKey = (e: KeyboardEvent): void => {
        if (e.key === 'Escape') setOpen(false);
      };
      document.addEventListener('mousedown', onDown, true);
      document.addEventListener('keydown', onKey, true);
      window.addEventListener('scroll', place, true);
      window.addEventListener('resize', place);
      return () => {
        document.removeEventListener('mousedown', onDown, true);
        document.removeEventListener('keydown', onKey, true);
        window.removeEventListener('scroll', place, true);
        window.removeEventListener('resize', place);
      };
    }, [open, props.options.length]);

    const choose = (option: { value: string; label: string }): void => {
      props.onChange(option.value);
      setActive(props.options.findIndex((o) => o.value === option.value));
      setOpen(false);
    };
    const onTriggerKeyDown = (e: ReactNS.KeyboardEvent<HTMLButtonElement>): void => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!open) {
          setActive(
            Math.max(
              0,
              props.options.findIndex((o) => o.value === props.value),
            ),
          );
          setOpen(true);
        } else {
          setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : props.options.length - 1)) % props.options.length);
        }
      } else if ((e.key === 'Enter' || e.key === ' ') && open) {
        e.preventDefault();
        const option = props.options[active];
        if (option) choose(option);
      } else if ((e.key === 'Enter' || e.key === ' ') && !open) {
        e.preventDefault();
        setOpen(true);
      }
    };

    return h('div', {
      ref: rootRef,
      style: { position: 'relative', minWidth: 0 },
      children: [
        h('button', {
          key: 'trigger',
          type: 'button',
          className: 'dsh-pet-mp__trigger dsh-pet-cfg__select',
          disabled: props.disabled,
          'aria-label': props.label,
          'aria-haspopup': 'listbox',
          'aria-expanded': open,
          onClick: () => {
            setActive(
              Math.max(
                0,
                props.options.findIndex((o) => o.value === props.value),
              ),
            );
            setOpen((v) => !v);
          },
          onKeyDown: onTriggerKeyDown,
          children: [
            h('span', { key: 'label', className: 'dsh-pet-mp__label', children: selected?.label ?? '' }),
            h('span', {
              key: 'arrow',
              className: 'dsh-pet-mp__chevron' + (open ? ' is-open' : ''),
              'aria-hidden': true,
              children: '▾',
            }),
          ],
        }),
        open && pos
          ? floating(
              h('div', {
                key: 'panel',
                ref: panelRef,
                className: 'dsh-pet-mp__panel',
                role: 'listbox',
                'aria-label': props.label,
                style: {
                  left: pos.left + 'px',
                  top: pos.top + 'px',
                  width: pos.width + 'px',
                  maxHeight: pos.maxHeight + 'px',
                  fontFamily: props.fontFamily,
                },
                children: props.options.map((option, index) =>
                  h('button', {
                    key: option.value,
                    type: 'button',
                    className: 'dsh-pet-mp__item' + (index === active ? ' is-active' : ''),
                    role: 'option',
                    'aria-selected': option.value === props.value,
                    onMouseMove: () => setActive(index),
                    onClick: () => choose(option),
                    children: [
                      h('span', { key: 'label', className: 'dsh-pet-mp__name', children: option.label }),
                      h('span', {
                        key: 'check',
                        className: 'dsh-pet-mp__check',
                        children: option.value === props.value ? '✓' : '',
                      }),
                    ],
                  }),
                ),
              }),
            )
          : null,
      ],
    });
  };

  /** 卡片标题统一复用共享组件，保持标题语义、问号和范围标记一致。 */
  const cardHead = (title: string, tip?: string, end = false, scope?: string): ReturnType<typeof h> =>
    h(SettingsCardHeader, { title, help: tip, end, scope });

  /** 一个字段：标签（+ 问号）在上、控件在下 */
  const field = (label: string, control: ReturnType<typeof h>, tip?: string, end = false): ReturnType<typeof h> =>
    h('div', {
      className: 'dsh-pet-cfg__field',
      children: [
        h('span', {
          key: 'l',
          className: 'dsh-pet-cfg__flabel',
          children: tip ? [label, q(tip, end)] : label,
        }),
        control,
      ],
    });

  /**
   * 开关的一格：勾选框 + 标题 + 问号。
   * label 为文案键：标题 = t(label)，说明 = t(label + 'Hint')（说明进问号，不再占一行小字）。
   * 说明挂在问号上而不是整格——点标题只切开关，看说明去点问号，两个动作不再抢同一次点击。
   */
  const toggleCell = (
    label: string,
    value: boolean,
    disabled: boolean,
    onToggle: (v: boolean) => void,
    end = false,
    hint?: string,
  ): ReturnType<typeof h> =>
    h('div', {
      className: 'dsh-pet-cfg__toggle',
      children: [
        h('label', {
          key: 'l',
          children: [
            h('input', {
              key: 'i',
              type: 'checkbox',
              checked: value,
              disabled,
              onChange: (e: ChangeEvent<HTMLInputElement>) => onToggle(e.target.checked),
            }),
            h('span', { key: 't', children: t(label) }),
          ],
        }),
        q(hint ?? t(label + 'Hint'), end),
      ],
    });

  return function PetConfigSection() {
    const initPets = petBridge.current.filter((p) => !p.extra);
    const standaloneAiUrl = (window as Window & { DSH_PET_AI_SETTINGS_URL?: string }).DSH_PET_AI_SETTINGS_URL ?? '/standalone-ai/';
    const initialTab = new URLSearchParams(window.location.search).get('tab') === 'system' ? 'system' : 'pets';
    const [activeTab, setActiveTab] = useState<'pets' | 'system'>(initialTab);
    const [visiblePetCount, setVisiblePetCount] = useState(5);
    const [draftPet, setDraftPet] = useState<Pet | null>(null);
    const [pendingCorruptPets, setPendingCorruptPets] = useState<Pet[] | null>(null);
    // 文件定义宠物数量（pet/ 目录，不在本编辑列表；仅展示提示）
    const extraCount = petBridge.current.filter((p) => p.extra).length;
    const [entryPrompt, setEntryPrompt] = useState('');
    const [pets, setPets] = useState<Pet[]>(initPets.map((p) => ({ ...p, position: { ...p.position } })));
    const [selId, setSelId] = useState<string>(initPets[0]?.id ?? '');
    const [saving, setBusy] = useState(false);
    const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
    const [loadAttempt, setLoadAttempt] = useState(0);
    const [standaloneWhisperState, setStandaloneWhisperState] = useState<'loading' | 'enabled' | 'disabled' | 'unavailable'>(
      'loading',
    );
    const busy = saving || loadState !== 'ready';
    const [msg, setMsg] = useState<{ kind: 'ok' | 'err' | ''; text: string }>({ kind: '', text: '' });
    // 确认/提示弹窗（仿官方弹窗：遮罩 + 居中卡片 + 按钮）：
    //   remove  —— 删除宠物（双按钮：取消 / 删除）
    //   lastOne —— 只剩一只、删不了：同样走弹窗（单按钮「知道了」）。
    //              以前这里是在按钮旁闪一行红字——位置在页面中段、颜色又淡，很容易被忽略，
    //              用户只看到「点了删除没反应」。
    //   sync    —— 同步（说明会用内置默认整份覆盖）
    //   corrupt —— 保存时发现用户配置**已损坏**（解析不了）：取消 = 不动文件，确认 = 强行白名单重建
    const [dialog, setDialog] = useState<
      null | { kind: 'remove'; petId: string } | { kind: 'lastOne' } | { kind: 'sync' } | { kind: 'corrupt'; path: string }
    >(null);

    useEffect(() => {
      let active = true;
      let token = '';
      try {
        const hash = new URL(standaloneAiUrl, window.location.href).hash;
        token = new URLSearchParams(hash.slice(1)).get('token') ?? '';
      } catch {
        token = '';
      }

      const refreshWhisperState = async (): Promise<void> => {
        if (!token) {
          if (active) setStandaloneWhisperState('unavailable');
          return;
        }
        try {
          const response = await fetch('/standalone-ai/settings', {
            credentials: 'omit',
            cache: 'no-store',
            headers: { 'X-DSH-Pet-Token': token },
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const settings = (await response.json()) as { automaticWhispers?: unknown };
          if (active) setStandaloneWhisperState(settings.automaticWhispers === true ? 'enabled' : 'disabled');
        } catch {
          if (active) setStandaloneWhisperState('unavailable');
        }
      };

      void refreshWhisperState();
      window.addEventListener('focus', refreshWhisperState);
      return () => {
        active = false;
        window.removeEventListener('focus', refreshWhisperState);
      };
    }, [standaloneAiUrl]);

    const whisperToggleHint =
      standaloneWhisperState === 'disabled'
        ? '独立 AI 设置页中的“开启自动碎碎念”未开启。当前单宠设置会保留，开启全局选项后才会参与定时碎碎念。'
        : standaloneWhisperState === 'loading'
          ? '正在读取独立 AI 设置中的定时碎碎念开关。'
          : standaloneWhisperState === 'unavailable'
            ? '无法读取独立 AI 设置。请重新打开设置页；读取成功后才能修改单宠碎碎念。'
            : undefined;
    // 配置文件地址与存储位置清单（「高级配置」「卸载与存储」区块；读取失败仅缺省不显示，不影响表单）
    const [paths, setPaths] = useState<null | {
      user: string;
      default: string;
      animations: string;
      /** 用户表情包目录（$DSH_HOME/dsh-pet/memes：加图不必改包） */
      memes?: string;
      /** 插件落盘的全部位置（路径 + 是否已存在），host 按平台推导 */
      storage?: Array<{ key: string; path: string; exists?: boolean }>;
    }>(null);
    useEffect(() => {
      fetch('/dsh-pet-7340/config/meta')
        .then((r) => (r.ok ? r.json() : null))
        .then((p) => setPaths(p))
        .catch(() => console.warn('[dsh-pet] 读取配置文件路径失败'));
    }, []);

    // 系统通知总开关（全局：写用户级配置 main-config.jsonc 的 notificationsEnabled）。
    // 与其余三个全局开关**完全同构**：切换只改本地 UI 状态，随「保存」一起整包写入。
    // 为什么不做即时写入：PUT /config 会触发宿主重启桌面 Helper（全部桌面宠物窗口重建——
    // 拖拽落点清空、宠物跳回配置角落），于是"改个通知开关，桌面被重置"，与其它开关行为不一致。
    // 通知配置由桌面宿主处理。
    const [notifyEnabled, setNotifyEnabled] = useState(true);
    // 表情包配图开关（全局：写用户级配置；与「保存」一起提交，不做即时写入）
    const [whisperImage, setWhisperImage] = useState(false);
    const [chatImage, setChatImage] = useState(false);
    // 抛掷锁定开关（全局：写用户级配置；与「保存」一起提交，不做即时写入）
    const [confineScreen, setConfineScreen] = useState(false);
    // 托盘开关属于应用级设置；与其它全局设置一同保存，桌面壳经本机 IPC 同步状态。
    const [trayEnabled, setTrayEnabled] = useState(true);
    const [displayPriority, setDisplayPriority] = useState<PetDisplayPriority>('always-on-top');
    const [uiTheme, setUiTheme] = useState<UiTheme>('system');
    // 物理参数（全局：拖拽抛掷手感，写用户级配置 main-config.jsonc 的 physics 段）。
    // 与四个开关同一套语义：只改本地状态，随「保存」整包写入（不做即时写入）。
    // 初值仅作占位；成品配置加载成功后才允许编辑和保存。
    const [physics, setPhysics] = useState<PhysicsParams>({ ...DEFAULT_PHYSICS });
    // 字体（全局默认：字体种类 / 字号 / 是否随宠物大小缩放，写用户级配置的 font 段）。
    // 与四个全局开关 / physics 同一套语义：只改本地状态，随「保存」整包写入（不做即时写入）。
    // 初值仅作占位；成品配置加载成功后才允许编辑和保存。
    const [font, setFont] = useState<FontConfig>({ ...DEFAULT_FONT });
    // 设置页字体单独追踪已应用值；编辑中的 font 只在保存成功后更新此值。
    const [appliedFontFamily, setAppliedFontFamily] = useState(fontStackOf(DEFAULT_FONT.family));
    // 权限申请按钮的反馈（就地显示在按钮旁，与全局保存反馈分离）
    const [permMsg, setPermMsg] = useState<{ kind: 'ok' | 'err' | ''; text: string }>({ kind: '', text: '' });

    // 首次读取与恢复默认必须更新同一组控件，避免下一次保存回写过期值。
    const applyConfig = useCallback((merged: Record<string, Record<string, unknown>>) => {
      const m = merged.main;
      if (!m || !Array.isArray(m.pets)) throw new Error('Invalid config response');
      setEntryPrompt(typeof m.whisperPrompt === 'string' ? m.whisperPrompt : '');
      const loadedPets = m.pets as Pet[];
      setPets(loadedPets.map((p) => ({ ...p, position: { ...p.position } })));
      setSelId((id) => (loadedPets.some((p) => p.id === id) ? id : (loadedPets[0]?.id ?? '')));
      setDraftPet(null);
      if (m.uiTheme === 'system' || m.uiTheme === 'light' || m.uiTheme === 'dark') {
        setUiTheme(m.uiTheme);
        applySettingsTheme(m.uiTheme);
      }
      if (typeof m.notificationsEnabled === 'boolean') setNotifyEnabled(m.notificationsEnabled);
      if (typeof m.whisperImageEnabled === 'boolean') setWhisperImage(m.whisperImageEnabled);
      if (typeof m.chatImageEnabled === 'boolean') setChatImage(m.chatImageEnabled);
      if (typeof m.confineToScreen === 'boolean') setConfineScreen(m.confineToScreen);
      if (typeof m.trayEnabled === 'boolean') setTrayEnabled(m.trayEnabled);
      if (
        m.petDisplayPriority === 'always-on-top' ||
        m.petDisplayPriority === 'hide-on-fullscreen' ||
        m.petDisplayPriority === 'hide-on-fullscreen-or-maximized' ||
        m.petDisplayPriority === 'normal'
      ) {
        setDisplayPriority(m.petDisplayPriority);
      }
      // physics 段：成品已按「内置默认 ← 用户层」整段填满，直接取用（缺子键再用默认兜底一次）
      if (m.physics && typeof m.physics === 'object') {
        setPhysics({ ...DEFAULT_PHYSICS, ...(m.physics as PhysicsParams) });
      }
      // 字体段：同 physics——成品已填满，缺子键再用默认兜底一次
      if (m.font && typeof m.font === 'object') {
        const loadedFont = { ...DEFAULT_FONT, ...(m.font as FontConfig) };
        setFont(loadedFont);
        setAppliedFontFamily(fontStackOf(loadedFont.family));
      }
    }, []);

    useEffect(() => {
      let alive = true;
      const controller = new AbortController();
      fetch('/dsh-pet-7340/config', { signal: controller.signal })
        .then((r) => {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        })
        .then((merged) => {
          if (!alive) return;
          const flat = flattenConfigPets(merged);
          petBridge.current = flat;
          petBridge.template = flat.find((p) => !p.extra);
          applyConfig(merged);
          setLoadState('ready');
        })
        .catch(() => {
          if (alive) setLoadState('error');
        });
      return () => {
        alive = false;
        controller.abort();
      };
    }, [applyConfig, loadAttempt]);


    // 切换系统通知：与配图/抛掷锁定开关同构——只改本地状态（开启时顺带借这次用户手势申请权限），
    // 配置在点「保存」时整包写入；通知配置由桌面宿主处理。
    const toggleNotify = async (v: boolean) => {
      setNotifyEnabled(v);
      // 开启时借用户手势申请系统通知权限（无手势的自动申请可能被系统静默压制）
      if (v) await requestNotificationPermission();
    };

    /**
     * 「测试弹窗」按钮：发一条测试系统通知，验证整条链路通不通。
     *
     * 顺带承担申请权限的职责——没授权时先申请（借这次用户手势，无手势的自动申请可能被系统
     * 静默压制），授权成功再发测试通知。所以这一个按钮同时是「拿权限」和「验链路」的入口，
     * 不需要再单独摆一个「获取权限」按钮。
     */
    const testNotification = async () => {
      setPermMsg({ kind: '', text: '' });
      const r = await requestNotificationPermission();
      if (!r.ok) {
        // 红字：失败理由 + 引导（unsupported 无引导，改环境才有意义）
        const reason =
          r.reason === 'unsupported'
            ? t('notifyDenyUnsupported')
            : r.reason === 'denied'
              ? t('notifyDenyBlocked')
              : r.reason === 'rejected'
                ? t('notifyDenyRejected')
                : t('notifyDenyError') + (r.message ? '：' + r.message : '');
        setPermMsg({ kind: 'err', text: reason + (r.reason === 'unsupported' ? '' : ' ' + t('notifyGuide')) });
        return;
      }
      try {
        // 成功即发一条测试通知验证链路（绕过聚焦门，直接确认）
        new Notification('测试通知', { body: `【${notificationAppName}】系统通知已就绪。`, icon: notificationIcon });
      } catch {
        /* 个别环境构造失败：仍按已授权提示 */
      }
      setPermMsg({ kind: 'ok', text: t('notifyTestOk') });
    };

    // position 子字段整体替换；新宠物草稿保存在列表之外，直到单独保存成功。
    const updatePet = (petId: string, patch: Partial<Omit<Pet, 'position'>> & { position?: Partial<Pet['position']> }) => {
      const update = (p: Pet): Pet => {
        const { position: posPatch, ...rest } = patch;
        return { ...p, ...rest, position: posPatch ? { ...p.position, ...posPatch } : p.position };
      };
      if (draftPet?.id === petId) setDraftPet(update(draftPet));
      else setPets((list) => list.map((p) => (p.id === petId ? update(p) : p)));
    };

    const validated = (petsToValidate: Pet[] = pets): boolean => {
      for (const p of petsToValidate) {
        if (
          !Number.isFinite(p.size) ||
          p.size <= 0 ||
          !Number.isFinite(p.position.marginX) ||
          !Number.isFinite(p.position.marginY)
        ) {
          setMsg({ kind: 'err', text: t('invalid') });
          return false;
        }
      }
      // 物理参数：与宿主 physicsValid 同一套规则（非法宿主会回 400，这里先就地给红字提示）
      if (
        !Number.isFinite(physics.gravity) ||
        physics.gravity < 0 ||
        !Number.isFinite(physics.restitution) ||
        physics.restitution < 0 ||
        physics.restitution > 1 ||
        !Number.isFinite(physics.groundFriction) ||
        physics.groundFriction < 0 ||
        !Number.isFinite(physics.throwPower) ||
        physics.throwPower <= 0
      ) {
        setMsg({ kind: 'err', text: t('invalidPhysics') });
        return false;
      }
      // 字体：与宿主 fontValid 同一套规则（family 必须在预设白名单内、size 4~200、followPet 为布尔）
      if (
        !FONT_PRESETS.some((p) => p.id === font.family) ||
        !Number.isFinite(font.size) ||
        font.size < FONT_SIZE_MIN ||
        font.size > FONT_SIZE_MAX
      ) {
        setMsg({ kind: 'err', text: t('invalidFont') });
        return false;
      }
      return true;
    };

    // force 只认严格 true：**绝不能**写成 `force ? ...`——保存按钮现在是包一层再调 save，
    // 但历史上是把这个 handler 直接交给 React 的 onClick，于是 React 把 MouseEvent 当第一个
    // 实参传进来 → 真值 → 每次都拼上 ?force=1 → 宿主的损坏预检被绕过 →
    // 静默白名单重建、字段全丢、永不弹窗（真实事故，已由源码守卫钉住）。
    const save = async (force = false, petsToSave: Pet[] = pets): Promise<boolean> => {
      if (busy) return false;
      const isOk = validated(petsToSave);
      if (!isOk) return false;
      setBusy(true);
      setMsg({ kind: '', text: '' });
      try {
        // 通知总开关随保存一起写：UI 状态初始来自成品 main 条目（即保留用户手写值，不会静默覆盖）
        const body: Record<string, unknown> = {
          pets: petsToSave,
          notificationsEnabled: notifyEnabled,
          whisperImageEnabled: whisperImage,
          chatImageEnabled: chatImage,
          confineToScreen: confineScreen,
          trayEnabled,
          petDisplayPriority: displayPriority,
          // 物理参数整段提交（白名单字段，未传即走宿主透传保留）：宿主用 physicsValid 整段校验
          physics: physics,
          // 字体（全局默认白名单字段）：宿主用 fontValid 整段校验（family 白名单 / size 4~200 /
          // followPet 布尔）；传了就整段写进用户层，没传则透传保留磁盘旧值
          font: font,
          uiTheme,
        };
        // force === true（用户在损坏弹窗里点了确认）：带 ?force=1 才允许按白名单重建损坏文件
        const res = await fetch('/dsh-pet-7340/config' + (force === true ? '?force=1' : ''), {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        // 409 = 宿主损坏预检拦下（用户配置解析不了，白名单重建会把文件里剩下的内容整份丢掉）：
        // 这里**不写盘**，弹窗让用户决定（取消 = 不动文件 / 确认 = 强行重建）
        if (res.status === 409) {
          // 路径取宿主回的真实写入路径（meta 拉取失败时也不至于空着）
          const info = (await res.json().catch(() => null)) as { userFile?: unknown } | null;
          setDialog({
            kind: 'corrupt',
            path: typeof info?.userFile === 'string' ? info.userFile : (paths?.user ?? ''),
          });
          setPendingCorruptPets(petsToSave);
          return false;
        }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        // 同上：PUT 响应即成品聚合，容器据此重新拍平（新增/删除宠物、改大小位置都走这条路）。
        // 设置页字体也只在保存成功后应用，编辑中的选择不会提前改变界面。
        const merged = (await res.json()) as Record<string, Record<string, unknown>>;
        setPets(petsToSave);
        setSelId((id) => (petsToSave.some((pet) => pet.id === id) ? id : (petsToSave[0]?.id ?? '')));
        petBridge.reload(merged);
        setAppliedFontFamily(fontStackOf(font.family));
        setMsg({ kind: 'ok', text: t('saved') });
        setPendingCorruptPets(null);
        return true;
      } catch {
        setMsg({ kind: 'err', text: t('loadError') });
        return false;
      } finally {
        setBusy(false);
      }
    };

    const sync = () => setDialog({ kind: 'sync' });

    const doSync = async () => {
      setBusy(true);
      setMsg({ kind: '', text: '' });
      try {
        // 同步用户层：POST 把内置默认配置（原文，含注释）整份写入用户配置，响应体同样是成品聚合
        // （此时 main 条目 = 内置默认宠物列表），与保存走同一条路——不再"改完再拉一次"，
        // 也就没有中间失败态
        const res = await fetch('/dsh-pet-7340/config', { method: 'POST' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const merged = (await res.json()) as Record<string, Record<string, unknown>>;
        applyConfig(merged);
        // 同一份成品交给容器拍平：编辑列表（裸实例）与渲染列表（含条目级字段）都由成品派生
        petBridge.reload(merged);
        setMsg({ kind: 'ok', text: t('saved') });
      } catch {
        setMsg({ kind: 'err', text: t('loadError') });
      } finally {
        setBusy(false);
      }
    };

    const addPet = () => {
      const tpl = petBridge.template;
      if (!tpl) return;
      const id = nextId(pets);
      setDraftPet({
        id,
        // 新宠物默认名字 = 自己的新 id，避免继承模板名字造成同名。
        name: id,
        size: tpl.size,
        balanceEnabled: tpl.balanceEnabled,
        whisperEnabled: tpl.whisperEnabled,
        workStatusEnabled: tpl.workStatusEnabled,
        fixedEnabled: tpl.fixedEnabled,
        horizontalOnly: tpl.horizontalOnly,
        display: tpl.display,
        position: { ...tpl.position },
      });
      setSelId(id);
    };

    const saveNewPet = async (): Promise<void> => {
      if (!draftPet) return;
      if (await save(false, [...pets, draftPet])) {
        setSelId(pets[0]?.id ?? draftPet.id);
        setDraftPet(null);
        setVisiblePetCount(5);
      }
    };

    const removeSel = (petId = selId) => {
      // 两种情形都走弹窗：能删 → 确认删除；只剩一只 → 说明删不了。
      // 不再把「至少保留一个宠物」塞进按钮旁的消息行（那里离删除按钮很远，等于没提示）。
      setDialog(pets.length <= 1 ? { kind: 'lastOne' } : { kind: 'remove', petId });
    };

    const doRemove = async (petId: string): Promise<void> => {
      const list = pets.filter((p) => p.id !== petId);
      if (list.length === 0 || list.length === pets.length) return;
      // 删除确认后立即走现有保存路径：配置只写一次，宿主也只重载一次桌宠 Helper。
      // save() 失败时保留原列表，并继续显示对应错误/损坏配置确认。
      await save(false, list);
    };

    /** 宠物数值输入（大小 / 水平偏移 / 垂直偏移）——宽度交给栅格，不再各自写死 */
    const numInput = (
      key: 'size' | 'marginX' | 'marginY',
      value: number,
      setter: (v: number) => void,
    ): ReturnType<typeof h> =>
      h('input', {
        type: 'number',
        className: inputClass,
        step: key === 'size' ? '10' : '1',
        min: key === 'size' ? '120' : '',
        value: String(value),
        disabled: busy,
        onChange: (e: ChangeEvent<HTMLInputElement>) => setter(Number(e.target.value)),
      });

    /** 物理参数的一格：标签 + 问号在上、数字输入在下（说明进问号） */
    const physField = (
      key: 'gravity' | 'restitution' | 'groundFriction' | 'throwPower',
      step: string,
      min: string,
      end = false,
    ): ReturnType<typeof h> =>
      field(
        t('physics.' + key),
        h('input', {
          type: 'number',
          className: inputClass,
          step,
          min,
          value: String(physics[key]),
          disabled: busy,
          onChange: (e: ChangeEvent<HTMLInputElement>) =>
            setPhysics((p) => ({ ...p, [key]: Number(e.target.value) }) as PhysicsParams),
        }),
        t('physics.' + key + 'Hint'),
        end,
      );

    const renderPetCard = (pet: Pet, isDraft = false): ReturnType<typeof h> => {
      const update = (patch: Partial<Omit<Pet, 'position'>> & { position?: Partial<Pet['position']> }) =>
        updatePet(pet.id, patch);
      return h('article', {
        key: pet.id,
        className: 'dsh-pet-cfg__card dsh-pet-cfg__petDetailCard',
        children: [
          h(SettingsCardHeader, {
            title: isDraft ? t('newPetTitle') + '：' + (pet.name || pet.id) : pet.name || pet.id,
            help: t('petCardHint'),
            actions: isDraft
              ? [
                  h('button', {
                    key: 'cancel', type: 'button', disabled: busy,
                    onClick: () => { setDraftPet(null); setSelId(pets[0]?.id ?? ''); },
                    className: 'dsh-pet-cfg__btn is-sm',
                    children: t('cancelAddPet'),
                  }),
                  h('button', {
                    key: 'save', type: 'button', disabled: busy,
                    onClick: () => void saveNewPet(),
                    className: 'dsh-pet-cfg__btn is-primary is-sm',
                    children: busy ? t('busy') : t('savePet'),
                  }),
                ]
              : h('button', {
                  type: 'button', disabled: busy,
                  onClick: () => removeSel(pet.id),
                  className: 'dsh-pet-cfg__btn is-danger is-sm',
                  children: t('remove'),
                }),
          }),
          h('div', {
            className: 'dsh-pet-cfg__grid3',
            children: [
              field(t('nameLabel'), h('input', {
                type: 'text', className: inputClass, value: String(pet.name ?? ''), disabled: busy,
                maxLength: 50, onChange: (e: ChangeEvent<HTMLInputElement>) => update({ name: e.target.value }),
              }), t('nameHint')),
              field(t('sizeLabel'), numInput('size', pet.size, (v) => update({ size: v })), t('sizeHint')),
              field(t('displayLabel'), h(ConfigSelect, {
                label: t('displayLabel'), value: pet.display, fontFamily: appliedFontFamily, disabled: busy,
                options: displayOptions.map((d) => ({ value: d, label: t('display.' + d) })),
                onChange: (value: string) => update({ display: value as PetDisplay }),
              }), t('displayHint'), true),
            ],
          }),
          h('div', {
            className: 'dsh-pet-cfg__grid3',
            children: [
              field(t('cornerLabel'), h(ConfigSelect, {
                label: t('cornerLabel'), value: pet.position.corner, fontFamily: appliedFontFamily, disabled: busy,
                options: CORNERS.map((c) => ({ value: c, label: cornerLabel(c) })),
                onChange: (value: string) => update({ position: { corner: value as Corner } }),
              }), t('cornerHint')),
              field(t('marginX'), numInput('marginX', pet.position.marginX, (v) => update({ position: { marginX: v } })), t('marginXHint')),
              field(t('marginY'), numInput('marginY', pet.position.marginY, (v) => update({ position: { marginY: v } })), t('marginYHint'), true),
            ],
          }),
          h('div', {
            className: 'dsh-pet-cfg__grid5',
            children: [
              toggleCell('balanceEnabled', !!pet.balanceEnabled, busy, (v) => update({ balanceEnabled: v })),
              toggleCell('whisperEnabled', !!pet.whisperEnabled, busy || standaloneWhisperState !== 'enabled',
                (v) => update({ whisperEnabled: v }), false, whisperToggleHint),
              toggleCell('workStatusEnabled', !!pet.workStatusEnabled, busy, (v) => update({ workStatusEnabled: v })),
              toggleCell('fixedEnabled', !!pet.fixedEnabled, busy, (v) => update({ fixedEnabled: v }), true),
              toggleCell('horizontalOnly', !!pet.horizontalOnly, busy, (v) => update({ horizontalOnly: v }), true),
            ],
          }),
          field(t('personaLabel'), h('textarea', {
            className: inputClass, rows: 3, value: pet.whisperPrompt ?? '',
            placeholder: entryPrompt, disabled: busy, style: { resize: 'vertical', minHeight: '88px' },
            onChange: (e: ChangeEvent<HTMLTextAreaElement>) => update({ whisperPrompt: e.target.value }),
          }), t('personaHint')),
          standaloneWhisperState !== 'enabled'
            ? h('p', { className: 'dsh-pet-cfg__note', children: whisperToggleHint })
            : null,
        ],
      });
    };

    return h('section', {
      className: 'dsh-pet-cfg',
      style: { maxWidth: '720px', fontFamily: appliedFontFamily },
      children: [
        h(SettingsPageHeader, {
          title: t('nav'),
          help: extraCount > 0
            ? t('intro') + '\n' + t('extraPetsHint').replace('{n}', String(extraCount))
            : t('intro'),
          actions: [
            h('button', {
              key: 'sync', type: 'button', disabled: busy,
              style: { display: activeTab === 'system' ? undefined : 'none' },
              onClick: sync, className: 'dsh-pet-cfg__btn is-danger', children: t('sync'),
            }),
            activeTab === 'system' ? q(t('syncHint'), false, 'sync-help') : null,
            h('button', {
              key: 'test-notification', type: 'button',
              style: { display: activeTab === 'system' ? undefined : 'none' },
              onClick: () => void testNotification(), className: 'dsh-pet-cfg__btn', children: t('notifyTest'),
            }),
            permMsg.text
              ? h('span', {
                  key: 'permission-message',
                  className: 'dsh-pet-cfg__msg' + (permMsg.kind === 'err' ? '' : ' is-err'),
                  children: permMsg.text,
                })
              : null,
            msg.text
              ? h('span', {
                  key: 'save-message',
                  className: 'dsh-pet-cfg__msg' + (msg.kind === 'err' ? '' : ' is-err'),
                  children: msg.text,
                })
              : null,
            h('button', {
              key: 'save', type: 'button', disabled: busy,
              onClick: () => void save(), className: 'dsh-pet-cfg__btn is-primary',
              children: busy ? t('busy') : t('save'),
            }),
            q(t(activeTab === 'system' ? 'saveHintGlobal' : 'saveHintPets'), true, 'save-help'),
          ],
        }),

        h(SettingsPageTabs, {
          children: [
            h(SettingsPageTab, {
              key: 'pets', label: t('petSettingsList'), active: activeTab === 'pets',
              onClick: () => setActiveTab('pets'),
            }),
            h(SettingsPageTab, {
              key: 'system', label: t('globalSettingsList'), active: activeTab === 'system',
              onClick: () => setActiveTab('system'),
            }),
            h(SettingsPageTab, { key: 'ai', label: '独立 AI 设置', href: standaloneAiUrl }),
          ],
        }),

        loadState !== 'ready'
          ? h('div', {
              role: loadState === 'error' ? 'alert' : 'status',
              className: 'dsh-pet-cfg__actions',
              children: [
                h('span', { children: t(loadState === 'error' ? 'loadError' : 'loading') }),
                loadState === 'error'
                  ? h('button', {
                      type: 'button',
                      className: 'dsh-pet-cfg__btn',
                      onClick: () => {
                        setLoadState('loading');
                        setLoadAttempt((attempt) => attempt + 1);
                      },
                      children: t('retry'),
                    })
                  : null,
              ],
            })
          : null,

        h('div', {
          className: 'dsh-pet-cfg__settingsSection',
          style: { display: activeTab === 'pets' ? 'flex' : 'none' },
          children: [
        h('div', {
          className: 'dsh-pet-cfg__petList',
          children: [
            ...pets.slice(0, visiblePetCount).map((p) => renderPetCard(p)),
            pets.length > visiblePetCount
              ? h('button', {
                  key: 'more', type: 'button', disabled: busy,
                  className: 'dsh-pet-cfg__morePets',
                  onClick: () => setVisiblePetCount((count) => count + 5),
                  children: t('showMorePets').replace('{n}', String(pets.length - visiblePetCount)),
                })
              : visiblePetCount > 5
                ? h('button', {
                    key: 'collapse', type: 'button', disabled: busy,
                    className: 'dsh-pet-cfg__morePets',
                    onClick: () => setVisiblePetCount(5),
                    children: t('collapsePets'),
                  })
                : null,
            h('button', {
              key: 'add-card', type: 'button', disabled: busy || draftPet !== null,
              className: 'dsh-pet-cfg__addPetCard', onClick: addPet,
              children: t('addPetCard'),
            }),
          ],
        }),

        draftPet ? renderPetCard(draftPet, true) : null,
          ],
        }),

        h('div', {
          className: 'dsh-pet-cfg__settingsSection',
          style: { display: activeTab === 'system' ? 'flex' : 'none' },
          children: [
        // 全局开关分三列：通知与配图占首行，桌面/应用行为设置排在次行，避免托盘开关单独落行。
        // 四个开关行为**一致**：切换只改本地状态，随「保存」整包写入用户级配置——不做即时写入
        // （即时写盘会触发宿主重启桌面 Helper，把全部桌面宠物窗口重建一遍）。系统通知额外在保存后
        // 系统通知由桌面宿主处理。
        // 「测试弹窗」按钮不在这里——它是个动作，跟「保存 / 同步」同一行（见下面的操作区）。
        h('div', {
          className: 'dsh-pet-cfg__card',
          children: [
            cardHead(t('globalControlsTitle'), t('globalHint'), false, t('allPetsScope')),
            h('div', {
              className: 'dsh-pet-cfg__globalToggles',
              children: [
                toggleCell('notifyToggle', notifyEnabled, busy, (v) => void toggleNotify(v)),
                toggleCell('whisperImageToggle', whisperImage, busy, setWhisperImage),
                toggleCell('chatImageToggle', chatImage, busy, setChatImage),
                toggleCell('confineToggle', confineScreen, busy, setConfineScreen, true),
                toggleCell('trayToggle', trayEnabled, busy, setTrayEnabled),
              ],
            }),
            h('div', {
              className: 'dsh-pet-cfg__grid2',
              children: [
                field(
                  t('displayPriorityLabel'),
                  h(ConfigSelect, {
                    label: t('displayPriorityLabel'),
                    value: displayPriority,
                    fontFamily: appliedFontFamily,
                    disabled: busy,
                    options: (
                      [
                        'always-on-top',
                        'hide-on-fullscreen',
                        'hide-on-fullscreen-or-maximized',
                        'normal',
                      ] as PetDisplayPriority[]
                    ).map(
                      (value) => ({
                        value,
                        label: t('displayPriority.' + value),
                      }),
                    ),
                    onChange: (value: string) => setDisplayPriority(value as PetDisplayPriority),
                  }),
                  t('displayPriorityHint'),
                ),
              ],
            }),
            rt.standaloneAddon
              ? h('div', {
                  className: 'dsh-pet-cfg__subsection',
                  children: [
                    cardHead(t('applicationTitle'), undefined, false, t('appWideScope')),
                    rt.standaloneAddon,
                  ],
                })
              : null,
          ],
        }),

        // 外观与字体卡：字体种类 + 字号 + 是否随宠物缩放（全局默认，与全局开关 / physics 同语义——
        // 只改本地状态，随「保存」整包写入用户配置；不做即时写入）。
        // 字体种类的作用范围 = 现在用软糖体的全部地方（气泡 / 悬浮提示 / 对话窗 / 得分弹窗）；
        // 字号**只**作用于气泡与悬浮提示（对话窗与得分弹窗的字号不随本项变，故不在此列）。
        h('div', {
          className: 'dsh-pet-cfg__card',
          children: [
            cardHead(t('fontTitle'), t('fontHint'), false, t('globalDefaultScope')),
            h('div', {
              className: 'dsh-pet-cfg__grid2',
              children: [
                field(
                  t('uiThemeLabel'),
                  h(ConfigSelect, {
                    label: t('uiThemeLabel'),
                    value: uiTheme,
                    fontFamily: appliedFontFamily,
                    options: (['system', 'light', 'dark'] as UiTheme[]).map((value) => ({
                      value,
                      label: t('uiTheme.' + value),
                    })),
                    disabled: busy,
                    onChange: (value: string) => {
                      const next = value as UiTheme;
                      setUiTheme(next);
                      applySettingsTheme(next);
                    },
                  }),
                  t('uiThemeHint'),
                ),
                field(
                  t('fontFamilyLabel'),
                  h(ConfigSelect, {
                    label: t('fontFamilyLabel'),
                    value: font.family,
                    fontFamily: appliedFontFamily,
                    options: FONT_PRESETS.map((p) => ({ value: p.id, label: t('font.' + p.id) })),
                    disabled: busy,
                    onChange: (value: string) => setFont((f) => ({ ...f, family: value as FontFamilyId })),
                  }),
                  t('fontFamilyHint'),
                ),
                field(
                  t('fontSizeLabel'),
                  h('input', {
                    type: 'number',
                    className: inputClass,
                    step: '1',
                    min: String(FONT_SIZE_MIN),
                    max: String(FONT_SIZE_MAX),
                    value: String(font.size),
                    disabled: busy,
                    onChange: (e: ChangeEvent<HTMLInputElement>) =>
                      setFont((f) => ({ ...f, size: Number(e.target.value) })),
                  }),
                  t('fontSizeHint'),
                  true,
                ),
              ],
            }),
            h('div', {
              className: 'dsh-pet-cfg__grid2',
              children: [
                toggleCell('fontFollowToggle', font.followPet, busy, (v) => setFont((f) => ({ ...f, followPet: v }))),
              ],
            }),
          ],
        }),

        // 物理卡（需求 6）：四个数字输入一行 + 两个开关一行。
        // 与上面四个开关同一套语义（只改本地状态，随「保存」整包写入；不做即时写入）。
        // 保存触发的 Helper 重启后重新读取——physics 在 sprite 构造时只读一次。
        h('div', {
          className: 'dsh-pet-cfg__card',
          children: [
            cardHead(t('physicsTitle'), t('physicsHint'), false, t('globalDefaultScope')),
            h('div', {
              className: 'dsh-pet-cfg__grid4',
              children: [
                physField('gravity', '50', '0'),
                physField('restitution', '0.01', '0'),
                physField('groundFriction', '0.1', '0'),
                physField('throwPower', '0.05', '0.05', true),
              ],
            }),
            h('div', {
              className: 'dsh-pet-cfg__grid2',
              children: [
                toggleCell('physicsCeilingBounce', physics.ceilingBounce, busy, (v) =>
                  setPhysics((p) => ({ ...p, ceilingBounce: v })),
                ),
                toggleCell(
                  'physicsPetCollision',
                  physics.petCollision,
                  busy,
                  (v) => setPhysics((p) => ({ ...p, petCollision: v })),
                  true,
                ),
              ],
            }),
          ],
        }),

        // 高级配置（文件地址）：供高级用户直接编辑配置文件自定义；说明收进问号
        paths
          ? h('div', {
              className: 'dsh-pet-cfg__card',
              children: [
                cardHead(t('configMeta'), t('configMetaHint')),
                h('div', { className: 'dsh-pet-cfg__path', children: t('defaultConfig') + '：' + paths.default }),
                h('div', { className: 'dsh-pet-cfg__path', children: t('userConfig') + '：' + paths.user }),
                h('div', { className: 'dsh-pet-cfg__path', children: t('animationDir') + '：' + paths.animations }),
                paths.memes
                  ? h('div', { className: 'dsh-pet-cfg__path', children: t('memesDir') + '：' + paths.memes })
                  : null,
              ],
            })
          : null,

        // 卸载与存储：先列出插件落盘的全部位置（路径在前、作用在后），再给出卸载方法；说明收进问号
        paths && paths.storage && paths.storage.length > 0
          ? h('div', {
              className: 'dsh-pet-cfg__card',
              children: [
                cardHead(t('standaloneStorageTitle'), t('standaloneStorageHint')),
                // 存储位置清单：每条都是「路径（可选中复制）→ 作用」；路径也沿用应用字体
                ...paths.storage
                  .filter((s) => s.key === 'userData' || s.key === 'desktopCache')
                  .map((s) =>
                    h('div', {
                      key: s.key,
                      className: 'dsh-pet-cfg__path',
                      children: [
                        h('b', { key: 'p', children: s.path }),
                        // 尚未产生的目录（如从未启用桌面模式的 Electron）标一下，避免用户去找不存在的文件夹
                        h('span', {
                          key: 'd',
                          children: ' — ' + t('storage.' + s.key) + (s.exists === false ? t('storageMissing') : ''),
                        }),
                      ],
                    }),
                  ),
                h('div', {
                      key: 'standalone-note',
                      className: 'dsh-pet-cfg__note',
                      children: t('standaloneStorageNote'),
                    }),
              ],
            })
          : null,
                ] }),

        // 确认/提示弹窗（仿官方弹窗视觉：遮罩 + 居中卡片 + 按钮）
        dialog
          ? h('div', {
              style: {
                position: 'fixed',
                inset: 0,
                zIndex: 2147483647,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'rgba(0, 0, 0, 0.45)',
              },
              onClick: () => setDialog(null),
              children: h('div', {
                style: {
                  width: '340px',
                  maxWidth: 'calc(100vw - 40px)',
                  background: 'var(--dsw-alias-bg-layer-1)',
                  border: '1px solid var(--dsw-alias-border-l2)',
                  borderRadius: '12px',
                  padding: '16px 18px',
                  boxShadow: '0 8px 30px rgba(0, 0, 0, 0.35)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '12px',
                },
                onClick: (e: ReactNS.MouseEvent<HTMLDivElement>) => e.stopPropagation(),
                children: [
                  h('div', {
                    style: { fontSize: '14px', fontWeight: 500, color: 'var(--dsw-alias-label-primary)' },
                    children: dialog.kind === 'corrupt' ? t('corruptTitle') : t('confirmTitle'),
                  }),
                  h('div', {
                    style: { fontSize: '13px', lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' },
                    children:
                      dialog.kind === 'remove'
                        ? t('confirmRemove').replace('{id}', dialog.petId)
                        : dialog.kind === 'lastOne'
                          ? t('atLeastOne')
                          : dialog.kind === 'corrupt'
                            ? t('corruptBody').replace('{path}', dialog.path)
                            : t('confirmSync'),
                  }),
                  h('div', {
                    style: { display: 'flex', gap: '8px', justifyContent: 'flex-end' },
                    // 只剩一只 = 没有可确认的动作，只给一个「知道了」；其余都是 取消 + 确认 双按钮
                    children:
                      dialog.kind === 'lastOne'
                        ? [
                            h('button', {
                              key: 'ok',
                              type: 'button',
                              onClick: () => setDialog(null),
                              className: 'dsh-pet-cfg__btn is-primary',
                              children: t('ok'),
                            }),
                          ]
                        : [
                            h('button', {
                              key: 'cancel',
                              type: 'button',
                              onClick: () => setDialog(null),
                              className: 'dsh-pet-cfg__btn',
                              children: t('cancel'),
                            }),
                            h('button', {
                              key: 'confirm',
                              type: 'button',
                              onClick: () => {
                                const d = dialog;
                                setDialog(null);
                                if (d.kind === 'remove') void doRemove(d.petId);
                                else if (d.kind === 'corrupt')
                                  void save(true, pendingCorruptPets ?? pets).then((ok) => {
                                    if (ok && draftPet) setDraftPet(null);
                                  }); // 确认：带 ?force=1 强行重建
                                else void doSync();
                              },
                              className: 'dsh-pet-cfg__btn ' + (dialog.kind === 'sync' ? 'is-primary' : 'is-danger'),
                              children:
                                dialog.kind === 'remove'
                                  ? t('remove')
                                  : dialog.kind === 'corrupt'
                                    ? t('corruptConfirm')
                                    : t('sync'),
                            }),
                          ],
                  }),
                ],
              }),
            })
          : null,
      ],
    });
  };
}
