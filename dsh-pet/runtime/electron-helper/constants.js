/**
 * dsh-pet desktop helper —— 基础设施（常量 + 全局状态 + 调试钩子）。
 *
 * 经典 script 全局共享（经 index.html 顺序加载，先于 sprite.js / events.js / renderer.js）；
 * 顶层 const/let/function 都进全局词法环境，后续文件可直接引用。
 */
'use strict';

const S = window.PetShared;

const params = new URLSearchParams(location.search);
const CONFIG = {
  configUrl: params.get('configUrl') || 'http://127.0.0.1:6952/dsh-pet-7340/config',
  notificationIcon: params.get('notificationIcon') || '',
  notificationIcons: (() => {
    try {
      const icons = JSON.parse(params.get('notificationIcons') || '{}');
      return icons && typeof icons === 'object' ? icons : {};
    } catch {
      return {};
    }
  })(),
  scale: Number(params.get('scale') || '1'),
  overlay: params.get('overlay') === '1',
  petIndex: Number(params.get('petIndex') || '0'),
  petLayouts: (() => {
    try {
      const pets = JSON.parse(params.get('petLayouts') || '[]');
      return Array.isArray(pets) ? pets : [];
    } catch {
      return [];
    }
  })(),
  topInsetRatio: Number(params.get('topInsetRatio') || '0'),
  frameDiagnostics: params.get('frameDiagnostics') === '1',
};

// ---------- 渲染端坐标系统一约定（DESIGN.md §3.5） ----------
// main 进程对窗口做页面级缩放 setZoomFactor(CONFIG.scale) 后，本窗口的 DOM 度量、事件坐标、
// 桌面几何（VIEW/AREAS/PRIMARY_AREA）与全部 shared 组件（右键菜单/积分弹窗/聊天框）都在
// **同一套 CSS 像素**里——固定 px UI 随缩放自动恢复 DIP 观感，组件代码零换算。
// 主进程侧（窗口 bounds、逐屏几何、碰撞 broker）仍是物理像素：与它交换的值只允许在下面两个
// 收口换算（×scale 发出去 / ÷scale 收进来），任何组件代码不得再乘除（防散修回归）。
function toScreen(v) {
  return v * CONFIG.scale;
}
function toLocal(v) {
  return v / CONFIG.scale;
}
// bridge 模式（DSH_PET_BRIDGE=1）：请求走自定义 scheme，经 Electron 主进程转宿主管道——
// 绕开 DSH Desktop 2.0.3+ 的浏览器访问闸门（只放行带令牌的请求，插件自拉进程的裸 HTTP 全 403）
const BRIDGE = params.get('bridge') === '1';
// Renderer runs with nodeIntegration disabled; main.js forwards standalone mode through the URL.
const STANDALONE = params.get('standalone') === '1';
// 工具项「打开网站」的去向（主进程按宿主形态经 query 注入，见 main.js 的 OPEN_TARGET）：
// desktop = 宿主是 DSH 桌面应用，菜单项改叫「打开 DeepSeek Harness」并唤起桌面应用主窗口；site = 打开站点。
const OPEN_TARGET = params.get('openTarget') === 'desktop' ? 'desktop' : 'site';
// 视口 = 覆盖窗口外接矩形（Windows 使用完整面板，确保透明窗口覆盖任务栏区域）。
// 它只是**坐标系原点与比例换算基准**：位置比例（customPos）、漫游 ratio 都按它算。
// x/y = 外接矩形左上角（多显示器时原点非 0）——visibleClampRect 计算「窗口 ∩ 工作区」需要它。
//
// **宠物边界判定不用它**，改用下面 AREAS 的并集：显示器摆放不规则时外接矩形里有大片空洞
// （实测右倒 T 型双屏 23.7% 的面积不属于任何屏），拿它当边界会让宠物走进/飞进不可见区域。
// 字段可变：显示器分辨率/缩放变化、插拔屏、旋转时由 applyDeskGeometry 就地重挂（#P4）。
// 主进程下发的视口（**物理像素**，原样保留给首帧 applyDeskGeometry）；VIEW 才是 ÷scale 后的 CSS 系
function requiredNumberParam(name) {
  const raw = params.get(name);
  const value = raw === null || raw.trim() === '' ? NaN : Number(raw);
  if (!Number.isFinite(value)) throw new Error('Missing or invalid desktop geometry parameter: ' + name);
  return value;
}

function requiredRectListParam(name) {
  const raw = params.get(name);
  if (raw === null) throw new Error('Missing desktop geometry parameter: ' + name);
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Invalid desktop geometry parameter: ' + name);
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Invalid desktop geometry parameter: ' + name);
  }
  return value;
}

function requiredIndexParam(name) {
  const raw = params.get(name);
  const value = raw === null || raw.trim() === '' ? NaN : Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error('Missing or invalid desktop geometry parameter: ' + name);
  }
  return value;
}

const VIEW_SCREEN = {
  x: requiredNumberParam('viewX'),
  y: requiredNumberParam('viewY'),
  w: requiredNumberParam('viewW'),
  h: requiredNumberParam('viewH'),
};
if (VIEW_SCREEN.w <= 0 || VIEW_SCREEN.h <= 0) {
  throw new Error('Invalid desktop geometry: viewW and viewH must be positive');
}
const VIEW = {
  x: toLocal(VIEW_SCREEN.x),
  y: toLocal(VIEW_SCREEN.y),
  w: toLocal(VIEW_SCREEN.w),
  h: toLocal(VIEW_SCREEN.h),
};
/** 逐显示器宠物活动区，**视口相对坐标**；Windows 使用 workArea，macOS 会按 Dock 规则调整 */
let AREAS = [];
/** 菜单/聊天框/提示仍限制在工作区，不能随宠物进入菜单栏或 Dock。 */
let WORK_AREAS = [];
/** 逐显示器**完整面板**（含任务栏区，视口相对坐标，与 AREAS 同序）：覆盖窗口与抛掷跨屏邻接探测使用 */
let PANELS = [];
/** 主屏宠物活动区（视口相对坐标）：角落定位与「回到初始位置」使用 */
let PRIMARY_AREA = null;

/** 把主进程给的桌面几何（{hull, areas, workAreas, panels, primaryIndex}，屏幕坐标）挂到渲染坐标系 */
function applyDeskGeometry(geo) {
  const hull = geo && geo.hull;
  const list = geo && geo.areas;
  const workAreas = geo && geo.workAreas;
  const panels = geo && geo.panels;
  const isRect = (rect) =>
    rect &&
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width > 0 &&
    rect.height > 0;
  const isRectList = (rects) => Array.isArray(rects) && rects.length > 0 && rects.every(isRect);
  if (
    !isRect(hull) ||
    !isRectList(list) ||
    !isRectList(workAreas) ||
    !isRectList(panels) ||
    workAreas.length !== list.length ||
    panels.length !== list.length ||
    !Number.isInteger(geo.primaryIndex) ||
    geo.primaryIndex < 0 ||
    geo.primaryIndex >= list.length
  ) {
    return false;
  }
  // 主进程几何是物理像素：hull/areas 逐个 ÷scale 进 CSS 系（§3.5 收口约定——几何导入唯一入口）
  VIEW.x = toLocal(hull.x);
  VIEW.y = toLocal(hull.y);
  VIEW.w = toLocal(hull.width);
  VIEW.h = toLocal(hull.height);
  AREAS = S.translateRects(
    list.map((a) => ({ x: toLocal(a.x), y: toLocal(a.y), width: toLocal(a.width), height: toLocal(a.height) })),
    -VIEW.x,
    -VIEW.y,
  );
  WORK_AREAS = S.translateRects(
    workAreas.map((a) => ({ x: toLocal(a.x), y: toLocal(a.y), width: toLocal(a.width), height: toLocal(a.height) })),
    -VIEW.x,
    -VIEW.y,
  );
  CONFIG.topInsetRatio = Number(geo.topInsetRatio) || 0;
  PANELS = S.translateRects(
    panels.map((a) => ({
      x: toLocal(a.x),
      y: toLocal(a.y),
      width: toLocal(a.width),
      height: toLocal(a.height),
    })),
    -VIEW.x,
    -VIEW.y,
  );
  PRIMARY_AREA = AREAS[geo.primaryIndex];
  return true;
}

// 首帧几何由当前 Electron 主进程通过 URL query 提供；运行期变化再经 pet:displays 推送。
const initialDeskGeometry = {
  hull: { x: VIEW_SCREEN.x, y: VIEW_SCREEN.y, width: VIEW_SCREEN.w, height: VIEW_SCREEN.h },
  areas: requiredRectListParam('areas'),
  panels: requiredRectListParam('panels'),
  workAreas: requiredRectListParam('workAreas'),
  primaryIndex: requiredIndexParam('primaryIndex'),
  topInsetRatio: CONFIG.topInsetRatio,
};
if (!applyDeskGeometry(initialDeskGeometry)) {
  throw new Error('Invalid desktop geometry supplied by the Electron main process');
}
const ORIGIN = new URL(CONFIG.configUrl).origin;
/** 宿主 /dsh-pet-7340 前缀：bridge 走自定义 scheme（主进程转发），否则 HTTP 直连宿主 */
const BASE = BRIDGE ? 'dsh-pet-bridge://dsh-pet/dsh-pet-7340' : ORIGIN + '/dsh-pet-7340';
const STATE_URL = BASE + '/state'; // 轮询统一状态 S：前端 1s 轮询的唯一数据源（余额/工作状态/通知/说话）
const BALANCE_URL = BASE + '/balance'; // 余额刷新动作（POST，写 S；数据本身从 /state 读）
const WHISPER_URL = BASE + '/whisper';
const POSE_REPORT_URL = BASE + '/pose/report';
const POSE_THROTTLE_MS = 300;
const BUBBLE_DURATION_MS = 10 * 1000; // 余额/碎碎念气泡展示时长（与浏览器一致：定时自动消失，与动画解耦）
// 余额气泡展开/收起换内容前的等待（ms）：与 .pet-bubble 的 opacity 过渡同为 .25s，
// 淡出走完再换内容，否则内容会在半透明时被替换 = 看得见的硬切（与浏览器 bubble.ts 同值）
const BALANCE_FADE_MS = 250;
// /state 长轮询的挂起时长（与浏览器端同值）：宿主在"版本没变"时最多挂这么久。
// 1s 是前端自己定的下限——空闲时请求率与改造前一致（1 req/s），叶子一变宿主立刻返回。
const STATE_WAIT_MS = 1000;
// 窗口四周外扩 = 该比例 × 宠物尺寸：为气泡 / 未来可能的弹窗预留显示空间；
// 外扩区透明且点击穿透（只有身体命中区可交互）。单点可调——按实际观感改这里。
const WINDOW_MARGIN_RATIO = 0.5;

// ---------- 全局状态 ----------
const rootEl = document.getElementById('root');
const errorEl = document.getElementById('pet-error');
let config = null; // { pets: 拍平后的成品实例列表, physics, confineToScreen }（loadConfig 填充）
let sprites = []; // PetSprite[]（共享桌面 overlay 内的所有可见宠物）
let overlayInteractiveUpdatePending = false;
let balance = null; // BalanceState（本窗口单宠共用）
let balanceTick = 0;
let balanceNoticeKey = null; // 上次已提示的不可用原因（reason:provider）：自动轮询只在原因变化时再弹（判定在 shared，与浏览器同一份）
let bootTimer = null;
let loopsStarted = false;

// ---------- 调试钩子（冒烟自检/排障用；真实运行也可排查错误/配置/气泡） ----------
window.__dshPetDebug = {
  errors: [],
  configOk: false,
  spriteCount: 0,
  lastBubbleTitle: '',
  lastBalanceOk: null,
  menuOpen: false,
  chatOpen: false,
  bootAt: Date.now(),
};
window.addEventListener('error', (event) => {
  window.__dshPetDebug.errors.push(String(event.message || event.error));
});
