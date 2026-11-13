// preload 桥：只暴露窗口控制原语——
//   - setBounds：宠物窗口逐帧跟随（renderer 上报包围盒的屏幕坐标，主进程 setContentBounds）。
//     x/y/width/height = 窗口内容区坐标（用于移动窗口）；boxX/boxY = 宠物包围盒左上角
//     （工作区坐标）——碰撞站场必须用包围盒坐标，不能用窗口坐标（窗口 = 包围盒 + 四周外扩 margin，
//     差半只宠物宽，会让跨窗碰撞检测整体错位）。
//     size/bottomPad = 碰撞站场登记用（静止宠物只发 set-bounds，靠它带上尺寸才能被其它
//     飞行宠物撞到）；vx/vy = 当前速度（飞行中实时值，静止/拖拽 = 0）。
//   - setInteractive：点击穿透翻转——窗口默认整窗穿透（透明像素不挡下层应用），
//     renderer 在光标进/出宠物身体命中区时上报，主进程 setIgnoreMouseEvents 翻转。
//   - 宠物间碰撞（跨窗，主进程 broker）：位置与速度随 setBounds 一起上报；
//       onFlightStates：订阅主进程合并广播的全量宠物状态（碰撞检测用其它宠物的最新位置/速度）；
//       reportCollide：本窗飞行方检测到撞到 targetId → 主进程把动量结果转发给目标窗；
//       onPetHit：订阅「你被撞了」→ 用新初速 startThrow 抛出去（与浏览器 onHit 同语义）。
const { contextBridge, ipcRenderer } = require('electron');
const { MOVE_TARGETS_CHANNELS } = require('./move-ipc.js');

contextBridge.exposeInMainWorld('petBridge', {
  // 宠物窗口逐帧跟随：x/y/width/height 是窗口内容区坐标（用于移动窗口），
  // boxX/boxY 是宠物包围盒左上角的工作区坐标——碰撞站场必须用包围盒，窗口坐标差半只宠物宽。
  // size/bottomPad 让静止宠物也登记进碰撞站场，vx/vy 是当前速度（静止/拖拽为 0）。
  // marginL/marginT 是窗口原点到本体原点的距离：上边距按气泡最大高度加高后四边不相等，
  // 窗口被系统钳回工作区后还会变大，主进程不能按「窗口宽/4」反推命中区，所以必须上报。
  setBounds(x, y, width, height, boxX, boxY, size, bottomPad, vx, vy, marginL, marginT, freeMotion, positionClaim) {
    ipcRenderer.send('pet:set-bounds', {
      x,
      y,
      width,
      height,
      boxX,
      boxY,
      size,
      bottomPad,
      vx,
      vy,
      marginL,
      marginT,
      freeMotion: freeMotion === true,
      positionClaim: positionClaim === true,
    });
  },
  workStatusDiagnostic(record) {
    ipcRenderer.send('pet:work-status-diagnostic', record);
  },
  showDshNotification(revision, data) {
    ipcRenderer.send('pet:dsh-notification', { revision, data });
  },
  setReducedMotionPreference(reduced) {
    ipcRenderer.send('pet:motion-preference', !!reduced);
  },
  onFullscreenVisibilityTransition(cb) {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('pet:fullscreen-visibility-transition', listener);
    return () => ipcRenderer.removeListener('pet:fullscreen-visibility-transition', listener);
  },
  completeFullscreenVisibilityTransition(id) {
    ipcRenderer.send('pet:fullscreen-transition-complete', id);
  },
  reconcileWorkStatus(agents, eligiblePetIds, stateCounter) {
    ipcRenderer.send('pet:work-status-snapshot', { agents, eligiblePetIds, stateCounter });
  },
  onWorkStatusAssignments(cb) {
    ipcRenderer.on('pet:work-status-assignments', (_event, result) => cb(result));
  },
  moveTargets: {
    begin(petId, moveId, point, kind = 'claim', reason = 'movement') {
      ipcRenderer.send(MOVE_TARGETS_CHANNELS.begin, { ...point, petId, moveId, kind, reason });
    },
    end(petId, moveId, point, reason) {
      ipcRenderer.send(MOVE_TARGETS_CHANNELS.end, { ...point, petId, moveId, reason });
    },
    subscribe(cb) {
      const listener = (_event, targets) => {
        if (Array.isArray(targets)) cb(targets);
      };
      ipcRenderer.on(MOVE_TARGETS_CHANNELS.snapshot, listener);
      ipcRenderer.send(MOVE_TARGETS_CHANNELS.requestSnapshot);
      return () => ipcRenderer.removeListener(MOVE_TARGETS_CHANNELS.snapshot, listener);
    },
    forget(petId) {
      ipcRenderer.send(MOVE_TARGETS_CHANNELS.forget, { petId });
    },
  },
  setInteractive(interactive) {
    ipcRenderer.send('pet:set-interactive', !!interactive);
  },
  setInputBusy(busy) {
    ipcRenderer.send('pet:input-busy', !!busy);
  },
  setInputRegions(input) {
    ipcRenderer.send('pet:input-regions', input);
  },
  // 文本输入拿到 DOM 焦点时向主进程要一次系统键盘焦点：X11 上 DOM 焦点不等于 X 键盘焦点，
  // 窗口又是 showInactive 显示的，不要就一直打不了字（处理在 main/ipc.js）。
  requestKeyboardFocus() {
    ipcRenderer.send('pet:request-keyboard-focus');
  },
  // 右键菜单「打开网站」：去向由主进程按宿主形态决定——桌面应用宿主唤起主窗口，否则用系统浏览器打开站点。
  openDshSite(url) {
    ipcRenderer.send('pet:open-site', { url });
  },
  // 只把 DSH 主窗口提到前台：走应用自注册的 dsh:// 协议（单实例锁会让它聚焦），被别的窗口挡住也有效。
  // 主进程按宿主形态门控：只有桌面应用宿主才真发，web 形态下发它会把桌面版拉起来。
  focusDshHost() {
    ipcRenderer.send('pet:focus-host');
  },
  // 截一帧桌面（宠物所在那块屏）：一次性读取，不建流、不留存。
  // 返回 { mediaType, data, width, height, bytes } 或 null（取不到画面）。
  captureScreen() {
    return ipcRenderer.invoke('pet:capture-screen');
  },
  // 宠物间碰撞（跨窗 broker）：位置与速度随 setBounds 捎带，主进程汇聚后广播；被撞方收 pet:hit 后按新初速抛出。
  onFlightStates(cb) {
    ipcRenderer.on('pet:flight-states', (e, states) => cb(states));
  },
  reportCollide(targetId, vx, vy) {
    ipcRenderer.send('pet:collide-result', { targetId, vx, vy });
  },
  onPetHit(cb) {
    ipcRenderer.on('pet:hit', (e, payload) => cb(payload));
  },
  // 显示器热更新：分辨率/缩放变化、插拔屏、旋转后主进程重算桌面几何并推来
  // （{hull, areas, workAreas, panels, primaryIndex}，屏幕坐标）——渲染端就地重挂视口与边界。
  onDisplays(cb) {
    ipcRenderer.on('pet:displays', (e, geo) => cb(geo));
  },
  // 主进程兜底：宠物自己走开、或窗口被别的窗口接走时，渲染端收不到 mousemove，悬浮提示会一直亮着；
  // 主进程按光标轮询判定「刚离开身体」后通知这里收起。
  onPointerLeft(cb) {
    ipcRenderer.on('pet:pointer-left', () => cb());
  },
});
