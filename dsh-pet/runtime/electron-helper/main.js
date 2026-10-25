/**
 * dsh-pet desktop helper —— Electron 主进程
 *
 * 职责：每只桌宠创建独立的小型透明 BrowserWindow，由 renderer 更新桌宠状态，主进程跟随其位置。
 * 点击穿透由 renderer 的身体命中判定和 setIgnoreMouseEvents 管理。
 * 输入：窗口默认**整窗点击穿透**（setIgnoreMouseEvents(true,{forward:true})），渲染端在光标
 * 进/出宠物身体命中区时经 pet:set-interactive 翻转可交互——透明像素不挡下层应用，
 * 窗口命中区域仅覆盖 .dsh-pet-hit。
 *
 * 数据通道（bridge 模式，DSH_PET_BRIDGE=1 由宿主注入）：
 * 渲染端不再直连宿主 WebServer（DSH Desktop 2.0.3+ 的浏览器访问闸门会拦无令牌裸 HTTP）——
 * 本进程注册自定义 scheme `dsh-pet-bridge://`，protocol.handle 收到渲染端请求后
 * 经 stdout JSON 请求行转发宿主（helper-process.ts 的 BridgeHandler），宿主通过本地 HTTP 回调返回应答，
 * 宿主用与 HTTP 路由同一份 handlePetRoute 应答；素材应答带文件绝对路径，本进程读盘返回。
 * 无 DSH_PET_BRIDGE（手动 start-desktop / 开发流）时保持旧路径：渲染端直接 HTTP 访问宿主。
 *
 * 进程存亡（issue #56）：本进程的 stdout/stderr 是宿主给的管道，宿主一退出读端就消失（下一次写
 * 就是 EPIPE，而 Electron 默认处理器只会弹框且不退出）。故有「宿主存活」一节：管道守卫 +
 * 宿主 PID 探测，宿主没了就自己退——见那里的注释。
 *
 * 启动模式（issue #63）：若被以「纯 Node 模式」拉起（宿主透传了 ELECTRON_RUN_AS_NODE），内置
 * electron 模块不会注册，下面的 require 会失败——报一句能定位原因的话再退出，别只留 MODULE_NOT_FOUND。
 */
let electronApi;
try {
  electronApi = require('electron');
} catch (error) {
  process.stderr.write(
    '[dsh-pet helper] 启动失败：本进程被以「纯 Node 模式」拉起（ELECTRON_RUN_AS_NODE=' +
      JSON.stringify(process.env.ELECTRON_RUN_AS_NODE ?? null) +
      '）。该变量必须在 spawn 前删除（见 src/host/helper-process.ts 的 helperSpawnEnv），' +
      '运行期再删无效，设成空串会让 Electron 直接 abort。原始错误：' +
      (error instanceof Error ? error.message.split('\n')[0] : String(error)) +
      '\n',
  );
  process.exit(3);
}
const { app, BrowserWindow, ipcMain, screen, shell, protocol, Notification, powerMonitor } = electronApi;
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync, spawn } = require('node:child_process');
const { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } = require('node:fs');
const fsPromises = require('node:fs/promises');
// 点击穿透兜底通道的纯判定（不依赖 Electron 的 forward 鼠标钩子；见文件头注释）
const { decideWindowIgnore, pointerZone, POINTER_POLL_MS } = require('./pointer-target.js');
const { createLinuxPointer } = require('./x11-pointer.js');
// 置顶看门狗：WS_EX_TOPMOST 只是样式位，不等于窗口真的在置顶带（见 topmost-watchdog.js 头部）
const {
  TOPMOST_WATCHDOG_TICK_MS,
  TOPMOST_WATCHDOG_ENABLED,
  shouldReassertTopmost,
  topmostLevel,
} = require('./topmost-watchdog.js');
// 宿主存活判定（issue #56：宿主退出 → 管道断开 → 自己退，绝不弹框、绝不留僵尸）
const { HOST_POLL_MS, hostIsGone, isBrokenPipeError, parseHostPid } = require('./host-liveness.js');
// 全局 DPI 线性化的纯判定与换算（含平台例外：macOS 的 DIP 已是「点」，无需补偿；见该文件头）
const { shouldLinearize, resolveForcedScale, resolvePetScale } = require('./dpi-linearization.js');
const { buildDeskGeometry } = require('./desktop-geometry.js');
const linuxPointer = process.platform === 'linux' ? createLinuxPointer() : null;
function currentPointer() {
  const raw = linuxPointer && linuxPointer.get();
  if (!raw) return screen.getCursorScreenPoint();
  const scale = screen.getPrimaryDisplay().scaleFactor || 1;
  return scale === 1 ? raw : { x: Math.round(raw.x / scale), y: Math.round(raw.y / scale) };
}
const { MoveTargets } = require('./move-targets.js');
const { MOVE_TARGETS_CHANNELS, registerMoveTargetHandlers } = require('./move-ipc.js');
const { WorkStatusAssignmentManager } = require('./shared-core.js');
const { createNotificationRevisionGate } = require('./notification-revisions.js');
const { FullscreenDisplayStabilizer } = require('./fullscreen-state.js');

// 允许无用户手势直接播放（余额动画等）
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Match upstream rendering policy: Windows transparent pet windows use software composition.
if (process.platform === 'win32') {
  app.disableHardwareAcceleration();
  // Disabling hardware acceleration still leaves Chromium's GPU process enabled. On Windows systems
  // with virtual displays its sandbox can crash during startup; allow opting back into the sandbox.
  if (process.env.DSH_PET_GPU_SANDBOX !== '1') app.commandLine.appendSwitch('disable-gpu-sandbox');
}

// 显式定名：Helper 是被 `electron.exe <main.js>` 直接拉起的，Electron 取不到 app 名会回落成
// "Electron"，userData 便落到 %APPDATA%\Electron —— 那是所有这么跑的 Electron 脚本的公共目录，
// 我们的 DPI 缓存与 Chromium profile 都会和别人混在一起。必须赶在任何 getPath('userData') 之前设。
const APP_EDITION = process.env.DSH_PET_EDITION === 'public' ? 'public' : 'personal';
const APP_DISPLAY_NAME = process.env.DSH_PET_DISPLAY_NAME || (APP_EDITION === 'public' ? 'DSH Pet' : '哦鲸鲸');
const helperAppName = APP_EDITION === 'public' ? 'dsh-pet-public-electron-helper' : 'dsh-pet-electron-helper';
app.setName(helperAppName);
if (process.env.DSH_PET_STANDALONE === '1' && process.env.DSH_PET_APP_DATA_DIR) {
  app.setPath('appData', path.resolve(process.env.DSH_PET_APP_DATA_DIR));
}
if (process.env.DSH_PET_STANDALONE === '1' && APP_EDITION === 'public') {
  app.setPath('userData', path.join(app.getPath('appData'), helperAppName));
}
if (process.env.DSH_PET_STANDALONE === '1' && process.platform === 'win32') {
  app.setAppUserModelId(process.env.DSH_PET_APP_USER_MODEL_ID || 'cloud.pc2005.dsh-pet');
  app.setToastActivatorCLSID('{8C4174A4-DA42-4E82-9A67-A0A32D76D6B2}');
}

/** DPI 探测子进程模式：不建窗口，只把主屏 scaleFactor 打到 stdout 就退出（见 probePrimaryScale） */
const DPI_PROBE = process.env.DSH_PET_DPI_PROBE === '1';
/** 探测进程的输出标记（父进程按它抓值） */
const DPI_MARK = 'dsh-pet-primary-scale:';

// ---------- 宿主存活（issue #56）：管道断开 / 父进程消失 → 自己退出 ----------
//
// 【为什么必须自己退】宿主退出后，它在 helper 的 stdout/stderr 上握着的管道读端一起关闭；helper
// 下一次写（bridge 协议行 —— 渲染端每秒至少一条 /state 轮询）拿到 EPIPE。未处理的 'error'
// 事件 = 未捕获异常，而 Electron 主进程自带的处理器只弹一个模态框、**且不退出**
// （lib/browser/init.ts 原文注释："Don't quit on fatal error"）—— 桌宠就此卡死、进程赖着不走。
// 真机实测（宿主存活、只切断 stdout 管道）：那次写之后主线程彻底停住，14 秒里一次心跳都没有，
// 进程也一直没有退出。
//
// 两条路都要有，缺一不可：
//   ① 管道守卫：任何一次写失败都不许变成异常；管道断开本身就是"宿主已死"的铁证 → 立刻退。
//      它只在**上层真的写**的时候才触发；
//   ② 宿主探测：每 HOST_POLL_MS 用 kill(pid, 0) 问一次宿主还在不在，ESRCH 即退。
//      渲染端崩了/根本没起来时一次写都不会发生，只有 ② 能收敛。
// 两条路都只经 exitForDeadHost()，且只退一次。
let hostGone = false;
/** 宿主没了 → 立刻退出。这里**不能**再打日志：管道已经断了，写只会再踩一次同一个错误 */
function exitForDeadHost() {
  if (hostGone) return;
  hostGone = true;
  app.exit(0); // 宿主消失是"环境要求我退"，不是自身崩溃，退出码 0
}

// ① 管道守卫：必须赶在**任何一次写**之前装上（probePrimaryScale 失败就会往 stderr 写）
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error) => {
    if (isBrokenPipeError(error)) exitForDeadHost();
    // 其余流错误同样吞掉：Electron 的默认处理是弹模态框，任何流错误都不值得拿桌宠去换一个框
  });
}

// ② 宿主探测：DSH_PET_HOST_PID 由宿主 spawn 时注入；未注入/非法 → parseHostPid 给 0 → 不探测（不误退）。
// DPI 探测实例是一次性短命进程（它的父进程是 helper 而不是宿主），不参与这套机制。
const HOST_PID = parseHostPid(process.env.DSH_PET_HOST_PID);
if (!DPI_PROBE && HOST_PID > 0) {
  setInterval(() => {
    if (hostIsGone(HOST_PID)) exitForDeadHost();
  }, HOST_POLL_MS).unref?.();
}

// ---------- 全局 DPI 线性化（多显示器异构缩放的根因修复） ----------
//
// Windows 上 Chromium 的 DIP↔物理 换算是**逐显示器**的仿射变换，而且
// ScreenWin::DIPToScreenRect(hwnd, rect) 用的是「hwnd 当前归属屏」的那一组参数：
//   physical = (dip − D.dipOrigin) × D.scale + D.pixelOrigin
// 归属由 MonitorFromWindow(MONITOR_DEFAULTTONEAREST) 按面积占比决定，窗口骑缝时会反复翻转。
// 两屏缩放不同时，同一个 DIP 值在翻转前后落到不同物理位置、算出不同物理尺寸
// （实测 1.5/1.75 双屏：位置差 110px、924 DIP 宽的窗口尺寸差 231px），
// 于是 setContentBounds 每帧的落点在两套坐标系之间横跳 —— 这就是拖过屏缝时的「分身闪烁」，
// 也是两屏缩放一致时同样骑缝却毫无问题的原因。
//
// --force-device-scale-factor 让 Chromium 的 GetMonitorScaleFactors() 对所有显示器
// 直接返回同一个值，全部屏塌缩成**同一个**仿射变换 ⇒ DIPToScreenRect 的结果与窗口归属无关。
//
// 取值必须是 **1**，不能取主屏的 scaleFactor。实测（tools/probe-dpi.cjs，1.5 + 1.75 双屏）：
//   forced=1.5 → display.bounds 被二次缩放（主屏物理 3840 宽报成 1706 = 3840/1.5/1.5，
//                而同一块屏的 workArea 报 2560 = 3840/1.5，两者自相矛盾）。
//                DIPToScreenPoint 用 bounds.origin() 当 dipOrigin，于是
//                pixelOrigin(3840) ≠ dipOrigin(1706)×1.5，副屏多出 1281px 的**恒定**偏移——
//                比不加 switch 时的 75px 还糟。
//   forced=1   → bounds 与 workArea 一致，每块屏都满足 pixelOrigin == dipOrigin×scale，
//                DIP 与物理像素成为恒等映射，探针的 DELTA 全 0（尺寸差 231×151 也一并归零）。
// 所以这里锁死 1：坐标系 = Windows 物理像素，跨屏几何再无换算与舍入。
//
// 代价：宠物尺寸的单位从 DIP 变成物理像素，不补偿的话在 150% 的屏上会小 1/1.5。
// 用探测到的**真实主屏 scaleFactor** 乘进渲染端的 CONFIG.scale 抵掉（见 petScale()）——
// 主屏上的观感与修复前逐像素相同；其余屏改按主屏缩放渲染宠物（同尺寸同分辨率的两块屏上
// 物理大小反而一致了）。探测失败就整个不启用，退回修复前行为，不做没有补偿的缩放。
//
// 环境变量 DSH_PET_FORCE_DSF：'0' = 关闭本机制；其它正数 = 强制该值（排障用，会踩上面的 bug）。
//
// 「要不要启用 / 强制成几 / 渲染端乘几」三条规则已抽到 dpi-linearization.js（纯函数、带单测）——
// 其中包含一个平台例外：上面这套补偿的前提是「force-device-scale-factor 会把 DIP 换算成物理像素」，
// 那是 Windows 的行为，macOS 上不成立。原因与实测数据见该文件头，本文件不再复述。
//
// 取值时机是个麻烦：switch 必须在 app ready 之前设，而那时 screen 模块还不可用。
// 所以首次启动 spawn 一个自己的探测子进程（DSH_PET_DPI_PROBE=1，只打印 scaleFactor 就退出，
// ~0.5s）并把结果落盘；之后每次启动直接读缓存，零开销。

/** 主屏缩放缓存文件（userData 在 ready 前即可用） */
function dpiCacheFile() {
  return path.join(app.getPath('userData'), 'primary-scale.json');
}

function readCachedPrimaryScale() {
  try {
    const v = Number(JSON.parse(readFileSync(dpiCacheFile(), 'utf8')).scaleFactor);
    return Number.isFinite(v) && v > 0 ? v : 0;
  } catch {
    return 0; // 首次启动/文件损坏：当作无缓存，重新探测
  }
}

function writeCachedPrimaryScale(value) {
  try {
    writeFileSync(dpiCacheFile(), JSON.stringify({ scaleFactor: value }), 'utf8');
  } catch (e) {
    console.error('[dsh-pet-desktop-helper] write dpi cache failed:', String(e && e.message ? e.message : e));
  }
}

/** 从探测子进程的输出里抓 scaleFactor（0 = 没抓到） */
function parseProbeOutput(text) {
  const m = new RegExp(DPI_MARK + '([0-9.]+)').exec(String(text || ''));
  const v = m ? Number(m[1]) : 0;
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** 拉起探测子进程读主屏 scaleFactor（同一个 electron + 同一个 main.js，走 DPI_PROBE 分支） */
function probePrimaryScale() {
  const opts = {
    env: { ...process.env, DSH_PET_DPI_PROBE: '1', DSH_PET_BRIDGE: '0', DSH_PET_SMOKE: '0' },
    timeout: 20000,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  };
  let out = '';
  try {
    out = execFileSync(process.execPath, [__filename, '--dsh-pet-dpi-probe'], opts);
  } catch (e) {
    // 只认 stdout，不认退出码：一个不开窗口的 Electron 进程调 app.exit() 在 Windows 上
    // 偶发 0xC0000005（退出期访问违例），但那时值早就写出来了，丢掉它纯属浪费一次冷启动。
    out = e && e.stdout ? String(e.stdout) : '';
    if (!parseProbeOutput(out)) {
      const detail = [
        e && e.status !== undefined ? 'status=' + e.status : '',
        e && e.stderr ? 'stderr=' + String(e.stderr).trim().slice(0, 300) : '',
      ]
        .filter(Boolean)
        .join(' ');
      console.error(
        '[dsh-pet-desktop-helper] dpi probe failed:',
        String(e && e.message ? e.message : e).split('\n')[0],
        detail,
      );
      return 0; // 探测失败：不加 switch，退回修复前行为（多屏异构 DPI 会闪，但不影响可用性）
    }
  }
  const v = parseProbeOutput(out);
  if (v > 0) writeCachedPrimaryScale(v);
  return v;
}

/** 真实主屏 scaleFactor（探测所得；0 = 未知）。开启线性化后 screen API 只会报 1，只能靠它。 */
let PRIMARY_SCALE = 0;
/** 实际生效的强制缩放（0 = 未启用，坐标系维持修复前的逐屏 DIP） */
let FORCED_SCALE = 0;
const FORCE_DSF = process.env.DSH_PET_FORCE_DSF;
if (shouldLinearize({ platform: process.platform, dpiProbe: DPI_PROBE, forceDsf: FORCE_DSF })) {
  PRIMARY_SCALE = readCachedPrimaryScale() || probePrimaryScale();
  const forced = resolveForcedScale({ forceDsf: FORCE_DSF, primaryScale: PRIMARY_SCALE });
  if (forced > 0) {
    app.commandLine.appendSwitch('force-device-scale-factor', String(forced));
    FORCED_SCALE = forced;
  }
}

/**
 * 渲染端的 CONFIG.scale：宿主给的基准 × 物理像素补偿。
 * 线性化开启后 1 逻辑像素 = 1 物理像素，宠物按主屏缩放放大回原来的观感。
 */
function petScale() {
  return resolvePetScale({
    baseScale: process.env.DSH_PET_SCALE,
    primaryScale: PRIMARY_SCALE,
    forcedScale: FORCED_SCALE,
  });
}

/** bridge 模式：DSH_PET_BRIDGE=1（宿主注入）。开启时注册 dsh-pet-bridge scheme + 管道转发 */
const BRIDGE = process.env.DSH_PET_BRIDGE === '1';

/** 「打开网站」这一项的去向：
 *  'desktop' = DSH Desktop 环境 → 唤起桌面应用主窗口；
 *  'site'    = Node 命令行或手动 Helper → 默认浏览器打开配置的站点。 */
const OPEN_TARGET = process.env.DSH_PET_OPEN_TARGET === 'desktop' ? 'desktop' : 'site';
/** 协议行前缀（与 helper-process.ts 的 BRIDGE_PREFIX 一致） */
const BRIDGE_PREFIX = 'dsh-pet-bridge:';

if (BRIDGE) {
  // 自定义 scheme：standard（可解析 URL）+ secure（按 https 对待）+ supportFetchAPI（fetch 可用）
  // + stream（视频流）+ corsEnabled（让 CORS 规则生效，配合响应里的 ACAO 头放行 file:// 源页面）
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'dsh-pet-bridge',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        bypassCSP: true,
        corsEnabled: true,
      },
    },
  ]);
}

/** 窗口表：petId -> BrowserWindow */
const windows = new Map();
let notificationWorkerWindow = null;
const notificationRevisionGate = createNotificationRevisionGate();
const fullscreenDisplayStabilizer = new FullscreenDisplayStabilizer(2);
const fullscreenWindowTargets = new Map();
const fullscreenVisibilitySequences = new Map();
const reducedMotionByRenderer = new Map();
const fullscreenTransitionWaiters = new Map();
let fullscreenTransitionSequence = 0;
let foregroundWindowIsTopmost = false;
const FULLSCREEN_FADE_MS = 220;
const NATIVE_SHOW_SETTLE_MS = 260;
const pendingPetPositions = new Map();
let petPositionSaveTimer = null;
function petPositionFile() {
  return process.env.DSH_PET_POSITION_FILE || path.join(app.getPath('userData'), 'pet-positions.json');
}
function readPetPositions() {
  try {
    const parsed = JSON.parse(readFileSync(petPositionFile(), 'utf8'));
    const pets = parsed && typeof parsed.pets === 'object' && parsed.pets ? parsed.pets : {};
    return Object.fromEntries(
      Object.entries(pets).filter(
        ([, position]) => Number.isFinite(Number(position?.x)) && Number.isFinite(Number(position?.y)),
      ),
    );
  } catch {
    return {};
  }
}
function flushPetPositions() {
  if (petPositionSaveTimer !== null) {
    clearTimeout(petPositionSaveTimer);
    petPositionSaveTimer = null;
  }
  if (pendingPetPositions.size === 0) return;
  try {
    const file = petPositionFile();
    mkdirSync(path.dirname(file), { recursive: true });
    const pets = readPetPositions();
    for (const [id, position] of pendingPetPositions) pets[id] = position;
    const temporary = file + '.' + process.pid + '.tmp';
    writeFileSync(temporary, JSON.stringify({ version: 1, pets }), 'utf8');
    renameSync(temporary, file);
    pendingPetPositions.clear();
  } catch (error) {
    console.error('[dsh-pet-desktop-helper] saving pet positions failed:', String(error?.message || error));
  }
}
function rememberPetPosition(id, x, y) {
  if (!id || !Number.isFinite(x) || !Number.isFinite(y)) return;
  pendingPetPositions.set(id, { x, y });
  if (petPositionSaveTimer !== null) clearTimeout(petPositionSaveTimer);
  petPositionSaveTimer = setTimeout(flushPetPositions, 400);
  petPositionSaveTimer.unref?.();
}
app.on('before-quit', flushPetPositions);
const DISPLAY_PRIORITY = ['hide-on-fullscreen', 'hide-on-fullscreen-or-maximized', 'normal'].includes(
  process.env.DSH_PET_DISPLAY_PRIORITY,
)
  ? process.env.DSH_PET_DISPLAY_PRIORITY
  : 'always-on-top';
const HIDE_ON_FULLSCREEN =
  DISPLAY_PRIORITY === 'hide-on-fullscreen' || DISPLAY_PRIORITY === 'hide-on-fullscreen-or-maximized';
const HIDE_ON_MAXIMIZED = DISPLAY_PRIORITY === 'hide-on-fullscreen-or-maximized';
const fullscreenDisplayIds = new Set();
let fullscreenPollTimer;
let fullscreenStateReady = false;

function petIdForWindow(win) {
  for (const [petId, target] of windows) {
    if (target === win) return petId;
  }
  return null;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestFullscreenRendererTransition(win, hidden, transitioning, durationMs) {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return Promise.resolve(false);
  const id = ++fullscreenTransitionSequence;
  return new Promise((resolve) => {
    const timeout = setTimeout(
      () => {
        fullscreenTransitionWaiters.delete(id);
        resolve(false);
      },
      Math.max(350, durationMs + 150),
    );
    fullscreenTransitionWaiters.set(id, {
      rendererId: win.webContents.id,
      timeout,
      resolve,
    });
    try {
      win.webContents.send('pet:fullscreen-visibility-transition', {
        id,
        hidden,
        transitioning,
        durationMs,
      });
    } catch {
      clearTimeout(timeout);
      fullscreenTransitionWaiters.delete(id);
      resolve(false);
    }
  });
}

function completeFullscreenRendererTransition(event, id) {
  const waiter = fullscreenTransitionWaiters.get(id);
  if (!waiter || waiter.rendererId !== event.sender.id) return;
  clearTimeout(waiter.timeout);
  fullscreenTransitionWaiters.delete(id);
  waiter.resolve(true);
}

function isHelperRenderer(sender) {
  const win = BrowserWindow.fromWebContents(sender);
  return !!win && (win === notificationWorkerWindow || [...windows.values()].includes(win));
}

function registerNotificationAndFullscreenIpc() {
  ipcMain.on('pet:dsh-notification', (event, payload) => {
    if (!isHelperRenderer(event.sender)) return;
    const win = BrowserWindow.fromWebContents(event.sender);
    const data = payload?.data;
    if (
      !data ||
      data.type !== 'standalone' ||
      data.source !== 'dsh' ||
      data.sourceForeground === true ||
      typeof data.title !== 'string' ||
      typeof data.body !== 'string' ||
      (win?.isFocused() && win.isVisible()) ||
      !Notification?.isSupported?.() ||
      !notificationRevisionGate.claim(payload?.revision)
    ) {
      return;
    }
    const iconNames = [
      'notify-done',
      'notify-error',
      'notify-truncated',
      'notify-approval',
      'notify-question',
      'notify-test',
    ];
    const iconName = iconNames.includes(data.icon) ? data.icon : 'notify-done';
    const icon = path.resolve(__dirname, '..', '..', 'assets', 'pic', iconName + '.png');
    try {
      new Notification({
        title: data.title,
        body: data.body.length > 80 ? data.body.slice(0, 80) + '…' : data.body,
        icon,
      }).show();
    } catch (error) {
      console.warn('[dsh-pet-desktop-helper] DSH notification failed:', String(error?.message || error));
    }
  });

  ipcMain.on('pet:motion-preference', (event, reducedMotion) => {
    if (!isHelperRenderer(event.sender) || typeof reducedMotion !== 'boolean') return;
    const previous = reducedMotionByRenderer.get(event.sender.id);
    reducedMotionByRenderer.set(event.sender.id, reducedMotion);
    if (previous === reducedMotion || reducedMotion !== true) return;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || petIdForWindow(win) === null) return;
    const target = fullscreenWindowTargets.get(win.id);
    if (target !== undefined) void transitionFullscreenVisibility(win, target);
  });

  ipcMain.on('pet:fullscreen-transition-complete', completeFullscreenRendererTransition);
}

async function transitionFullscreenVisibility(win, hidden) {
  if (!win || win.isDestroyed()) return;
  const sequence = (fullscreenVisibilitySequences.get(win.id) || 0) + 1;
  fullscreenVisibilitySequences.set(win.id, sequence);
  const isCurrent = () =>
    !win.isDestroyed() &&
    fullscreenVisibilitySequences.get(win.id) === sequence &&
    fullscreenWindowTargets.get(win.id) === hidden;
  const reducedMotion = reducedMotionByRenderer.get(win.webContents.id) !== false;
  const durationMs = reducedMotion ? 0 : FULLSCREEN_FADE_MS;

  if (hidden) {
    if (!win.isVisible()) return;
    await requestFullscreenRendererTransition(win, true, true, durationMs);
    if (!isCurrent()) return;
    win.hide();
    await requestFullscreenRendererTransition(win, true, false, 0);
    return;
  }

  if (!win.isVisible()) {
    await requestFullscreenRendererTransition(win, true, true, 0);
    if (!isCurrent()) return;
    win.showInactive();
    if (!reducedMotion) await delay(NATIVE_SHOW_SETTLE_MS);
    if (!isCurrent()) return;
  }

  await requestFullscreenRendererTransition(win, false, true, durationMs);
  if (!isCurrent()) return;
  await requestFullscreenRendererTransition(win, false, false, 0);
}

function matchesDisplayBounds(rect, bounds) {
  const tolerance = Math.max(10, Math.round(Math.min(bounds.width, bounds.height) * 0.02));
  return (
    Math.abs(rect.left - bounds.x) <= tolerance &&
    Math.abs(rect.top - bounds.y) <= tolerance &&
    Math.abs(rect.right - (bounds.x + bounds.width)) <= tolerance &&
    Math.abs(rect.bottom - (bounds.y + bounds.height)) <= tolerance
  );
}

function shouldHideOnFullscreen(win) {
  if (!HIDE_ON_FULLSCREEN || process.platform !== 'win32') return false;
  if (!fullscreenStateReady) return true;
  try {
    const display = screen.getDisplayMatching(win.getBounds());
    return fullscreenDisplayIds.has(String(display.id));
  } catch {
    return false;
  }
}

function showPetWindow(win) {
  if (win.isDestroyed() || shouldHideOnFullscreen(win) || fullscreenWindowTargets.get(win.id) === true) return;
  if (!win.isVisible()) {
    win.showInactive();
  }
}

function keepOffTaskbar(win) {
  if (!win || win.isDestroyed()) return;
  win.setSkipTaskbar(true);
  setTimeout(() => {
    if (!win.isDestroyed()) win.setSkipTaskbar(true);
  }, 0);
}

function applyFullscreenVisibility() {
  for (const win of new Set(windows.values())) {
    if (win.isDestroyed()) continue;
    const hidden = shouldHideOnFullscreen(win);
    const previous = fullscreenWindowTargets.get(win.id);
    if (previous === undefined) {
      fullscreenWindowTargets.set(win.id, hidden);
      if (hidden && win.isVisible()) void transitionFullscreenVisibility(win, true);
      else if (!hidden) showPetWindow(win);
      continue;
    }
    if (previous !== hidden) {
      fullscreenWindowTargets.set(win.id, hidden);
      void transitionFullscreenVisibility(win, hidden);
    } else if (!hidden && !win.isVisible()) {
      void transitionFullscreenVisibility(win, false);
    }
  }
}

function updateFullscreenDisplays(sample, losslessScalingWindows = []) {
  const {
    left: sampleLeft = 0,
    top: sampleTop = 0,
    right: sampleRight = 0,
    bottom: sampleBottom = 0,
    className = '',
    isMaximized = false,
  } = sample || {};
  foregroundWindowIsTopmost = sample?.isTopmost === true;
  const values = [sampleLeft, sampleTop, sampleRight, sampleBottom].map(Number);
  if (values.some((value) => !Number.isFinite(value))) return;
  const [left, top, right, bottom] = values;
  const width = right - left;
  const height = bottom - top;
  const next = new Set();
  const isDesktopShell = ['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd'].includes(className);
  if (!isDesktopShell && width > 0 && height > 0) {
    if (HIDE_ON_FULLSCREEN) {
      for (const display of screen.getAllDisplays()) {
        if (matchesDisplayBounds({ left, top, right, bottom }, display.bounds)) next.add(String(display.id));
      }
    }
    if (HIDE_ON_MAXIMIZED && isMaximized) {
      try {
        const display = screen.getDisplayMatching({ x: left, y: top, width, height });
        next.add(String(display.id));
      } catch {}
    }
  }
  if (HIDE_ON_FULLSCREEN) {
    for (const window of losslessScalingWindows) {
      const rect = window?.rect;
      if (![rect?.left, rect?.top, rect?.right, rect?.bottom].every((value) => Number.isFinite(Number(value)))) {
        continue;
      }
      const windowLeft = Number(rect.left);
      const windowTop = Number(rect.top);
      const windowRight = Number(rect.right);
      const windowBottom = Number(rect.bottom);
      if (windowRight <= windowLeft || windowBottom <= windowTop) continue;
      for (const display of screen.getAllDisplays()) {
        if (
          matchesDisplayBounds(
            { left: windowLeft, top: windowTop, right: windowRight, bottom: windowBottom },
            display.bounds,
          )
        ) {
          next.add(String(display.id));
        }
      }
    }
  }
  const stableNext = fullscreenDisplayStabilizer.update(next);
  fullscreenDisplayIds.clear();
  for (const id of stableNext) fullscreenDisplayIds.add(id);
  fullscreenStateReady = true;
  applyFullscreenVisibility();
}

function startFullscreenWatcher() {
  if (!HIDE_ON_FULLSCREEN || process.platform !== 'win32') return;
  const failOpen = (error) => {
    stopFullscreenWatcher();
    fullscreenStateReady = true;
    fullscreenDisplayIds.clear();
    applyFullscreenVisibility();
    if (error) {
      console.warn('[dsh-pet desktop helper] fullscreen detection disabled:', String(error?.message || error));
    }
  };

  try {
    const { createFullscreenWindowProbe } = require('./win32-fullscreen.js');
    const { readForegroundWindow, enumerateLosslessScalingWindows } = createFullscreenWindowProbe();
    let failed = false;
    let enumerationWarningShown = false;
    const poll = () => {
      try {
        let losslessWindows = [];
        try {
          const displayBounds = screen.getAllDisplays().map((display) => display.bounds);
          losslessWindows = enumerateLosslessScalingWindows(displayBounds);
        } catch (error) {
          if (!enumerationWarningShown) {
            enumerationWarningShown = true;
            console.warn(
              '[dsh-pet desktop helper] Lossless Scaling window enumeration skipped:',
              String(error?.message || error),
            );
          }
        }
        updateFullscreenDisplays(readForegroundWindow(), losslessWindows);
      } catch (error) {
        failed = true;
        failOpen(error);
      }
    };

    poll();
    if (!failed) {
      fullscreenPollTimer = setInterval(poll, 500);
      fullscreenPollTimer.unref?.();
    }
  } catch (error) {
    failOpen(error);
  }
}

function stopFullscreenWatcher() {
  if (fullscreenPollTimer) clearInterval(fullscreenPollTimer);
  fullscreenPollTimer = undefined;
}

/** win.id -> 上一次请求的窗口矩形；宠物窗口尺寸固定，只在位置变化时移动原生窗口。 */
const lastRequestedBounds = new Map();
const winMargins = new Map();
const inputBusy = new Map();
const inputRegions = new Map();
const offBodyMs = new Map();
let pointerFallbackPaused = false;

/**
 * 宠物间碰撞 broker 状态：petId -> { x, y, vx, vy, size, bottomPad }。
 * 来源：pet:set-bounds（位置+尺寸+速度，随漫游/拖拽/静止保真上报，每帧一次）+
 *       pet:report-flight（飞行中每 ~30ms 高频补充速度）。
 * 任何更新都广播全量给所有窗口——每窗飞行方用它做跨窗碰撞检测（滞后 ≤ 1 帧，可接受）。
 */
const petStates = new Map();
const workStatusAssignments = new WorkStatusAssignmentManager();
// Every pet has its own renderer, but work-status ownership is shared by this Electron process.
// Keep each renderer's eligible pets and reconcile against their union; passing one window's
// local list directly would make the same Agent migrate between pets on every renderer poll.
const workStatusEligiblePetIdsByWindow = new Map();
let workStatusSnapshotSourceId = null;
let latestWorkStatusAgents = [];
let latestWorkStatusStateCounter = -1;

function broadcastWorkStatusAssignments() {
  const eligiblePetIds = [...new Set([...workStatusEligiblePetIdsByWindow.values()].flat())];
  const result = workStatusAssignments.reconcile(latestWorkStatusAgents, eligiblePetIds);
  const payload = { agents: latestWorkStatusAgents, ...result };
  for (const target of new Set(windows.values())) {
    if (!target.isDestroyed()) target.webContents.send('pet:work-status-assignments', payload);
  }
}

function acceptWorkStatusSnapshot(event, snapshot) {
  const sourceWindow = BrowserWindow.fromWebContents(event.sender);
  if (!sourceWindow || sourceWindow.isDestroyed() || ![...windows.values()].includes(sourceWindow)) return;
  if (!Array.isArray(snapshot?.agents) || !Array.isArray(snapshot?.eligiblePetIds)) return;

  // Each renderer may report only the pet eligibility owned by its window.
  const ownedPetIds = new Set([...windows].filter(([, win]) => win === sourceWindow).map(([petId]) => petId));
  const eligiblePetIds = snapshot.eligiblePetIds.filter((petId) => typeof petId === 'string' && ownedPetIds.has(petId));
  workStatusEligiblePetIdsByWindow.set(event.sender.id, eligiblePetIds);

  // All windows poll the same state leaf. Its counter rejects delayed responses arriving after a
  // newer state, while the source pin remains as a fallback for older renderers without a counter.
  if (Number.isSafeInteger(snapshot.stateCounter) && snapshot.stateCounter >= 0) {
    if (snapshot.stateCounter >= latestWorkStatusStateCounter) {
      latestWorkStatusStateCounter = snapshot.stateCounter;
      latestWorkStatusAgents = snapshot.agents;
      workStatusSnapshotSourceId = event.sender.id;
    }
  } else {
    if (workStatusSnapshotSourceId === null) workStatusSnapshotSourceId = event.sender.id;
    if (workStatusSnapshotSourceId === event.sender.id) latestWorkStatusAgents = snapshot.agents;
  }
  broadcastWorkStatusAssignments();
}

function releaseWorkStatusRenderer(rendererId) {
  workStatusEligiblePetIdsByWindow.delete(rendererId);
  if (workStatusSnapshotSourceId === rendererId) workStatusSnapshotSourceId = null;
  if (workStatusEligiblePetIdsByWindow.size === 0) {
    latestWorkStatusStateCounter = -1;
    latestWorkStatusAgents = [];
  }
  broadcastWorkStatusAssignments();
}

let petStateBroadcastTimer = null;
// Normal movement claims receive a stable priority. O-relief moves update only their
// endpoint, so a pet cannot pass its O marker to another pet while trying to yield.
const moveTargets = new MoveTargets();
let lastMoveTargetsJSON = '';
// Work-status diagnostics retain their own opt-in file path and bounded async queue.
const WORK_STATUS_DIAGNOSTICS_MAX_FILE_BYTES = 5 * 1024 * 1024;
const WORK_STATUS_DIAGNOSTICS_MAX_RECORD_BYTES = 64 * 1024;
const WORK_STATUS_DIAGNOSTICS_MAX_QUEUE_BYTES = 512 * 1024;
const workStatusDiagnosticsQueue = [];
const workStatusDiagnosticsFileBytes = new Map();
let workStatusDiagnosticsQueueBytes = 0;
let workStatusDiagnosticsDrainActive = false;
let workStatusDiagnosticsWarningShown = false;

function persistWorkStatusDiagnostic(record, file) {
  let line;
  try {
    line = `${JSON.stringify(record)}\n`;
  } catch (error) {
    warnWorkStatusDiagnostics(error);
    return;
  }

  const bytes = Buffer.byteLength(line, 'utf8');
  if (bytes > WORK_STATUS_DIAGNOSTICS_MAX_RECORD_BYTES) return;
  if (workStatusDiagnosticsQueueBytes + bytes > WORK_STATUS_DIAGNOSTICS_MAX_QUEUE_BYTES) return;
  workStatusDiagnosticsQueue.push({ file, line, bytes });
  workStatusDiagnosticsQueueBytes += bytes;
  if (!workStatusDiagnosticsDrainActive) void drainWorkStatusDiagnostics();
}

function warnWorkStatusDiagnostics(error) {
  if (workStatusDiagnosticsWarningShown) return;
  workStatusDiagnosticsWarningShown = true;
  console.error(`[dsh-pet-workdiag] file-write-failed ${error instanceof Error ? error.message : String(error)}`);
}

async function drainWorkStatusDiagnostics() {
  if (workStatusDiagnosticsDrainActive) return;
  workStatusDiagnosticsDrainActive = true;
  try {
    while (workStatusDiagnosticsQueue.length > 0) {
      const file = workStatusDiagnosticsQueue[0].file;
      const batch = [];
      while (workStatusDiagnosticsQueue[0]?.file === file) {
        const entry = workStatusDiagnosticsQueue.shift();
        batch.push(entry);
      }
      const batchBytes = batch.reduce((total, entry) => total + entry.bytes, 0);

      try {
        await fsPromises.mkdir(path.dirname(file), { recursive: true });
        let fileBytes = workStatusDiagnosticsFileBytes.get(file);
        if (fileBytes === undefined) {
          try {
            fileBytes = (await fsPromises.stat(file)).size;
          } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
            fileBytes = 0;
          }
        }

        const content = batch.map((entry) => entry.line).join('');
        if (fileBytes + batchBytes > WORK_STATUS_DIAGNOSTICS_MAX_FILE_BYTES) {
          await fsPromises.writeFile(file, content, 'utf8');
          fileBytes = batchBytes;
        } else {
          await fsPromises.appendFile(file, content, 'utf8');
          fileBytes += batchBytes;
        }
        workStatusDiagnosticsFileBytes.set(file, fileBytes);
      } catch (error) {
        warnWorkStatusDiagnostics(error);
      } finally {
        workStatusDiagnosticsQueueBytes -= batchBytes;
      }
    }
  } finally {
    workStatusDiagnosticsDrainActive = false;
    if (workStatusDiagnosticsQueue.length > 0) void drainWorkStatusDiagnostics();
  }
}

function broadcastMoveTargets() {
  const targets = moveTargets.snapshot();
  const encoded = JSON.stringify(targets);
  if (encoded === lastMoveTargetsJSON) return;
  lastMoveTargetsJSON = encoded;
  for (const win of new Set(windows.values())) {
    if (!win.isDestroyed()) win.webContents.send(MOVE_TARGETS_CHANNELS.snapshot, targets);
  }
}

/** 把当前全量宠物状态广播给所有窗口（碰撞检测的共享站场） */
function broadcastPetStates() {
  const states = {};
  for (const [pid, s] of petStates) {
    states[pid] = {
      x: s.x,
      y: s.y,
      vx: s.vx,
      vy: s.vy,
      size: s.size,
      bottomPad: s.bottomPad,
      updatedAt: s.updatedAt,
    };
  }
  for (const win of new Set(windows.values())) {
    if (!win.isDestroyed()) win.webContents.send('pet:flight-states', states);
  }
  broadcastMoveTargets();
}

/** 记录/更新一只宠物的状态并广播 */
function updatePetState(petId, partial, { newClaim = false } = {}) {
  const prev = petStates.get(petId) || { x: 0, y: 0, vx: 0, vy: 0, size: 0, bottomPad: 0 };
  const state = Object.assign({}, prev, partial, { updatedAt: Date.now() });
  petStates.set(petId, state);
  const settledFreeMotion = prev.freeMotion === true && state.freeMotion !== true;
  const priorTarget = moveTargets.targets.get(petId);
  moveTargets.updateActual(
    petId,
    {
      x: state.x + state.size / 2,
      y: state.y + (state.size * 9) / 32,
      size: state.size,
    },
    { freeMotion: state.freeMotion === true, newClaim: newClaim || settledFreeMotion },
  );
  if (petStateBroadcastTimer !== null) return;
  petStateBroadcastTimer = setTimeout(() => {
    petStateBroadcastTimer = null;
    broadcastPetStates();
  }, 16);
  petStateBroadcastTimer.unref?.();
}

/**
 * 每窗口当前穿透状态（true = 整窗点击穿透）。所有 setIgnoreMouseEvents 只经本文件
 * （创建时初始化 + pet:set-interactive 翻转 + 光标兜底轮询），这里镜像真实状态，供冒烟断言/排查使用
 * （Electron 无 isIgnoringMouseEvents 取值 API）。
 */
const windowIgnore = new Map();

/** 翻转整窗穿透的**唯一出口**：状态与 windowIgnore 镜像永远一起更新（穿透期间保留 forward） */
function setWindowIgnore(win, ignore) {
  win.setIgnoreMouseEvents(ignore, { forward: true });
  windowIgnore.set(win.id, ignore);
}

/**
 * 桌面宠物列表（[{id,size}]）：宿主经 DSH_PET_PETS 透传到共享桌面 renderer。
 * 解析失败/未透传（手动 start-desktop）时回落到单个默认宠物；显式空数组用于托盘常驻时隐藏全部宠物。
 * **空数组是合法输入，不等于「未透传」**：宿主在「桌面宠物被全部关掉、但 Helper 仍需活着
 * 托住托盘」时会明确传 []（见 src/host/index.ts 的 desktopModeEverActive），此时必须建
 * 0 只桌宠——回落成默认宠物会让渲染端读到「没有 desktop 宠物」并弹出红色错误条。
 */
function petsFromEnv() {
  try {
    const raw = process.env.DSH_PET_PETS || '';
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      return arr.map((p, i) => ({
        id: String(p?.id ?? `pet-${i}`),
        size: Number(p?.size) > 0 ? Number(p.size) : 462,
        position: p?.position && typeof p.position === 'object' ? p.position : null,
        index: i,
      }));
    }
  } catch {
    /* fallthrough */
  }
  return [{ id: 'main', size: 462, index: 0 }];
}

/** 窗口初始尺寸 = 宠物包围盒 + 四周外扩余量（4×0.5×size，与 renderer 的 WINDOW_MARGIN_RATIO 一致；
 *  renderer 首帧 set-bounds 会按真实配置精确覆盖，这里只是避免启动瞬间的尺寸跳变）。 */
function petWindowSize(size) {
  const height = (size * 9) / 16;
  const bottomPad = (size * (9 / 16) * (360 - 330)) / 360;
  const m = Math.round(size * 0.5);
  return { width: Math.round(size) + m * 2, height: Math.round(height + bottomPad) + m * 2 };
}

/**
 * 桌面几何：逐显示器的宠物活动区、工作区和完整面板，以及主屏下标。
 */
function deskGeometry() {
  return buildDeskGeometry(screen.getAllDisplays(), screen.getPrimaryDisplay().id, process.platform);
}

function createNotificationWorkerWindow({ geo, configUrl, scale, notificationIcons }) {
  if (notificationWorkerWindow && !notificationWorkerWindow.isDestroyed()) return;
  const area = geo.hull;
  const win = new BrowserWindow({
    width: 1,
    height: 1,
    x: area.x,
    y: area.y,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    focusable: false,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      paintWhenInitiallyHidden: true,
      spellcheck: false,
    },
  });
  notificationWorkerWindow = win;
  win.webContents.setBackgroundThrottling(false);
  win.once('closed', () => {
    if (notificationWorkerWindow === win) notificationWorkerWindow = null;
    reducedMotionByRenderer.delete(win.webContents.id);
  });
  win
    .loadFile(path.join(__dirname, 'index.html'), {
      query: {
        configUrl,
        notificationIcon: pathToFileURL(
          path.resolve(
            __dirname,
            '..',
            '..',
            'assets',
            APP_EDITION === 'public' ? 'logo-rounded.png' : 'dsh-pet-icon-16.png',
          ),
        ).href,
        notificationIcons: JSON.stringify(notificationIcons),
        bridge: BRIDGE ? '1' : '0',
        standalone: process.env.DSH_PET_STANDALONE === '1' ? '1' : '0',
        openTarget: OPEN_TARGET,
        scale: String(scale),
        petIndex: '0',
        petLayouts: '[]',
        workAreaW: String(area.width),
        workAreaH: String(area.height),
        workAreaX: String(area.x),
        workAreaY: String(area.y),
        areas: JSON.stringify(geo.areas),
        workAreas: JSON.stringify(geo.workAreas),
        topInsetRatio: String(geo.topInsetRatio),
        panels: JSON.stringify(geo.panels),
        primaryIndex: String(geo.primaryIndex),
      },
    })
    .catch((error) => {
      console.error('[dsh-pet-desktop-helper] notification worker page load failed:', error);
      win.destroy();
    });
}

/** 每只桌宠使用独立的小型透明窗口。 */
function createPetWindows() {
  const geo = deskGeometry();
  const area = geo.hull;
  const configUrl = process.env.DSH_PET_CONFIG_URL || 'http://127.0.0.1:6952/dsh-pet-7340/config';
  const lastPositions = readPetPositions();
  const pets = petsFromEnv().map((pet) => ({ ...pet, lastPosition: lastPositions[pet.id] || null }));
  const scale = petScale();
  const petLayouts = JSON.stringify(
    pets.map(({ id, size, position, lastPosition }) => ({ id, size, position, lastPosition })),
  );
  const notificationIcons = Object.fromEntries(
    ['notify-done', 'notify-error', 'notify-truncated', 'notify-approval', 'notify-question', 'notify-test'].map(
      (name) => [name, pathToFileURL(path.resolve(__dirname, '..', '..', 'assets', 'pic', name + '.png')).href],
    ),
  );

  if (pets.length === 0) {
    createNotificationWorkerWindow({ geo, configUrl, scale, notificationIcons });
    return;
  }

  for (const pet of pets) {
    const { width, height } = petWindowSize(pet.size * scale);
    const win = new BrowserWindow({
      width,
      height,
      title: `${APP_DISPLAY_NAME} 桌宠（桌面模式）`,
      x: area.x,
      y: area.y,
      show: false,
      useContentSize: true,
      enableLargerThanScreen: true,
      transparent: true,
      backgroundColor: '#00000000',
      frame: false,
      icon: path.resolve(
        __dirname,
        '..',
        '..',
        'assets',
        APP_EDITION === 'public' ? 'logo-rounded.png' : 'dsh-pet-icon.ico',
      ),
      alwaysOnTop: DISPLAY_PRIORITY !== 'normal',
      skipTaskbar: true,
      resizable: false,
      hasShadow: false,
      focusable: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        paintWhenInitiallyHidden: false,
        spellcheck: false,
      },
    });
    win.on('page-title-updated', (event) => {
      event.preventDefault();
      win.setTitle(`${APP_DISPLAY_NAME} 桌宠（桌面模式）`);
    });
    win.setAlwaysOnTop(DISPLAY_PRIORITY !== 'normal', topmostLevel(process.platform));
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: !HIDE_ON_FULLSCREEN });
    win.webContents.setBackgroundThrottling(false);
    win.webContents.on('context-menu', (event) => event.preventDefault());
    win.webContents.on('did-finish-load', () => win.webContents.setZoomFactor(scale));
    setWindowIgnore(win, true);
    win.on('show', () => keepOffTaskbar(win));
    win.once('ready-to-show', () => {
      keepOffTaskbar(win);
      showPetWindow(win);
    });
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        if (!win.isDestroyed() && !win.isVisible() && !shouldHideOnFullscreen(win)) {
          showPetWindow(win);
        }
      }, 400);
    });
    const pointerTimer = setInterval(() => {
      if (pointerFallbackPaused || win.isDestroyed()) return;
      const bounds = win.getBounds();
      if (bounds.width < 8 || bounds.height < 8) return;
      const ignoring = windowIgnore.get(win.id) !== false;
      const busy = inputBusy.get(win.id) === true;
      const point = currentPointer();
      const margins = winMargins.get(win.id);
      const zone = pointerZone(bounds, point, margins);
      const offBodyDuration = !busy && zone === 'margin' ? (offBodyMs.get(win.id) ?? 0) + POINTER_POLL_MS : 0;
      offBodyMs.set(win.id, offBodyDuration);
      const next = decideWindowIgnore(
        bounds,
        point,
        ignoring,
        busy,
        offBodyDuration,
        inputRegions.get(win.id),
        margins,
      );
      if (next !== ignoring) setWindowIgnore(win, next);
    }, POINTER_POLL_MS);
    let lastTopmostAssertMs = Date.now();
    const topmostTimer = setInterval(() => {
      const nowMs = Date.now();
      const due = shouldReassertTopmost(
        {
          nowMs,
          lastAssertMs: lastTopmostAssertMs,
          destroyed: win.isDestroyed(),
          visible: win.isVisible() && fullscreenWindowTargets.get(win.id) !== true,
          paused: pointerFallbackPaused,
          foregroundTopmost: foregroundWindowIsTopmost,
        },
        TOPMOST_WATCHDOG_ENABLED && process.platform === 'win32' && HIDE_ON_FULLSCREEN,
      );
      if (!due) return;
      lastTopmostAssertMs = nowMs;
      if (DISPLAY_PRIORITY !== 'normal') win.setAlwaysOnTop(true, topmostLevel(process.platform));
    }, TOPMOST_WATCHDOG_TICK_MS);
    win.webContents.on('console-message', (...args) => {
      const details = args.find((arg) => typeof arg?.message === 'string');
      const message = typeof details?.message === 'string' ? details.message : undefined;
      if (message?.startsWith('[dsh-pet-workdiag]')) console.error(message);
    });
    const onWorkStatusDiagnostic = (event, record) => {
      if (event.sender !== win.webContents || !record || typeof record !== 'object') return;
      const diagnosticsFile = process.env.DSH_PET_WORK_STATUS_DIAGNOSTICS_FILE;
      if (diagnosticsFile) persistWorkStatusDiagnostic(record, diagnosticsFile);
    };
    ipcMain.on('pet:work-status-diagnostic', onWorkStatusDiagnostic);
    const workStatusRendererId = win.webContents.id;

    win.once('closed', () => {
      clearInterval(pointerTimer);
      clearInterval(topmostTimer);
      ipcMain.removeListener('pet:work-status-diagnostic', onWorkStatusDiagnostic);
      windows.delete(pet.id);
      petStates.delete(pet.id);
      moveTargets.remove(pet.id);
      lastRequestedBounds.delete(win.id);
      winMargins.delete(win.id);
      inputBusy.delete(win.id);
      inputRegions.delete(win.id);
      offBodyMs.delete(win.id);
      windowIgnore.delete(win.id);
      reducedMotionByRenderer.delete(workStatusRendererId);
      fullscreenWindowTargets.delete(win.id);
      fullscreenVisibilitySequences.delete(win.id);
      for (const [id, waiter] of fullscreenTransitionWaiters) {
        if (waiter.rendererId !== workStatusRendererId) continue;
        clearTimeout(waiter.timeout);
        fullscreenTransitionWaiters.delete(id);
        waiter.resolve(false);
      }
      releaseWorkStatusRenderer(workStatusRendererId);
      broadcastPetStates();
    });

    win
      .loadFile(path.join(__dirname, 'index.html'), {
        query: {
          configUrl,
          notificationIcon: pathToFileURL(
            path.resolve(
              __dirname,
              '..',
              '..',
              'assets',
              APP_EDITION === 'public' ? 'logo-rounded.png' : 'dsh-pet-icon-16.png',
            ),
          ).href,
          notificationIcons: JSON.stringify(notificationIcons),
          bridge: BRIDGE ? '1' : '0',
          standalone: process.env.DSH_PET_STANDALONE === '1' ? '1' : '0',
          openTarget: OPEN_TARGET,
          scale: String(scale),
          petIndex: String(pet.index),
          petLayouts,
          workAreaW: String(area.width),
          workAreaH: String(area.height),
          workAreaX: String(area.x),
          workAreaY: String(area.y),
          areas: JSON.stringify(geo.areas),
          workAreas: JSON.stringify(geo.workAreas),
          topInsetRatio: String(geo.topInsetRatio),
          panels: JSON.stringify(geo.panels),
          primaryIndex: String(geo.primaryIndex),
        },
      })
      .catch((error) => {
        console.error(`[dsh-pet-desktop-helper] page load failed (${pet.id}):`, error);
        win.destroy();
      });
    windows.set(pet.id, win);
  }
}

// ---------- bridge 协议（渲染端 custom scheme → 本进程 → 宿主 stdout 请求行 + 本地 HTTP 回调） ----------
// 渲染端的每个 fetch 都落到 dsh-pet-bridge://，protocol.handle 把请求以一行 JSON 写 stdout 转发宿主。
// 本进程先监听 127.0.0.1 随机端口，再创建渲染窗口；请求行携带回调 URL，宿主处理完 POST 应答回来。
// 该本地 HTTP 回调绕过 DSH WebServer 的浏览器访问闸门，按 id 唤醒对应请求。
// 素材（webm/字体/光标）：宿主只回文件绝对路径，本进程自行读盘应答（二进制不过管道）。
// 协议行统一前缀 BRIDGE_PREFIX，宿主侧按前缀区分协议与日志（console 输出也走 stdout）。

let bridgeSeq = 0;
/** id -> {resolve, reject}：一个请求对应宿主的一次回调应答 */
const bridgePending = new Map();
let bridgeCallbackUrl = '';

/** 渲染端请求 → 宿主（请求行带回调 URL）；返回宿主应答（{status, contentType?, body?, file?}），超时抛错 */
function bridgeRequest(method, url, body) {
  return new Promise((resolve, reject) => {
    if (!bridgeCallbackUrl) {
      reject(new Error('bridge callback server is not ready'));
      return;
    }
    const id = ++bridgeSeq;
    bridgePending.set(id, { resolve, reject });
    process.stdout.write(BRIDGE_PREFIX + JSON.stringify({ id, method, url, body, cb: bridgeCallbackUrl }) + '\n');
    // 宿主若长期不应答（进程退出/宿主动作挂起）不无限挂起：45s 兜底（LLM 生成最长 30-60s）
    setTimeout(() => {
      const p = bridgePending.get(id);
      if (!p) return;
      bridgePending.delete(id);
      p.reject(new Error('bridge request timeout'));
    }, 45000).unref?.();
  });
}

/** 把宿主回调应答（{id, status, ...}）派发给对应请求 */
function bridgeResolve(resp) {
  const p = resp && bridgePending.get(resp.id);
  if (!p) return;
  bridgePending.delete(resp.id);
  p.resolve(resp);
}

/** 本地回调服务器：监听成功后才允许注册 bridge handler 和创建渲染窗口。 */
async function startBridgeCallback() {
  const http = require('node:http');
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/respond') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('dsh-pet: not found');
      return;
    }
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        bridgeResolve(JSON.parse(raw));
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
      } catch {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('dsh-pet: bad payload');
      }
    });
    req.on('error', () => {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('dsh-pet: bad payload');
    });
  });
  server.on('error', (e) => {
    console.error('[dsh-pet-desktop-helper] bridge callback server error:', String(e && e.message ? e.message : e));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const addr = server.address();
  if (!addr || typeof addr !== 'object' || !Number.isInteger(addr.port) || addr.port <= 0) {
    server.close();
    throw new Error('bridge callback server did not bind a local port');
  }
  bridgeCallbackUrl = 'http://127.0.0.1:' + addr.port + '/respond';
  console.error('[dsh-pet-desktop-helper] bridge callback: ' + bridgeCallbackUrl);
  return server;
}

/** 处理一个渲染端请求：拼宿主请求行 → 等应答 → 组装 Response（素材读盘） */
async function handleBridgeRequest(request) {
  const url = new URL(request.url); // dsh-pet-bridge://dsh-pet/dsh-pet-7340/...
  const method = request.method || 'GET';
  let body;
  if (method === 'POST' || method === 'PUT') {
    body = await request.text();
  }
  const resp = await bridgeRequest(method, url.pathname + url.search, body);
  const headers = { 'access-control-allow-origin': '*' }; // 渲染端页面是 file:// 源，scheme 跨源需 CORS
  if (resp.contentType) headers['content-type'] = resp.contentType;
  if (resp.file) {
    // 素材：直接读盘返回（宿主已解析好绝对路径；带 range 让视频能拖动进度条）
    try {
      const data = await fsPromises.readFile(resp.file);
      return new Response(new Uint8Array(data), { status: resp.status || 200, headers });
    } catch (e) {
      console.error('[dsh-pet-desktop-helper] bridge file read failed:', resp.file, e);
      return new Response('dsh-pet: asset read failed', { status: 500, headers });
    }
  }
  return new Response(resp.body ?? '', { status: resp.status || 200, headers });
}

// Tray icon and menu are owned by desktop-main.cjs, outside the scaled pet helper.

app.whenReady().then(async () => {
  // 探测子进程：此时没有 force-device-scale-factor，读到的是 Windows 的真实主屏缩放。
  // 退出推迟一拍——在 ready 回调里直接 app.exit() 会赶在 stdout 落盘前拆掉进程
  if (DPI_PROBE) {
    process.stdout.write(DPI_MARK + screen.getPrimaryDisplay().scaleFactor + '\n');
    setTimeout(() => app.exit(0), 0);
    return;
  }
  console.error(
    '[dsh-pet-desktop-helper] displays: ' +
      JSON.stringify(deskGeometry()) +
      ' forcedScaleFactor=' +
      (FORCED_SCALE || 'off') +
      ' primaryScale=' +
      (PRIMARY_SCALE || 'unknown') +
      ' petScale=' +
      petScale(),
  );

  if (BRIDGE) {
    try {
      await startBridgeCallback();
    } catch (e) {
      console.error(
        '[dsh-pet-desktop-helper] bridge callback server failed to start:',
        String(e && e.message ? e.message : e),
      );
      app.exit(1);
      return;
    }
    // 自定义 scheme 接住渲染端全部请求（配置/余额/碎碎念/广播/素材）
    protocol.handle('dsh-pet-bridge', (request) =>
      handleBridgeRequest(request).catch((e) => {
        console.error('[dsh-pet-desktop-helper] bridge handler error:', String(e && e.message ? e.message : e));
        return new Response('dsh-pet: bridge error', {
          status: 502,
          headers: { 'access-control-allow-origin': '*' },
        });
      }),
    );
  }

  // macOS：桌面宠物 Helper 不该单独占 Dock；常驻入口由 desktop-main.cjs 提供。
  if (process.platform === 'darwin' && app.dock) app.dock.hide();

  registerNotificationAndFullscreenIpc();
  startFullscreenWatcher();
  linuxPointer?.start();
  createPetWindows();

  const reassertTaskbar = () => {
    for (const win of windows.values()) keepOffTaskbar(win);
  };
  powerMonitor.on('resume', reassertTaskbar);
  powerMonitor.on('unlock-screen', reassertTaskbar);

  // 工作状态 Agent→桌宠归属由主进程统一仲裁；独立 renderer 不能各自把同一 Agent 分给本窗口的宠物。
  ipcMain.on('pet:work-status-snapshot', acceptWorkStatusSnapshot);

  // 宠物位置：renderer 逐帧上报坐标与碰撞状态。旧式独立小窗口尺寸恒定，只更新原生窗口位置，
  // 避免每帧 setBounds 重设宽高并反复触发 Windows layered surface resize。
  ipcMain.on('pet:set-bounds', (event, bounds) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    const petId = String(bounds?.petId || '');
    if (!petId || windows.get(petId) !== win) return;
    const x = Number(bounds?.x);
    const y = Number(bounds?.y);
    const width = Number(bounds?.width);
    const height = Number(bounds?.height);
    if (![x, y, width, height].every(Number.isFinite)) return;
    const rect = { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
    const previous = lastRequestedBounds.get(win.id);
    if (!previous || previous.width !== rect.width || previous.height !== rect.height) {
      win.setBounds(rect, false);
    } else if (previous.x !== rect.x || previous.y !== rect.y) {
      win.setPosition(rect.x, rect.y, false);
    }
    lastRequestedBounds.set(win.id, rect);
    const marginL = Number(bounds?.marginL);
    const marginT = Number(bounds?.marginT);
    if (Number.isFinite(marginL) && Number.isFinite(marginT)) winMargins.set(win.id, { l: marginL, t: marginT });
    // 碰撞站场：位置必须用**包围盒左上角**（renderer 显式上报 boxX/boxY）——
    // 窗口坐标 = 包围盒 − margin（半只宠物宽），直接拿窗口坐标会让跨窗检测整体错位
    {
      const bx = Number(bounds?.boxX);
      const by = Number(bounds?.boxY);
      const size = Number(bounds?.size);
      const bottomPad = Number(bounds?.bottomPad);
      const vx = Number(bounds?.vx);
      const vy = Number(bounds?.vy);
      if (Number.isFinite(bx) && Number.isFinite(by)) rememberPetPosition(petId, bx, by);
      // 位置 + 尺寸 + 速度一并登记：set-bounds 是每次位置变化都会触发的全量上报
      // （此前只更新 x/y，静止宠物 size 永远为 0，跨窗碰撞检测 `!o.size` 直接跳过它）；
      // 速度取渲染端上报值（飞行中实时、静止/拖拽 = 0），落地后不再残留旧飞行速度。
      updatePetState(
        petId,
        {
          x: Number.isFinite(bx) ? bx : x,
          y: Number.isFinite(by) ? by : y,
          size: Number.isFinite(size) && size > 0 ? size : petStates.get(petId)?.size || 0,
          bottomPad: Number.isFinite(bottomPad) && bottomPad > 0 ? bottomPad : petStates.get(petId)?.bottomPad || 0,
          vx: Number.isFinite(vx) ? vx : 0,
          vy: Number.isFinite(vy) ? vy : 0,
          freeMotion: bounds?.freeMotion === true,
        },
        { newClaim: bounds?.positionClaim === true },
      );
    }
  });

  registerMoveTargetHandlers({
    ipcMain,
    BrowserWindow,
    windows,
    moveTargets,
    broadcastMoveTargets,
  });

  // 飞行状态上报（碰撞站场）：renderer 飞行中每 ~30ms 上报一次自己的位置/速度/尺寸
  ipcMain.on('pet:report-flight', (event, state) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    const petId = String(state?.petId || '');
    if (!petId || windows.get(petId) !== win) return;
    const s = state || {};
    const x = Number(s.x);
    const y = Number(s.y);
    const vx = Number(s.vx);
    const vy = Number(s.vy);
    const size = Number(s.size);
    const bottomPad = Number(s.bottomPad);
    if (![x, y, vx, vy, size, bottomPad].every(Number.isFinite)) return;
    updatePetState(petId, { x, y, vx, vy, size, bottomPad });
  });

  // 碰撞结果转发：飞行方窗口检测到撞到 targetId → 把动量结果（目标新初速）转发给目标窗口
  ipcMain.on('pet:collide-result', (event, payload) => {
    const targetId = payload && typeof payload === 'object' ? String(payload.targetId || '') : '';
    const vx = Number(payload?.vx);
    const vy = Number(payload?.vy);
    if (!targetId || !Number.isFinite(vx) || !Number.isFinite(vy)) return;
    const targetWin = windows.get(targetId);
    if (targetWin && !targetWin.isDestroyed()) {
      targetWin.webContents.send('pet:hit', { petId: targetId, vx, vy });
    }
  });

  // 点击穿透翻转：渲染端更新身体命中状态；菜单与对话框则按实际控件区域裁定。
  ipcMain.on('pet:set-interactive', (event, interactive) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    const input = inputRegions.get(win.id);
    const ignoring =
      interactive && input && inputBusy.get(win.id)
        ? decideWindowIgnore(
            win.getContentBounds(),
            currentPointer(),
            false,
            true,
            0,
            input,
            winMargins.get(win.id),
          )
        : !interactive;
    setWindowIgnore(win, ignoring);
  });

  ipcMain.on('pet:input-busy', (event, busy) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    inputBusy.set(win.id, !!busy);
  });

  ipcMain.on('pet:input-regions', (event, input) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed() || !input || !Array.isArray(input.rects)) return;
    const rects = input.rects.filter(
      (rect) =>
        rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0,
    );
    inputRegions.set(win.id, { dragging: input.dragging === true, rects });
  });

  // 右键菜单「打开网站」：交给**系统默认浏览器**打开（等效于网页里 Ctrl+点击链接新标签页），
  // 不建专属窗口——宠物窗口机制是透明小窗，不该承载常规网页浏览。URL 由渲染端从
  // configUrl 推导自宿主本机 API 地址，端口变化时自动跟随。
  const openSite = (url) => {
    // 宿主注入的已鉴权站点 URL（含本进程启动令牌）：DSH 只在 `GET /` 接受它并换发绑定 authority 的
    // 浏览器 Cookie，裸 origin 在默认浏览器里必然 401（#87）。令牌等价登录态，所以**只在与目标同
    // origin 时**才启用——绝不让它被带去别的站点；取不到该变量（旧宿主 / standalone / 手写
    // start-desktop）时，行为与以前完全一致。
    let target = url;
    const authed = process.env.DSH_PET_SITE_URL || '';
    if (/^https?:[/][/]/.test(authed)) {
      try {
        if (new URL(authed).origin === new URL(url).origin) target = authed;
      } catch {
        /* 形状不对：保持裸地址（原行为） */
      }
    }
    shell.openExternal(target).catch((error) => {
      console.error('[dsh-pet-desktop-helper] openExternal failed:', error);
    });
  };

  // 去向由宿主形态决定（OPEN_TARGET，宿主按自身形态注入）：
  //   desktop（宿主 = DSH 桌面应用）→ 用应用自注册的 dsh:// 协议把主窗口叫回前台：已运行则第二个实例
  //     被单实例锁拦下、宿主收到 second-instance 后 focusPrimaryWindow()；未运行则协议直接把应用拉起来。
  //     比 spawn 宿主 exe 干净——不必处理 ELECTRON_RUN_AS_NODE（spawn 继承它就成了 node 模式，起不了界面）
  //     与安装路径探测。
  //   site（Node 命令行 / 手动 Helper）→ 系统默认浏览器打开配置的站点。
  ipcMain.on('pet:open-site', (event, payload) => {
    const url = payload && typeof payload === 'object' ? String(payload.url || '') : '';
    if (!/^https?:[/][/]/.test(url)) return;
    if (OPEN_TARGET === 'desktop') {
      // 协议未注册（绿色版 / 注册表被清）时回落成打开站点，至少不是"点了没反应"
      shell.openExternal('dsh://open').catch((error) => {
        console.error('[dsh-pet-desktop-helper] open dsh:// failed, falling back to site:', error);
        openSite(url);
      });
      return;
    }
    openSite(url);
  });

  // 右键「打开应用」子菜单：桌面端用协议唤起，Web 端打开宿主提供的已鉴权页面，
  // 独立版则通过 DSH CLI 启动 Web profile。
  const resolveDshCliPath = () => {
    const candidates = [];
    try {
      const systemRoot = process.env.SystemRoot || 'C:\\Windows';
      candidates.push(
        ...execFileSync(path.join(systemRoot, 'System32', 'where.exe'), ['dsh'], {
          encoding: 'utf8',
          windowsHide: true,
        })
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line && /dsh\.(cmd|exe)$/i.test(line)),
      );
    } catch {
      /* PATH 可能未由启动器继承，继续查安装记录 */
    }
    if (process.platform === 'win32') {
      try {
        const uninstall = execFileSync(
          path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe'),
          ['query', 'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/s', '/f', 'DeepSeek Harness'],
          { encoding: 'utf8', windowsHide: true },
        );
        const installLocation = uninstall.match(/^\s*InstallLocation\s+REG_SZ\s+(.+)$/im)?.[1]?.trim();
        if (installLocation)
          candidates.push(path.join(installLocation, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'));
      } catch {
        /* 找不到用户级安装记录时，最后仍可尝试 PATH 命令 */
      }
    }
    const resolved = candidates.find((candidate) => existsSync(candidate));
    if (resolved) {
      console.warn('[dsh-pet-desktop-helper] resolved DSH CLI:', resolved);
      return resolved;
    }
    console.error('[dsh-pet-desktop-helper] DSH CLI path not found; falling back to PATH');
    return 'dsh.cmd';
  };
  const launchDshCli = (args = [], label = 'DSH Web') => {
    if (process.platform !== 'win32') {
      const child = spawn('dsh', args, { detached: true, stdio: 'ignore' });
      child.on('error', (error) => console.error('[dsh-pet-desktop-helper] launch DSH CLI failed:', error));
      child.unref();
      return;
    }
    const cliPath = resolveDshCliPath();
    const safeArgs = args.map((arg) => String(arg).replace(/[\r\n\"]+/g, ''));
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    const cmdPath = path.join(systemRoot, 'System32', 'cmd.exe');
    const workingDirectory = path.dirname(cliPath);
    const safeLabel = String(label).replace(/[\r\n\"]+/g, '');
    const installRoot = path.resolve(workingDirectory, '..', '..', '..', '..');
    const dshExe = path.join(installRoot, 'DeepSeek Harness.exe');
    const dshCliEntry = path.join(
      installRoot,
      'resources',
      'app.asar',
      'dsh',
      'node_modules',
      '@deepseek-ai',
      'dsh-desktop-host',
      'lib',
      'cli.js',
    );
    if (!existsSync(dshExe)) {
      console.error('[dsh-pet-desktop-helper] DSH Node runtime executable not found:', dshExe);
      return;
    }
    const cliInvocation = `"${dshExe}" --expose-internals "${dshCliEntry}"${safeArgs.length ? ' ' + safeArgs.join(' ') : ''}`;
    const commandSwitch = '/c';
    const startCommand = `start "${safeLabel}" /D "${workingDirectory}" "${cmdPath}" /d /s ${commandSwitch} "${cliInvocation}"`;
    const child = spawn(cmdPath, ['/d', '/s', '/c', startCommand], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      windowsVerbatimArguments: true,
      cwd: workingDirectory,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    child.on('spawn', () =>
      console.warn(
        `[dsh-pet-desktop-helper] ${label} visible console dispatched via cmd START with direct Node runtime: pid=${child.pid}`,
      ),
    );
    child.on('error', (error) => console.error(`[dsh-pet-desktop-helper] launch ${label} failed:`, error));
    child.on('close', (code) =>
      console.warn(`[dsh-pet-desktop-helper] ${label} terminal launcher exited: code=${code}`),
    );
    child.unref();
  };
  ipcMain.on('pet:open-app', (_event, payload) => {
    const app = payload && typeof payload === 'object' ? String(payload.app || '') : '';
    const url = payload && typeof payload === 'object' ? String(payload.url || '') : '';
    console.warn('[dsh-pet-desktop-helper] open-app request:', app);
    if (app === 'desktop') {
      shell.openExternal('dsh://open').catch((error) => {
        console.error('[dsh-pet-desktop-helper] open DSH Desktop failed, falling back to Web:', error);
        if (/^https?:[/][/]/.test(url)) openSite(url);
      });
      return;
    }
    if (app === 'web') {
      if (process.env.DSH_PET_STANDALONE === '1') launchDshCli(['web'], 'DSH Web');
      else if (/^https?:[/][/]/.test(url)) openSite(url);
      return;
    }
  });

  // 独立版右键菜单「打开桌宠设置」：请求宿主主进程显示设置页。
  // 设置窗口由 desktop-main.cjs 唯一持有，避免桌宠 Helper 和托盘分别创建两个窗口；
  // 也避免 Helper 的 force-device-scale-factor=1 把普通设置页缩小。
  ipcMain.on('pet:open-settings', () => {
    if (process.env.DSH_PET_STANDALONE !== '1') return;
    bridgeRequest('POST', '/dsh-pet-7340/settings/open', '')
      .then((response) => {
        if (response.status < 200 || response.status >= 300) {
          console.error('[dsh-pet-desktop-helper] settings request failed:', response.status);
        }
      })
      .catch((error) => {
        console.error('[dsh-pet-desktop-helper] settings request failed:', String(error?.message || error));
      });
  });

  // 独立版右键菜单「退出桌宠」：关闭整个桌宠应用（含所有桌宠、设置窗与托盘）。
  ipcMain.on('pet:quit-app', () => {
    if (process.env.DSH_PET_STANDALONE !== '1') return;
    bridgeRequest('POST', '/dsh-pet-7340/app/quit', '')
      .then((response) => {
        if (response.status < 200 || response.status >= 300) {
          console.error('[dsh-pet-desktop-helper] quit request failed:', response.status);
        }
      })
      .catch((error) => {
        console.error('[dsh-pet-desktop-helper] quit request failed:', String(error?.message || error));
      });
  });

  // 显示器热更新：分辨率/缩放变化、插拔屏、旋转都会让桌面几何失效。
  let displaysTimer = null;
  const pushDisplays = () => {
    const geo = deskGeometry();
    for (const win of new Set(windows.values())) {
      if (win.isDestroyed()) continue;
      keepOffTaskbar(win);
      win.webContents.send('pet:displays', geo);
    }
    console.error('[dsh-pet-desktop-helper] displays changed: ' + JSON.stringify(geo));
    // 主屏缩放可能一起变了（它决定宠物的尺寸补偿）。线性化生效期间 screen API 只报被强制的值，
    // 真实值只能靠探测子进程拿；不一致就刷新缓存，下次启动自动用上。
    if (FORCED_SCALE > 0) {
      setTimeout(() => {
        const real = probePrimaryScale();
        if (real > 0 && Math.abs(real - PRIMARY_SCALE) > 1e-6) {
          console.error(
            '[dsh-pet-desktop-helper] primary scaleFactor changed ' +
              PRIMARY_SCALE +
              ' -> ' +
              real +
              '; restart the desktop pet to resize',
          );
        }
      }, 1000).unref?.();
    }
  };
  /** 显示器事件会连发（一次改动能来好几条），去抖后只重算一次 */
  const scheduleDisplays = () => {
    if (displaysTimer) clearTimeout(displaysTimer);
    displaysTimer = setTimeout(() => {
      displaysTimer = null;
      pushDisplays();
    }, 300);
  };
  screen.on('display-metrics-changed', scheduleDisplays);
  screen.on('display-added', scheduleDisplays);
  screen.on('display-removed', scheduleDisplays);

  // 冒烟自检模式（默认关闭）：DSH_PET_SMOKE=1 时延时截图到 DSH_PET_SMOKE_OUT 后退出，
  // 用于验证窗口/渲染/动画链路（如 CI 或本地验证）。
  if (process.env.DSH_PET_SMOKE === '1') {
    const smokeOut = process.env.DSH_PET_SMOKE_OUT || path.join(app.getPath('temp'), 'dsh-pet-smoke.png');
    const afterMs = Number(process.env.DSH_PET_SMOKE_AFTER_MS || 9000);
    const target = windows.values().next().value;
    if (target) {
      // 转发渲染端 console（定位动画/余额/错误问题）
      target.webContents.on('console-message', (event) => {
        console.log(`[renderer:${event.level}] ${event.message}`);
      });
    }
    setTimeout(async () => {
      try {
        const first = windows.values().next().value;
        if (first && !first.isDestroyed()) {
          const dump = await first.webContents.executeJavaScript(`(async () => ({
            hasBridge: typeof window.petBridge !== 'undefined',
            hasSetInteractive: typeof window.petBridge?.setInteractive === 'function',
            viewport: window.innerWidth + 'x' + window.innerHeight,
            dpr: window.devicePixelRatio,
            debug: window.__dshPetDebug || null,
            sprites: document.querySelectorAll('.pet-sprite').length,
            errorVisible: document.getElementById('pet-error').classList.contains('visible'),
            errorText: document.getElementById('pet-error').textContent,
            firstBubble: (document.querySelector('.pet-bubble.is-on') || { textContent: '' }).textContent.slice(0, 120),
            hitCursor: (function () {
              var hit = document.querySelector('.pet-hit');
              return hit ? getComputedStyle(hit).cursor : '';
            })(),
            dragTransform: (function () {
              var hit = document.querySelector('.pet-hit');
              var stage = document.querySelector('.pet-stage');
              if (!hit || !stage) return 'no-sprite';
              var out = { idle: stage.style.transform };
              hit.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 120, clientY: 120, screenX: 120, screenY: 120, pointerId: 91 }));
              out.duringClick = stage.style.transform;
              hit.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 120, clientY: 120, screenX: 120, screenY: 120, pointerId: 91 }));
              out.afterClick = stage.style.transform;
              hit.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 200, clientY: 200, screenX: 200, screenY: 200, pointerId: 92 }));
              hit.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 280, clientY: 240, screenX: 280, screenY: 240, pointerId: 92 }));
              out.duringDrag = stage.style.transform;
              window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 280, clientY: 240, screenX: 280, screenY: 240, pointerId: 92 }));
              out.afterDrag = stage.style.transform;
              return out;
            })(),
            releaseKeptPosition: await (async function () {
              // 独立不变量：把宠物先拖到工作区内的固定安全点（600,300），松手后窗口位置必须原地不动。
              // 拖拽抛掷物理（弹簧跟手+甩抛）下：指针长距跳跃后弹簧需要 ~0.3s 收敛，
              // 松手前停留超过 RELEASE_STALE_MS(150ms) 判为「温柔放下」（估速 null，不抛掷）——
              // 所以先等弹簧到位、再停留才松手，只测"释放瞬间是否位移"。
              var d = window.__dshPetDebug;
              var hit = document.querySelector('.pet-hit');
              if (!d || !d.dragPos || !hit) return null;
              var P = { x: d.dragPos.x, y: d.dragPos.y };
              var T = { x: 600, y: 300 }; // 目标窗口左上角（1708×1020 工作区内，远离四边）
              var upX = 1000 + (T.x - P.x);
              var upY = 600 + (T.y - P.y);
              var sleep = function (ms) {
                return new Promise(function (r) {
                  setTimeout(r, ms);
                });
              };
              hit.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 1000, clientY: 600, screenX: 1000, screenY: 600, pointerId: 93 }));
              hit.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: upX, clientY: upY, screenX: upX, screenY: upY, pointerId: 93 }));
              await sleep(400); // 弹簧跟随收敛
              var during = { x: d.dragPos.x, y: d.dragPos.y };
              await sleep(200); // 轨迹过期 → 估速 null → 温柔放下（不抛掷）
              window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: upX, clientY: upY, screenX: upX, screenY: upY, pointerId: 93 }));
              await sleep(80); // 释放处理完成
              var released = d.lastDragRelease ? { x: d.lastDragRelease.x, y: d.lastDragRelease.y } : null;
              return {
                during: during,
                released: released,
                kept: !!(released && Math.abs(released.x - during.x) <= 1 && Math.abs(released.y - during.y) <= 1),
              };
            })(),
            interactiveFlip: (function () {
              // 点击穿透命中判定：光标在命中区内→可交互；移出→穿透；拖拽中（pointer 已捕获）→强制可交互。
              // hitRect 是 sprite 坐标，mousemove 用窗口坐标——测试事件需加上窗口外扩余量 winMargin。
              var d = window.__dshPetDebug;
              var hit = document.querySelector('.pet-hit');
              if (!d || !d.hitRect || !d.winMargin || !hit) return null;
              var r = d.hitRect;
              var m = d.winMargin;
              var xIn = m.l + r.x + r.w / 2;
              var yIn = m.t + r.y + r.h / 2;
              var xOut = Math.max(0, m.l + r.x - 20);
              var yOut = Math.max(0, m.t + r.y - 20);
              var out = {};
              window.dispatchEvent(new MouseEvent('mousemove', { clientX: xIn, clientY: yIn, screenX: xIn, screenY: yIn }));
              out.inside = d.interactive === true;
              window.dispatchEvent(new MouseEvent('mousemove', { clientX: xOut, clientY: yOut, screenX: xOut, screenY: yOut }));
              out.outside = d.interactive === false;
              hit.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: xIn, clientY: yIn, screenX: xIn, screenY: yIn, pointerId: 94 }));
              window.dispatchEvent(new MouseEvent('mousemove', { clientX: xOut, clientY: yOut, screenX: xOut, screenY: yOut }));
              out.duringDragForced = d.interactive === true;
              window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: xOut, clientY: yOut, screenX: xOut, screenY: yOut, pointerId: 94 }));
              return out;
            })(),
            videoSrcA: (document.querySelectorAll('.pet-sprite video')[0] || { src: '' }).src,
            videoSrcB: (document.querySelectorAll('.pet-sprite video')[1] || { src: '' }).src,
            // 右键菜单自检：在命中区派发 contextmenu → 校验菜单挂载/根文案/子面板/运行错误
            menuSmoke: await (async function () {
              // 前面 drag/release/interactive 测试刚拖过宠：justDragged 100ms 内屏蔽右键，
              // 真实用户不会拖完立刻右键——先等 250ms 消除该时序影响
              await new Promise(function (resolve) {
                setTimeout(resolve, 250);
              });
              var hit = document.querySelector('.pet-hit');
              var d = window.__dshPetDebug;
              if (!hit || !d) return null;
              var errsBefore = (d.errors || []).length;
              try {
                hit.dispatchEvent(
                  new PointerEvent('pointerdown', {
                    bubbles: true,
                    cancelable: true,
                    button: 2,
                    clientX: 400,
                    clientY: 260,
                    screenX: 400,
                    screenY: 260,
                    pointerId: 95,
                  }),
                );
                hit.dispatchEvent(
                  new MouseEvent('contextmenu', {
                    bubbles: true,
                    cancelable: true,
                    button: 2,
                    clientX: 400,
                    clientY: 260,
                    screenX: 400,
                    screenY: 260,
                  }),
                );
              } catch (err) {
                return { threw: String(err), menuMounted: false };
              }
              var menu = document.querySelector('.dsh-pet-menu');
              var out = {
                threw: null,
                menuMounted: !!menu,
                menuOpen: d.menuOpen === true,
                rootText: menu ? menu.textContent.slice(0, 60) : '',
                errsNew: (d.errors || []).length - errsBefore,
              };
              if (menu) {
                var branch = menu.querySelector('.dsh-pet-menu-branch');
                if (branch) {
                  branch.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, relatedTarget: menu }));
                  var panels = Array.prototype.slice.call(
                    menu.querySelectorAll('.dsh-pet-menu-column'),
                  );
                  var visible = function () {
                    return panels.filter(function (p) {
                      return p.style.display !== 'none';
                    });
                  };
                  out.panelCount = panels.length;
                  out.lvl2AfterHoverRoot = visible().length;
                  // 二级：悬停「动作」下的第一个分类 → 打开三级面板（具体动画）
                  var panel1 = visible().filter(function (p) {
                    return p !== panels[0];
                  })[0];
                  if (panel1) {
                    var cat = panel1.querySelector('.dsh-pet-menu-branch');
                    if (cat) {
                      cat.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, relatedTarget: panel1 }));
                      await new Promise(function (resolve) {
                        setTimeout(resolve, 50);
                      });
                      out.lvl3AfterHoverCat = visible().length;
                      // 重放用户路径：鼠标从分类项移向三级面板（先离开分类项进入 4px 缝隙，
                      // 再进入三级面板）——缝隙里 mouseleave 会排 160ms 关闭定时器
                      cat.dispatchEvent(
                        new MouseEvent('mouseleave', { bubbles: false, relatedTarget: document.body }),
                      );
                      await new Promise(function (resolve) {
                        setTimeout(resolve, 60);
                      });
                      var panel2 = visible()[visible().length - 1];
                      if (panel2) {
                        panel2.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
                      }
                      await new Promise(function (resolve) {
                        setTimeout(resolve, 220);
                      });
                      out.lvl3SurvivedAfterReenter = visible().length;
                      // 极端情况：缝隙停留超过关闭延时（鼠标犹豫）
                      cat.dispatchEvent(
                        new MouseEvent('mouseleave', { bubbles: false, relatedTarget: document.body }),
                      );
                      await new Promise(function (resolve) {
                        setTimeout(resolve, 260);
                      });
                      out.lvl3AfterGapHover = visible().length;
                    }
                  }
                }
              }
              return out;
            })(),
          }))()`);
          console.log(
            '[dsh-pet-desktop-helper] smoke dump: windows=' +
              windows.size +
              ' ids=' +
              JSON.stringify([...windows.keys()]) +
              ' => ' +
              JSON.stringify(dump),
          );
          writeFileSync(smokeOut + '.json', JSON.stringify(dump, null, 2), 'utf8');
          console.log('[dsh-pet-desktop-helper] smoke bounds:', JSON.stringify(first.getContentBounds()));
          // 点击穿透 round-trip：setInteractive(true)→窗口捕获输入（忽略鼠标=false）；
          // setInteractive(false)→恢复整窗穿透（忽略鼠标=true）。状态取自主进程镜像 windowIgnore。
          pointerFallbackPaused = true;
          let interactiveIgnoring;
          let passthroughIgnoring;
          try {
            await first.webContents.executeJavaScript('window.petBridge.setInteractive(true); true;');
            await new Promise((r) => setTimeout(r, 80));
            interactiveIgnoring = windowIgnore.get(first.id);
            await first.webContents.executeJavaScript('window.petBridge.setInteractive(false); true;');
            await new Promise((r) => setTimeout(r, 80));
            passthroughIgnoring = windowIgnore.get(first.id);
          } finally {
            pointerFallbackPaused = false;
          }
          console.log(
            '[dsh-pet-desktop-helper] smoke interactive round-trip:',
            JSON.stringify({ interactiveIgnoring, passthroughIgnoring }),
          );
          const image = await first.webContents.capturePage();
          writeFileSync(smokeOut, image.toPNG());
          console.log('[dsh-pet-desktop-helper] smoke capture:', smokeOut);
        }
      } catch (error) {
        console.error('[dsh-pet-desktop-helper] smoke capture failed:', error);
      }
      setTimeout(() => app.quit(), 500);
    }, afterMs);
  }
});

// 退出时销毁托盘图标：不销毁会在 Windows 通知区留下「幽灵图标」（鼠标划过才消失）。
// 注意宿主改 display 时是 SIGTERM/SIGKILL 硬杀（helper-process.ts），Windows 上那是
// TerminateProcess、拦不到，所以这条只覆盖优雅退出（窗口全关、宿主存活探测判定退出等）。
app.on('before-quit', () => {
  stopFullscreenWatcher();
});

app.on('window-all-closed', () => {
  // Helper 由宿主托管生命周期；没有可见宠物时也要保持 bridge 在线，
  // 这样主进程托盘仍可恢复宠物。显示开关变化时宿主会重启这个 helper。
});
