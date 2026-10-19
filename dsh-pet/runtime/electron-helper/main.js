/**
 * dsh-pet desktop helper —— Electron 主进程
 *
 * 职责：创建覆盖桌面坐标系的透明 BrowserWindow，所有桌宠在同一 renderer 中独立运行。
 * 窗口通过 setShape 只开放宠物与弹出控件附近的区域；宠物移动由 renderer 更新 DOM，不搬动原生窗口。
 *
 * 原生窗口覆盖虚拟桌面并保持完整绘制区域，避免动态 SetWindowRgn 落后于快速移动的宠物而裁切画面。
 * 点击穿透由 setIgnoreMouseEvents 和宠物/控件命中区独立管理。
 * 输入：窗口默认**整窗点击穿透**（setIgnoreMouseEvents(true,{forward:true})），渲染端在光标
 * 进/出宠物身体命中区时经 pet:set-interactive 翻转可交互——透明像素不挡下层应用，
 * 窗口命中区域仅覆盖 .dsh-pet-hit。
 *
 * 数据通道（bridge 模式，DSH_PET_BRIDGE=1 由宿主注入）：
 * 渲染端不再直连宿主 WebServer（DSH Desktop 2.0.3+ 的浏览器访问闸门会拦无令牌裸 HTTP）——
 * 本进程注册自定义 scheme `dsh-pet-bridge://`，protocol.handle 收到渲染端请求后
 * 经 stdin/stdout JSON 行协议转发宿主（helper-process.ts 的 BridgeHandler），
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
const { app, BrowserWindow, ipcMain, screen, shell, protocol } = electronApi;
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
const { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } = require('node:fs');
const fsPromises = require('node:fs/promises');
// 点击穿透兜底通道的纯判定（不依赖 Electron 的 forward 鼠标钩子；见文件头注释）
const { decideWindowIgnore, pointerZone } = require('./pointer-target.js');
// 置顶看门狗：WS_EX_TOPMOST 只是样式位，不等于窗口真的在置顶带（见 topmost-watchdog.js 头部）
const { TOPMOST_WATCHDOG_TICK_MS, shouldReassertTopmost } = require('./topmost-watchdog.js');
// 宿主存活判定（issue #56：宿主退出 → 管道断开 → 自己退，绝不弹框、绝不留僵尸）
const { HOST_POLL_MS, hostIsGone, isBrokenPipeError, parseHostPid } = require('./host-liveness.js');
// 全局 DPI 线性化的纯判定与换算（含平台例外：macOS 的 DIP 已是「点」，无需补偿；见该文件头）
const { shouldLinearize, resolveForcedScale, resolvePetScale } = require('./dpi-linearization.js');
const { buildDeskGeometry } = require('./desktop-geometry.js');
const { MoveTargets } = require('./move-targets.js');
const { MOVE_TARGETS_CHANNELS, registerMoveTargetHandlers } = require('./move-ipc.js');

// 允许无用户手势直接播放（余额动画等）
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Keep Chromium's GPU compositor enabled by default so video frames use the display/GPU path.
// Software composition remains available as a rollback for Windows layered-window issues.
const RENDER_MODE = process.env.DSH_PET_RENDER_MODE === 'software' ? 'software' : 'hardware';
const FRAME_DIAGNOSTICS = process.env.DSH_PET_FRAME_DIAGNOSTICS === '1';

// 显式定名：Helper 是被 `electron.exe <main.js>` 直接拉起的，Electron 取不到 app 名会回落成
// "Electron"，userData 便落到 %APPDATA%\Electron —— 那是所有这么跑的 Electron 脚本的公共目录，
// 我们的 DPI 缓存与 Chromium profile 都会和别人混在一起。必须赶在任何 getPath('userData') 之前设。
const APP_EDITION = process.env.DSH_PET_EDITION === 'public' ? 'public' : 'personal';
const helperAppName = APP_EDITION === 'public' ? 'dsh-pet-public-electron-helper' : 'dsh-pet-electron-helper';
app.setName(helperAppName);
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

// Windows 透明分层窗口（WS_EX_LAYERED）在 DWM 硬件加速合成下曾出现多处缺陷：
//   - 拖拽移动时窗口四周出现黑色边框（#37）
//   - 大透明窗移动覆盖小透明窗时，被覆盖窗口内容丢失（显示"消失"）
// 当前采用固定桌面大小的单透明窗口，原生窗口不随宠物移动；默认保留 GPU 合成以改善视频帧呈现，
// 如仍遇到黑边/消失，可通过 --dsh-pet-render-mode=software 切回软件合成。
if (process.platform === 'win32' && RENDER_MODE === 'software') {
  app.disableHardwareAcceleration();
}
app.on('gpu-info-update', () => {
  console.error(
    `[dsh-pet-desktop-helper] render mode=${RENDER_MODE} hardwareAcceleration=${app.isHardwareAccelerationEnabled()}`,
  );
});

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
// Main-process visual/input watchdogs can sleep while the entire overlay is hidden by fullscreen.
// The fullscreen detector itself remains active so it can wake these timers as soon as visibility returns.
const fullscreenWatcherRefreshers = new Set();
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
const DISPLAY_PRIORITY = ['hide-on-fullscreen', 'normal'].includes(process.env.DSH_PET_DISPLAY_PRIORITY)
  ? process.env.DSH_PET_DISPLAY_PRIORITY
  : 'always-on-top';
const fullscreenDisplayIds = new Set();
let fullscreenPollTimer;
let fullscreenStateReady = false;
let fullscreenZOrderTimer;
let overlayLoweredForFullscreen = false;

function shouldHideOnFullscreen(win) {
  if (DISPLAY_PRIORITY !== 'hide-on-fullscreen' || process.platform !== 'win32') return false;
  if (!fullscreenStateReady) return true;
  try {
    const display = screen.getDisplayMatching(win.getBounds());
    return fullscreenDisplayIds.has(String(display.id));
  } catch {
    return false;
  }
}

function allOverlayPetsHiddenOnFullscreen() {
  return windows.size > 0 && [...windows.keys()].every((petId) => fullscreenHiddenPets.has(petId));
}

function showPetWindow(win) {
  if (win.isDestroyed()) return;
  if (win === overlayWindow) {
    // The overlay spans the full desktop hull. Do not expose its native surface until Chromium
    // has produced the first frame; otherwise Windows may briefly composite the default white
    // backing during helper restarts (for example, after saving pet settings).
    if (!overlayFirstFrameReady || !overlayRendererVisualReady) return;
  } else if (shouldHideOnFullscreen(win)) return;
  if (!win.isVisible()) {
    if (win === overlayWindow && !overlayInitialCompositionReady) {
      // Keep the first native composition transparent while Windows attaches the layered surface.
      win.setOpacity(0);
      win.showInactive();
      setTimeout(() => {
        if (overlayWindow !== win || win.isDestroyed()) return;
        overlayInitialCompositionReady = true;
        win.setOpacity(1);
      }, 120);
    } else {
      win.showInactive();
    }
  }
}

function applyFullscreenVisibility() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    const hidden = {};
    fullscreenHiddenPets.clear();
    for (const petId of windows.keys()) {
      let shouldHide =
        DISPLAY_PRIORITY === 'hide-on-fullscreen' && process.platform === 'win32' && !fullscreenStateReady;
      const bounds = overlayPetBounds.get(petId);
      if (
        !shouldHide &&
        DISPLAY_PRIORITY === 'hide-on-fullscreen' &&
        process.platform === 'win32' &&
        fullscreenStateReady &&
        bounds
      ) {
        try {
          shouldHide = fullscreenDisplayIds.has(String(screen.getDisplayMatching(bounds).id));
        } catch {}
      }
      if (shouldHide) fullscreenHiddenPets.add(petId);
      hidden[petId] = shouldHide;
    }
    const allPetsHidden = allOverlayPetsHiddenOnFullscreen();
    if (!allPetsHidden && fullscreenZOrderTimer) {
      clearTimeout(fullscreenZOrderTimer);
      fullscreenZOrderTimer = undefined;
    }
    if (!allPetsHidden) {
      if (overlayLoweredForFullscreen) {
        overlayWindow.setAlwaysOnTop(true, 'screen-saver');
        overlayLoweredForFullscreen = false;
      }
      showPetWindow(overlayWindow);
      const point = screen.getCursorScreenPoint();
      setWindowIgnore(overlayWindow, !overlayPointIsInteractive(overlayWindow, point));
    } else {
      // Renderer-hidden pets must not leave stale native hit targets behind.
      setWindowIgnore(overlayWindow, true);
    }
    inputBusy.set(
      overlayWindow.id,
      [...overlayInputs].some(([petId, entry]) => !fullscreenHiddenPets.has(petId) && entry.busy),
    );
    overlayWindow.webContents.send('pet:fullscreen-visibility', hidden);
    for (const refresh of fullscreenWatcherRefreshers) refresh();
    updateOverlayShape();
    if (allPetsHidden && !fullscreenZOrderTimer && !overlayLoweredForFullscreen) {
      const target = overlayWindow;
      fullscreenZOrderTimer = setTimeout(() => {
        fullscreenZOrderTimer = undefined;
        if (overlayWindow === target && !target.isDestroyed() && allOverlayPetsHiddenOnFullscreen()) {
          // Keep the shared HWND visible so Windows does not animate it back onscreen on restore.
          // Lower it after the per-pet opacity fade, and leave the renderer/native input pass-through.
          setWindowIgnore(target, true);
          if (DISPLAY_PRIORITY !== 'normal') {
            target.setAlwaysOnTop(false);
            overlayLoweredForFullscreen = true;
          }
        }
      }, 220);
      fullscreenZOrderTimer.unref?.();
    }
    return;
  }
  for (const win of new Set(windows.values())) {
    if (win.isDestroyed()) continue;
    if (shouldHideOnFullscreen(win)) {
      if (win.isVisible()) win.hide();
    } else {
      showPetWindow(win);
    }
  }
}

function updateFullscreenDisplays(sample) {
  const {
    left: sampleLeft = 0,
    top: sampleTop = 0,
    right: sampleRight = 0,
    bottom: sampleBottom = 0,
    className = '',
  } = sample || {};
  const values = [sampleLeft, sampleTop, sampleRight, sampleBottom].map(Number);
  if (values.some((value) => !Number.isFinite(value))) return;
  const [left, top, right, bottom] = values;
  const width = right - left;
  const height = bottom - top;
  const next = new Set();
  const isDesktopShell = ['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd'].includes(className);
  if (!isDesktopShell && width > 0 && height > 0) {
    for (const display of screen.getAllDisplays()) {
      const b = display.bounds;
      const tolerance = Math.max(10, Math.round(Math.min(b.width, b.height) * 0.02));
      if (
        Math.abs(left - b.x) <= tolerance &&
        Math.abs(top - b.y) <= tolerance &&
        Math.abs(right - (b.x + b.width)) <= tolerance &&
        Math.abs(bottom - (b.y + b.height)) <= tolerance
      ) {
        next.add(String(display.id));
      }
    }
  }
  fullscreenDisplayIds.clear();
  for (const id of next) fullscreenDisplayIds.add(id);
  fullscreenStateReady = true;
  applyFullscreenVisibility();
}

function startFullscreenWatcher() {
  if (DISPLAY_PRIORITY !== 'hide-on-fullscreen' || process.platform !== 'win32') return;
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
    const { createForegroundWindowProbe } = require('./win32-fullscreen.js');
    const getForegroundWindow = createForegroundWindowProbe();
    let failed = false;
    const poll = () => {
      try {
        updateFullscreenDisplays(getForegroundWindow());
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

/**
 * win.id -> 渲染端上报的窗口余量 `{ l, t }`（DIP）。
 * 上边距按气泡最大高度加高后**余量不再四边相等**，命中区不能再按「窗口宽/4」反推——
 * 这里存下来交给 pointer-target 的 spriteHitRect（见那里的注释）。
 */
const winMargins = new Map();

/**
 * 宠物间碰撞 broker 状态：petId -> { x, y, vx, vy, size, bottomPad }。
 * 来源：pet:set-bounds（位置+尺寸+速度，随漫游/拖拽/静止保真上报，每帧一次）+
 *       pet:report-flight（飞行中每 ~30ms 高频补充速度）。
 * 任何更新都广播全量给所有窗口——每窗飞行方用它做跨窗碰撞检测（滞后 ≤ 1 帧，可接受）。
 */
const petStates = new Map();
let petStateBroadcastTimer = null;
// Normal movement claims receive a stable priority. O-relief moves update only their
// endpoint, so a pet cannot pass its O marker to another pet while trying to yield.
const moveTargets = new MoveTargets();
let lastMoveTargetsJSON = '';
let lastMoveTargetFlags = new Map();
// TEMPORARY MOVE DIAGNOSTICS: remove the JSONL persistence path before a formal release.
const MOVE_DIAGNOSTICS_SESSION = `${Date.now()}-${process.pid}`;

function persistMoveDiagnostic(record, source) {
  const file =
    process.env.DSH_PET_MOVE_DIAGNOSTICS_FILE || path.join(app.getPath('userData'), 'logs', 'move-diagnostics.jsonl');
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(
      file,
      `${JSON.stringify({ ...record, at: new Date().toISOString(), sessionId: MOVE_DIAGNOSTICS_SESSION, source })}\n`,
      'utf8',
    );
  } catch (error) {
    console.error(`[dsh-pet-move] diagnostics-write-failed ${error instanceof Error ? error.message : String(error)}`);
  }
}

function traceMoveTarget(event, detail) {
  const record = { event, ...detail };
  console.error('[dsh-pet-move] ' + JSON.stringify(record));
  // TEMPORARY MOVE DIAGNOSTICS: remove this persistence call with the writer above.
  persistMoveDiagnostic(record, 'helper-main');
}

function broadcastMoveTargets() {
  const targets = moveTargets.snapshot();
  const encoded = JSON.stringify(targets);
  if (encoded === lastMoveTargetsJSON) return;
  lastMoveTargetsJSON = encoded;
  for (const target of targets) {
    if (target.needsMove !== (lastMoveTargetFlags.get(target.petId) || false)) {
      traceMoveTarget('overlap-marker', {
        petId: target.petId,
        O: target.needsMove,
        reason: target.needsMove
          ? target.moveKind === 'yield'
            ? 'yield-endpoint-still-overlaps'
            : 'newer-claim-overlap'
          : 'endpoint-no-longer-overlaps',
        blockers: target.blockers,
        x: target.x,
        y: target.y,
        priority: target.priority,
        moveKind: target.moveKind,
      });
    }
  }
  lastMoveTargetFlags = new Map(targets.map((target) => [target.petId, target.needsMove]));
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
function updatePetState(petId, partial, { newClaim = false, claimReason = 'direct-position' } = {}) {
  const prev = petStates.get(petId) || { x: 0, y: 0, vx: 0, vy: 0, size: 0, bottomPad: 0 };
  const state = Object.assign({}, prev, partial, { updatedAt: Date.now() });
  petStates.set(petId, state);
  const settledFreeMotion = prev.freeMotion === true && state.freeMotion !== true;
  const priorTarget = moveTargets.targets.get(petId);
  const previousPriority = priorTarget?.priority ?? null;
  moveTargets.updateActual(
    petId,
    {
      x: state.x + state.size / 2,
      y: state.y + (state.size * 9) / 32,
      size: state.size,
    },
    { freeMotion: state.freeMotion === true, newClaim: newClaim || settledFreeMotion },
  );
  const nextTarget = moveTargets.targets.get(petId);
  if (nextTarget && nextTarget.priority !== previousPriority) {
    traceMoveTarget('claim-priority', {
      petId,
      from: previousPriority,
      to: nextTarget.priority,
      kind: nextTarget.moveKind,
      reason: settledFreeMotion ? 'free-motion-settled' : previousPriority === null ? 'initial-position' : claimReason,
      x: nextTarget.x,
      y: nextTarget.y,
    });
  }
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
  const previous = windowIgnore.get(win.id);
  win.setIgnoreMouseEvents(ignore, { forward: true });
  windowIgnore.set(win.id, ignore);
  if (process.env.DSH_PET_INPUT_DIAGNOSTICS === '1' && previous !== ignore && win === overlayWindow) {
    const point = screen.getCursorScreenPoint();
    const local = overlayHull ? { x: point.x - overlayHull.x, y: point.y - overlayHull.y } : null;
    const matches = [];
    if (local) {
      for (const [petId, entry] of overlayInputs) {
        if (fullscreenHiddenPets.has(petId)) continue;
        if (
          [...(entry.bodyRects || []), ...(entry.rects || [])].some(
            (r) => local.x >= r.x && local.x <= r.x + r.width && local.y >= r.y && local.y <= r.y + r.height,
          )
        )
          matches.push(petId);
      }
    }
    console.error(
      '[dsh-pet-inputdiag] ' +
        JSON.stringify({
          ignore,
          cursor: point,
          local,
          matches,
          rects: [...overlayInputs].map(([petId, entry]) => ({ petId, bodyRects: entry.bodyRects || [] })),
        }),
    );
  }
}

/** 兜底通道的光标轮询间隔（ms，与 issue #55 报告者实测值一致） */
const POINTER_POLL_MS = 60;
/** 冒烟期间暂停兜底轮询：它按**真实光标**翻转 windowIgnore，会干扰冒烟对渲染端通道的断言 */
let pointerFallbackPaused = false;

/**
 * 每窗口「渲染端正拿着鼠标输入」标记（win.id → true/false），由渲染端经 `pet:input-busy` 上报。
 *
 * 为什么必须由渲染端说了算：兜底通道判定的是"光标与**窗口矩形**"的关系，而窗口矩形比宠物身体大
 * 一圈（四周各半只宠物的余量）。拖拽时宠物由 rAF 弹簧追赶光标、**滞后**于光标；甩得快时滞后量
 * 超过那一圈余量，光标就落在矩形外 → 判成"窗外" → 翻回穿透 → 渲染端正在拖拽的 window 级
 * pointermove/pointerup 全断（鼠标还按着，宠物却按旧速度"飞"出去，连松手都没人报）。
 *
 * 主进程**无法自行判断**这件事（光看光标位置和窗口位移分不清"拖拽跟手"与"漫游/抛掷"），
 * 而渲染端知道（拖拽中 / 菜单开着 / 对话弹窗开着）。所以只由它上报，busy 期间本进程绝不翻回穿透。
 */
const inputBusy = new Map();
/** 新渲染端把菜单/聊天框局部矩形单独上报，避免忙碌态下整窗透明余量吞点击。 */
const inputRegions = new Map();
/** 单窗口模式下每只宠物独立上报命中区、UI 区域与画布 bounds。 */
const overlayInputs = new Map();
const overlayPetBounds = new Map();
const fullscreenHiddenPets = new Set();
let overlayWindow = null;
let overlayHull = null;
let overlayFirstFrameReady = false;
let overlayRendererVisualReady = false;
let overlayInitialCompositionReady = false;

function updateOverlayShape() {
  const win = overlayWindow;
  if (!win || win.isDestroyed() || !overlayHull || typeof win.setShape !== 'function') return;
  // Keep the native shape equal to the complete virtual desktop. A local moving shape can
  // trail a fast pet because renderer -> main -> SetWindowRgn is asynchronous; the sprite may
  // then be clipped before the next IPC update expands the region. Mouse pass-through remains
  // controlled independently by setIgnoreMouseEvents + overlayPointIsInteractive().
  const rects = [{ x: 0, y: 0, width: Math.round(overlayHull.width), height: Math.round(overlayHull.height) }];
  if (rects[0].width <= 0 || rects[0].height <= 0) return;
  const key = JSON.stringify(rects);
  if (key === win.__petShapeKey) return;
  try {
    win.setShape(rects);
    win.__petShapeKey = key;
    if (!win.isVisible()) showPetWindow(win);
  } catch (error) {
    console.error('[dsh-pet-desktop-helper] setShape failed:', String(error?.message || error));
  }
}

function overlayPointIsInteractive(win, point) {
  if (!win || !overlayHull) return false;
  const x = point.x - overlayHull.x;
  const y = point.y - overlayHull.y;
  for (const [petId, entry] of overlayInputs) {
    if (fullscreenHiddenPets.has(petId)) continue;
    if (entry.busy && entry.dragging) return true;
    for (const r of entry.bodyRects || []) {
      if (x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height) return true;
    }
    for (const r of entry.rects || []) {
      if (x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height) return true;
    }
  }
  return false;
}

/** 旧版局部窗口路径使用的余量停留计时；共享画布路径按交互矩形并集判定。 */
const offBodyMs = new Map();

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
 * 桌面几何：逐显示器的宠物活动区 + 它们的外接矩形 + 主屏下标。
 *
 * 外接矩形（hull）仍然是渲染端视口 VIEW 的来源——它只用作坐标系原点与比例换算基准。
 * 宠物边界判定（漫游落点 / 抛掷反弹 / 角落定位）走 areas 的**并集**，菜单夹取单独走 workAreas：
 * 显示器摆放不规则时 hull 里会有大片不属于任何屏的空洞，以 hull 为边界会把宠物放进去
 * （实测右倒 T 型双屏：hull 的 23.7% 是空洞，宠物飞进去就彻底看不见了）。
 */
function deskGeometry() {
  return buildDeskGeometry(screen.getAllDisplays(), screen.getPrimaryDisplay().id, process.platform);
}

function createPetOverlayWindow() {
  const geo = deskGeometry();
  const area = geo.hull;
  const configUrl = process.env.DSH_PET_CONFIG_URL || 'http://127.0.0.1:6952/dsh-pet-7340/config';
  const lastPositions = readPetPositions();
  const pets = petsFromEnv().map((pet) => ({ ...pet, lastPosition: lastPositions[pet.id] || null }));
  const scale = petScale();
  if (!BrowserWindow.prototype.setShape)
    throw new Error('当前 Electron 不支持 BrowserWindow.setShape，无法启用单窗口桌宠渲染');

  overlayHull = { ...area };
  const win = new BrowserWindow({
    width: Math.round(area.width),
    height: Math.round(area.height),
    x: area.x,
    y: area.y,
    show: false,
    useContentSize: true,
    enableLargerThanScreen: true,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    icon: path.resolve(__dirname, '..', '..', 'assets', 'dsh-pet-icon.ico'),
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
      paintWhenInitiallyHidden: true,
      spellcheck: false,
    },
  });
  overlayWindow = win;
  overlayFirstFrameReady = false;
  overlayRendererVisualReady = false;
  overlayInitialCompositionReady = false;
  win.once('ready-to-show', () => {
    if (overlayWindow !== win || win.isDestroyed()) return;
    overlayFirstFrameReady = true;
    if (win.__petShapeKey) showPetWindow(win);
  });
  win.setAlwaysOnTop(DISPLAY_PRIORITY !== 'normal', 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: DISPLAY_PRIORITY !== 'hide-on-fullscreen' });
  // The shared renderer uses overlayHull as its coordinate origin. If the native full-desktop
  // window is moved independently (for example by a window-manager/DPI transition), every pet
  // remains rendered relative to the old origin and pointer hit-testing becomes offset. Pet
  // dragging is renderer-only, so the overlay itself must stay anchored to the virtual desktop.
  win.on('move', () => {
    setImmediate(() => {
      if (overlayWindow !== win || win.isDestroyed() || !overlayHull) return;
      const currentHull = deskGeometry().hull;
      // A real display-layout change is handled by the debounced display watcher below. Don't
      // snap to stale geometry while Electron is still delivering that transition.
      if (currentHull.x !== overlayHull.x || currentHull.y !== overlayHull.y) return;
      const bounds = win.getBounds();
      const x = Math.round(overlayHull.x);
      const y = Math.round(overlayHull.y);
      if (Math.abs(bounds.x - x) <= 1 && Math.abs(bounds.y - y) <= 1) return;
      console.error(
        `[dsh-pet-desktop-helper] overlay window moved unexpectedly (${bounds.x},${bounds.y}); restoring (${x},${y})`,
      );
      win.setPosition(x, y, false);
    });
  });
  win.webContents.setBackgroundThrottling(false);
  win.webContents.on('did-start-loading', () => {
    // A renderer reload must not retain endpoints claimed by its previous sprites.
    for (const [petId, petWin] of windows) {
      if (petWin !== win || !moveTargets.remove(petId)) continue;
      // TEMPORARY MOVE DIAGNOSTICS: remove this record before a formal release.
      traceMoveTarget('remove-target', { petId, reason: 'renderer-reload' });
    }
    broadcastMoveTargets();
  });
  win.webContents.on('context-menu', (event) => event.preventDefault());
  win.webContents.on('console-message', (_event, detailsOrLevel, legacyMessage) => {
    // Electron 旧签名为 (event, level, message, line, sourceId)，新版把消息
    // 放进 details.message。当前打包所用 Electron 仍走旧签名。
    const message =
      typeof legacyMessage === 'string'
        ? legacyMessage
        : typeof detailsOrLevel === 'string'
          ? detailsOrLevel
          : detailsOrLevel?.message;
    // Forward work-status and movement diagnostics without requiring DevTools.
    if (message?.startsWith('[dsh-pet-workdiag]')) console.error(message);
    if (FRAME_DIAGNOSTICS && message?.startsWith('[dsh-pet-frame-diagnostics]')) console.error(message);
    if (message?.startsWith('[dsh-pet-move]')) {
      console.error(message);
      // TEMPORARY MOVE DIAGNOSTICS: remove JSONL forwarding with persistMoveDiagnostic.
      try {
        const record = JSON.parse(message.slice('[dsh-pet-move]'.length).trim());
        if (record && typeof record === 'object' && !Array.isArray(record)) {
          persistMoveDiagnostic(record, 'renderer');
        }
      } catch (error) {
        console.error(`[dsh-pet-move] diagnostics-parse-failed ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  });
  const onWorkStatusDiagnostic = (event, record) => {
    if (event.sender !== win.webContents || !record || typeof record !== 'object') return;
    const diagnosticsFile = process.env.DSH_PET_WORK_STATUS_DIAGNOSTICS_FILE;
    if (!diagnosticsFile) return;
    try {
      mkdirSync(path.dirname(diagnosticsFile), { recursive: true });
      appendFileSync(diagnosticsFile, `${JSON.stringify(record)}\n`, 'utf8');
    } catch (error) {
      console.error(`[dsh-pet-workdiag] file-write-failed ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  ipcMain.on('pet:work-status-diagnostic', onWorkStatusDiagnostic);
  win.once('closed', () => ipcMain.removeListener('pet:work-status-diagnostic', onWorkStatusDiagnostic));
  win.webContents.on('did-finish-load', () => win.webContents.setZoomFactor(scale));
  setWindowIgnore(win, true);

  let pointerTimer;
  let lastTopmostAssertMs = Date.now();
  let topmostTimer;
  const stopFullscreenVisualWatchers = () => {
    if (pointerTimer) clearInterval(pointerTimer);
    if (topmostTimer) clearInterval(topmostTimer);
    pointerTimer = undefined;
    topmostTimer = undefined;
  };
  const startFullscreenVisualWatchers = () => {
    if (win.isDestroyed() || pointerTimer || topmostTimer) return;
    pointerTimer = setInterval(() => {
      if (pointerFallbackPaused || win.isDestroyed()) return;
      const bounds = win.getBounds();
      if (bounds.width < 8 || bounds.height < 8) return;
      const ignoring = windowIgnore.get(win.id) !== false;
      const point = screen.getCursorScreenPoint();
      const dragging = [...overlayInputs].some(([petId, entry]) => !fullscreenHiddenPets.has(petId) && entry.dragging);
      const next = !dragging && !overlayPointIsInteractive(win, point);
      if (next !== ignoring) setWindowIgnore(win, next);
    }, POINTER_POLL_MS);
    topmostTimer = setInterval(() => {
      const nowMs = Date.now();
      const due = shouldReassertTopmost({
        nowMs,
        lastAssertMs: lastTopmostAssertMs,
        destroyed: win.isDestroyed(),
        visible: win.isVisible(),
        paused: pointerFallbackPaused,
      });
      if (!due) return;
      lastTopmostAssertMs = nowMs;
      if (DISPLAY_PRIORITY !== 'normal') win.setAlwaysOnTop(true, 'screen-saver');
    }, TOPMOST_WATCHDOG_TICK_MS);
  };
  const refreshFullscreenVisualWatchers = () => {
    if (win === overlayWindow && allOverlayPetsHiddenOnFullscreen()) stopFullscreenVisualWatchers();
    else startFullscreenVisualWatchers();
  };
  fullscreenWatcherRefreshers.add(refreshFullscreenVisualWatchers);
  refreshFullscreenVisualWatchers();
  win.on('closed', () => {
    fullscreenWatcherRefreshers.delete(refreshFullscreenVisualWatchers);
    stopFullscreenVisualWatchers();
    for (const [petId, petWin] of windows) {
      if (petWin !== win) continue;
      windows.delete(petId);
      petStates.delete(petId);
      overlayInputs.delete(petId);
      overlayPetBounds.delete(petId);
      // TEMPORARY MOVE DIAGNOSTICS: remove this record before a formal release.
      if (moveTargets.remove(petId)) traceMoveTarget('remove-target', { petId, reason: 'window-closed' });
    }
    broadcastPetStates();
    if (fullscreenZOrderTimer) {
      clearTimeout(fullscreenZOrderTimer);
      fullscreenZOrderTimer = undefined;
    }
    overlayWindow = null;
    overlayLoweredForFullscreen = false;
    overlayFirstFrameReady = false;
    overlayRendererVisualReady = false;
    overlayInitialCompositionReady = false;
    lastRequestedBounds.delete(win.id);
    windowIgnore.delete(win.id);
    inputBusy.delete(win.id);
    inputRegions.delete(win.id);
    offBodyMs.delete(win.id);
  });

  const notificationIcons = Object.fromEntries(
    ['notify-done', 'notify-error', 'notify-truncated', 'notify-approval', 'notify-question', 'notify-test'].map(
      (name) => [name, pathToFileURL(path.resolve(__dirname, '..', '..', 'assets', 'pic', name + '.png')).href],
    ),
  );
  const petLayouts = JSON.stringify(
    pets.map(({ id, size, position, lastPosition }) => ({ id, size, position, lastPosition })),
  );
  win
    .loadFile(path.join(__dirname, 'index.html'), {
      query: {
        configUrl,
        notificationIcon: pathToFileURL(path.resolve(__dirname, '..', '..', 'assets', 'dsh-pet-icon-16.png')).href,
        notificationIcons: JSON.stringify(notificationIcons),
        bridge: BRIDGE ? '1' : '0',
        standalone: process.env.DSH_PET_STANDALONE === '1' ? '1' : '0',
        openTarget: OPEN_TARGET,
        scale: String(scale),
        overlay: '1',
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
        frameDiagnostics: FRAME_DIAGNOSTICS ? '1' : '0',
      },
    })
    .catch((error) => {
      console.error('[dsh-pet-desktop-helper] page load failed:', error);
      win.destroy();
    });
  for (const pet of pets) windows.set(pet.id, win);
}
// ---------- bridge 协议（渲染端 custom scheme → 本进程 → 宿主 stdout JSON 行 + 本地回调） ----------
// 渲染端的每个 fetch 都落到 dsh-pet-bridge://，protocol.handle 把请求以一行 JSON 写 stdout 转发宿主。
// 宿主应答**不走近 0 号管道**：Electron 主进程在 Windows 上收不到 piped stdin（electron#4218），
// 所以本进程开一个 127.0.0.1 随机端口 HTTP 回调（DSH 闸门只拦 DSH WebServer 路由，管不到这里）；
// 请求行携带回调 URL，宿主处理完 POST 应答回来，按 id 唤醒等待中的请求。
// 素材（webm/字体/光标）：宿主只回文件绝对路径，本进程自行读盘应答（二进制不过管道）。
// 协议行统一前缀 BRIDGE_PREFIX，宿主侧按前缀区分协议与日志（console 输出也走 stdout）。

let bridgeSeq = 0;
/** id -> {resolve, reject}：一个请求对应宿主的一次回调应答 */
const bridgePending = new Map();
let bridgeCallbackUrl = '';

/** 渲染端请求 → 宿主（请求行带回调 URL）；返回宿主应答（{status, contentType?, body?, file?}），超时抛错 */
function bridgeRequest(method, url, body) {
  return new Promise((resolve, reject) => {
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

/** 本地回调服务器：宿主把应答 POST 到这里（127.0.0.1 随机端口，绕开 stdin/DSH 闸门） */
function startBridgeCallback() {
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
  server.listen(0, '127.0.0.1', () => {
    const addr = server.address();
    bridgeCallbackUrl = 'http://127.0.0.1:' + (addr && typeof addr === 'object' ? addr.port : 0) + '/respond';
    console.error('[dsh-pet-desktop-helper] bridge callback: ' + bridgeCallbackUrl);
  });
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

app.whenReady().then(() => {
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
    startBridgeCallback(); // 宿主应答回调服务器（stdin 在 Electron 主进程不可用，改走本地 HTTP）
  }

  // macOS：桌面宠物 Helper 不该单独占 Dock；常驻入口由 desktop-main.cjs 提供。
  if (process.platform === 'darwin' && app.dock) app.dock.hide();

  startFullscreenWatcher();
  createPetOverlayWindow();

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
    if (win !== overlayWindow) {
      const previous = lastRequestedBounds.get(win.id);
      if (!previous || previous.width !== rect.width || previous.height !== rect.height) {
        win.setBounds(rect, false);
      } else if (previous.x !== rect.x || previous.y !== rect.y) {
        win.setPosition(rect.x, rect.y, false);
      }
      lastRequestedBounds.set(win.id, rect);
    } else {
      overlayPetBounds.set(petId, rect);
      const prior = overlayInputs.get(petId) || { busy: false, dragging: false, rects: [], bodyRects: [] };
      const body = [bounds?.bodyX, bounds?.bodyY, bounds?.bodyWidth, bounds?.bodyHeight].map(Number);
      const bodyRects =
        body.every(Number.isFinite) && body[2] > 0 && body[3] > 0
          ? [
              {
                x: Math.round(body[0]),
                y: Math.round(body[1]),
                width: Math.round(body[2]),
                height: Math.round(body[3]),
              },
            ]
          : prior.bodyRects;
      overlayInputs.set(petId, { ...prior, bodyRects });
      updateOverlayShape();
      if (!win.isVisible() && win.__petShapeKey) showPetWindow(win);
    }
    // 窗口余量（左右/上）：命中区判定的依据，余量四边不再相等（上边距按气泡最大高度加高）
    const ml = Number(bounds?.marginL);
    const mt = Number(bounds?.marginT);
    if (Number.isFinite(ml) && Number.isFinite(mt)) winMargins.set(win.id, { l: ml, t: mt });
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
      updatePetState(petId, {
        x: Number.isFinite(bx) ? bx : x,
        y: Number.isFinite(by) ? by : y,
        size: Number.isFinite(size) && size > 0 ? size : petStates.get(petId)?.size || 0,
        bottomPad: Number.isFinite(bottomPad) && bottomPad > 0 ? bottomPad : petStates.get(petId)?.bottomPad || 0,
        vx: Number.isFinite(vx) ? vx : 0,
        vy: Number.isFinite(vy) ? vy : 0,
        freeMotion: bounds?.freeMotion === true,
      }, { newClaim: bounds?.positionClaim === true, claimReason: 'position-command' });
    }
  });

  ipcMain.on('pet:renderer-visual-ready', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win !== overlayWindow || win.isDestroyed()) return;
    overlayRendererVisualReady = true;
    const visibility = {};
    for (const petId of windows.keys()) visibility[petId] = fullscreenHiddenPets.has(petId);
    win.webContents.send('pet:fullscreen-visibility', visibility);
    if (win.__petShapeKey) showPetWindow(win);
  });

  registerMoveTargetHandlers({
    ipcMain,
    BrowserWindow,
    windows,
    moveTargets,
    traceMoveTarget,
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

  // 点击穿透翻转：renderer 在光标进/出身体命中区时上报；穿透期间仍保留 forward（mousemove 继续转发）。
  // 兜底轮询（见 createPetOverlayWindow）也走同一个出口 setWindowIgnore，共享同一份镜像状态。
  ipcMain.on('pet:set-interactive', (event, interactive) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    if (win === overlayWindow && allOverlayPetsHiddenOnFullscreen()) {
      setWindowIgnore(win, true);
      return;
    }
    const point = screen.getCursorScreenPoint();
    const busy =
      win === overlayWindow
        ? [...overlayInputs].some(([petId, entry]) => !fullscreenHiddenPets.has(petId) && entry.busy)
        : inputBusy.get(win.id) === true;
    const ignoringNow = windowIgnore.get(win.id) !== false;
    const captureRequested = interactive === true || busy;
    const ignoring =
      !captureRequested &&
      (win === overlayWindow
        ? !overlayPointIsInteractive(win, point)
        : decideWindowIgnore(
            win.getBounds(),
            point,
            ignoringNow,
            false,
            offBodyMs.get(win.id) || 0,
            inputRegions.get(win.id),
            winMargins.get(win.id),
          ));
    setWindowIgnore(win, ignoring);
  });

  // 拖拽持有完整输入租约；菜单/对话则由 inputRegions 把交互限制在实际控件矩形内。
  // 只存标记、不直接翻转窗口——**唯一出口**仍是 setWindowIgnore（在兜底轮询里按完整规则判定），
  // 否则会出现"两条通道抢着翻同一个窗口"的竞态。
  ipcMain.on('pet:input-busy', (event, payload) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    const petId = String(payload?.petId || '');
    if (!petId || windows.get(petId) !== win) return;
    const prior = overlayInputs.get(petId) || { dragging: false, rects: [], bodyRects: [] };
    overlayInputs.set(petId, { ...prior, busy: payload.busy === true });
    inputBusy.set(
      win.id,
      [...overlayInputs].some(([id, entry]) => !fullscreenHiddenPets.has(id) && entry.busy),
    );
  });

  ipcMain.on('pet:input-regions', (event, input) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed() || !input || !Array.isArray(input.rects)) return;
    const petId = String(input.petId || '');
    if (!petId || windows.get(petId) !== win) return;
    const rects = input.rects.filter(
      (r) => r && [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0,
    );
    const bodyRects = (Array.isArray(input.bodyRects) ? input.bodyRects : []).filter(
      (r) => r && [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0,
    );
    const prior = overlayInputs.get(petId) || { busy: false };
    overlayInputs.set(petId, { ...prior, dragging: input.dragging === true, rects, bodyRects });
    inputRegions.set(win.id, {
      rects: win === overlayWindow ? [...overlayInputs.values()].flatMap((entry) => entry.rects || []) : rects,
    });
    updateOverlayShape();
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

  // 显示器热更新：分辨率/缩放变化、插拔屏、旋转都会让桌面几何失效。原先几何只在
  // createPetOverlayWindow() 算一次并经 URL query 注入；显示器变化后重算并推给共享 renderer。
  let displaysTimer = null;
  const pushDisplays = () => {
    const geo = deskGeometry();
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayHull = { ...geo.hull };
      for (const [petId, entry] of overlayInputs) {
        overlayInputs.set(petId, { ...entry, rects: [], bodyRects: [] });
      }
      overlayWindow.setBounds({
        x: Math.round(geo.hull.x),
        y: Math.round(geo.hull.y),
        width: Math.round(geo.hull.width),
        height: Math.round(geo.hull.height),
      });
      overlayWindow.__petShapeKey = null;
      updateOverlayShape();
      overlayWindow.webContents.send('pet:displays', geo);
    } else {
      for (const win of new Set(windows.values())) {
        if (!win.isDestroyed()) win.webContents.send('pet:displays', geo);
      }
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
                  new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 400, clientY: 260, screenX: 400, screenY: 260 }),
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
          console.log('[dsh-pet-desktop-helper] smoke bounds:', JSON.stringify(first.getContentBounds()));
          // 点击穿透 round-trip：setInteractive(true)→窗口捕获输入（忽略鼠标=false）；
          // setInteractive(false)→恢复整窗穿透（忽略鼠标=true）。状态取自主进程镜像 windowIgnore。
          // 期间暂停兜底轮询：它按真实光标位置翻转，冒烟时鼠标不在宠物身上会覆盖本断言的状态。
          pointerFallbackPaused = true;
          await first.webContents.executeJavaScript('window.petBridge.setInteractive(true); true;');
          await new Promise((r) => setTimeout(r, 80));
          const interactiveIgnoring = windowIgnore.get(first.id);
          await first.webContents.executeJavaScript('window.petBridge.setInteractive(false); true;');
          await new Promise((r) => setTimeout(r, 80));
          const passthroughIgnoring = windowIgnore.get(first.id);
          pointerFallbackPaused = false;
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
