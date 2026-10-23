// preload 桥：只暴露窗口控制原语——
//   - setBounds：宠物窗口逐帧跟随（renderer 上报包围盒的屏幕坐标，主进程 setContentBounds）。
//     x/y/width/height = 窗口内容区坐标（用于移动窗口）；boxX/boxY = 宠物包围盒左上角
//     （工作区坐标）——碰撞站场必须用包围盒坐标，不能用窗口坐标（窗口 = 包围盒 + 四周外扩 margin，
//     差半只宠物宽，会让跨窗碰撞检测整体错位）。
//     size/bottomPad = 碰撞站场登记用（静止宠物只发 set-bounds，靠它带上尺寸才能被其它
//     飞行宠物撞到）；vx/vy = 当前速度（飞行中实时值，静止/拖拽 = 0）。
//   - setInteractive：点击穿透翻转——窗口默认整窗穿透（透明像素不挡下层应用），
//     renderer 在光标进/出宠物身体命中区时上报，主进程 setIgnoreMouseEvents 翻转。
//   - 宠物间碰撞（跨窗，主进程 broker）：
//       reportFlight：飞行中每 ~30ms 上报自己的状态（位置/速度/尺寸）→ 主进程汇聚并广播；
//       onFlightStates：订阅主进程广播的全量宠物状态（碰撞检测用其它宠物的最新位置/速度）；
//       reportCollide：本窗飞行方检测到撞到 targetId → 主进程把动量结果转发给目标窗；
//       onPetHit：订阅「你被撞了」→ 用新初速 startThrow 抛出去（与浏览器 onHit 同语义）。
const { contextBridge, ipcRenderer } = require('electron');
const { MOVE_TARGETS_CHANNELS } = require('./move-ipc.js');
const moveDiagnosticsEnabled = process.env.DSH_PET_MOVE_DIAGNOSTICS === '1';

contextBridge.exposeInMainWorld('petBridge', {
  moveDiagnosticsEnabled,
  setBounds(
    petId,
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
    freeMotion,
    positionClaim,
  ) {
    ipcRenderer.send('pet:set-bounds', {
      petId,
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
      freeMotion,
      positionClaim,
    });
  },
  workStatusDiagnostic(record) {
    ipcRenderer.send('pet:work-status-diagnostic', record);
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
  // 右键菜单「打开网站」：主进程按宿主形态打开——桌面应用宿主唤起桌面窗口（dsh://open），否则系统默认浏览器打开 DSH 网站（等效网页 Ctrl+点击链接）
  openDshSite(url) {
    ipcRenderer.send('pet:open-site', { url });
  },
  openDshApp(app, url) {
    ipcRenderer.send('pet:open-app', { app, url });
  },
  openSettings() {
    ipcRenderer.send('pet:open-settings');
  },
  quitApp() {
    ipcRenderer.send('pet:quit-app');
  },
  // ---- 宠物间碰撞（跨窗 broker）----
  reportFlight(petId, state) {
    ipcRenderer.send('pet:report-flight', { ...state, petId });
  },
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
});
