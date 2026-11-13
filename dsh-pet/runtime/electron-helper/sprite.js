/**
 * dsh-pet desktop helper —— 宠物本体（PetSprite 类）。
 *
 * 播放 / 拖拽抛掷 / 跨窗碰撞 / 点击穿透 / 右键菜单 / 聊天弹窗 / 气泡渲染。
 * 事件联动（余额 / 碎碎念 / 广播 / 工作状态）不在此文件——见 events.js。
 * 依赖 constants.js 的全局（CONFIG / VIEW / BASE / S / config / sprites 等），须后加载。
 */
'use strict';

// 左键 + 修饰键 =「呼出 DSH」快捷键。macOS 上 Ctrl+左键会变成系统右键，故使用 Cmd。
const OPEN_SHORTCUT_HINT = /Mac/i.test(navigator.platform || navigator.userAgent) ? 'Cmd+左键' : 'Ctrl+左键';
const isOpenShortcut = (e) => !!(e && (e.ctrlKey || e.metaKey));

const CLICK_SOUND_URL = BASE + '/sound/click-duck.wav';
let clickAudio = null;
let lastClickSoundAt = 0;
function playClickSound() {
  if (!config || config.clickSoundEnabled !== true) return;
  const now = Date.now();
  if (now - lastClickSoundAt < 100) return;
  lastClickSoundAt = now;
  try {
    clickAudio = clickAudio || new Audio(CLICK_SOUND_URL);
    clickAudio.volume = 0.5;
    clickAudio.currentTime = 0;
    const playback = clickAudio.play();
    if (playback && typeof playback.catch === 'function') playback.catch(() => {});
  } catch {}
}

function clampPetCenterToRegion(areas, cx, cy, halfW, halfH, sideAllow, topInset) {
  if (!Array.isArray(areas) || areas.length === 0) return { x: cx, y: cy };
  const bodyHalfW = Math.max(0, halfW - sideAllow);
  const points = [
    [cx, cy],
    [cx - bodyHalfW, cy],
    [cx + bodyHalfW, cy],
    [cx, cy - halfH + topInset],
    [cx, cy + halfH],
  ];
  if (points.every(([x, y]) => S.rectAtPoint(areas, x, y))) return { x: cx, y: cy };

  let best = null;
  let bestDistance = Infinity;
  for (const area of areas) {
    const minX = area.x + bodyHalfW;
    const maxX = area.x + area.width - bodyHalfW - 1;
    const minY = area.y + halfH - topInset;
    const maxY = area.y + area.height - halfH - 1;
    if (maxX < minX || maxY < minY) continue;
    const x = Math.max(minX, Math.min(maxX, cx));
    const y = Math.max(minY, Math.min(maxY, cy));
    const distance = (x - cx) ** 2 + (y - cy) ** 2;
    if (distance < bestDistance) {
      best = { x, y };
      bestDistance = distance;
    }
  }
  return best || S.clampPointToRegion(areas, cx, cy);
}

// ---------- 单只宠物（行为与浏览器 PetCard 一致；纯逻辑来自 src/shared） ----------
class PetSprite {
  constructor(pet, index = CONFIG.petIndex) {
    this.pet = pet; // 这只宠物的配置段（拍平后的成品实例，条目级字段已吹入：动画池/权重/周期）
    this.index = index;
    this.layout = CONFIG.petLayouts.find((layout) => layout.id === pet.id) || CONFIG.petLayouts[index] || {};
    this.pointerOnBody = false;
    // 页面级缩放（main 对窗口 setZoomFactor(CONFIG.scale)，见 DESIGN.md §3.5）统一放大整窗：
    // pet.size 即 CSS 像素基准，**不再手工乘 CONFIG.scale**——固定 px UI（菜单/积分/聊天）
    // 随同一缩放自动恢复 DIP 观感；跨进程交换（bounds/几何/碰撞）由 constants.js 的
    // toScreen/toLocal 收口换算，这里与 shared 组件一样零乘除。
    this.size = pet.size;
    this.height = (this.size * 9) / 16;
    this.halfW = this.size / 2;
    this.halfH = this.height / 2;
    this.bottomPad = (this.size * (9 / 16) * (S.CANVAS_H - S.FEET_Y)) / S.CANVAS_H;
    // 窗口高 = 舞台高 + 脚底垫高（stage 被 translateY(bottomPad) 下移的余量，防底部被窗口裁剪）
    this.winH = this.height + this.bottomPad;
    // 窗口内【可交互区域】= 身体命中区（像素，窗口坐标）。桌宠身体命中区是 .dsh-pet-hit
    // pointer-events:auto（root/stage/气泡全 none）——桌面严格对齐：命中区外含透明像素一律穿透到下层应用。
    // HIT_BOX 是 640×360 舞台坐标：x 按窗口宽缩放；y 除舞台高外还要加 bottomPad（舞台被下移）。
    this.hitRect = {
      x: (S.HIT_BOX.x0 / 640) * this.size,
      y: this.bottomPad + (S.HIT_BOX.y0 / 360) * this.height,
      w: ((S.HIT_BOX.x1 - S.HIT_BOX.x0) / 640) * this.size,
      h: ((S.HIT_BOX.y1 - S.HIT_BOX.y0) / 360) * this.height,
    };
    window.__dshPetDebug.hitRect = this.hitRect;
    // 左右透明边余量（视频盒内宠物身体居中）：让边界按"身体"贴边——宠物能走到屏幕边缘，
    // 但身体永不越界（漫游/拖拽都不会弄丢宠物）。
    this.sideAllow = (S.HIT_BOX.x0 / 640) * this.size;
    window.__dshPetDebug.sideAllow = this.sideAllow;
    // 窗口四周外扩：左右下 = WINDOW_MARGIN_RATIO×宠物尺寸；上边距按气泡与待办面板的最大高度算——
    // 两者都锚字号、窗口余量锚宠物，宠物变小或字号固定时半只宠物的余量装不下，顶端会被窗口上沿切掉。
    // 余量透明且点击穿透，加高没有副作用；但它自此不再四边相等，所以命中区要由主进程按上报值算。
    const m = this.size * WINDOW_MARGIN_RATIO;
    const fontConf = pet.font || config.font || S.DEFAULT_FONT;
    this.margin = {
      t: Math.max(m, S.bubbleTopMarginPx(fontConf, this.size), S.todoPanelTopMarginPx(fontConf, this.size)),
      r: m,
      b: m,
      l: m,
    };
    // 本体在窗口内的偏移：不钳制时等于上面的余量，窗口被系统钳回工作区时变大（见 fitWindow）。
    // 所有「窗口原点 = 本体位置 − 偏移」的推导都必须用它，不能再直接减 margin。
    this.winOffset = { x: this.margin.l, y: this.margin.t };
    window.__dshPetDebug.winOffset = { x: this.margin.l, y: this.margin.t };
    // 宠物包围盒左上角在【工作区】坐标系里的位置（本窗口的位置 = 宠物的位置）
    this.pos = { x: 0, y: 0 };

    // 配置派生字段：拍平的实例优先，其次全局，最后内置默认。
    // 拖拽抛掷物理参数
    this.physics = pet.physics || config.physics || S.DEFAULT_PHYSICS;
    // 字体：字号按本宠物尺寸算；字体族由 renderer.js 注入 documentElement（fontConf 见上，上边距用的是同一份）
    this.font = fontConf;
    // 抛掷锁定在当前屏幕（根字段；拍平已吹入实例，兜底回主条目/默认）：
    // true = 甩出去只在松手时所在那块屏内弹（屏缝当墙），false = 照常跨屏飞行
    this.confineToScreen = pet.confineToScreen === true || config.confineToScreen === true;
    // 素材根按 assetRoot（文件宠物 = 配置文件前缀，多实例共享同一素材目录）或宠物 id 回落
    this.assetRoot = pet.assetRoot || pet.id;
    this.assetBase = BASE + '/thumb/' + encodeURIComponent(this.assetRoot) + '/';

    this.initPlayback(pet);
    this.initMotion();
    this.initPanels();
    this.buildDom();
    this.bindEvents();
  }

  dispose() {
    this.disposed = true;
    this.pending = null;
    this.gen++;
    for (const timer of this.videoReleaseTimers.values()) window.clearTimeout(timer);
    this.videoReleaseTimers.clear();
    for (const video of [this.videoA, this.videoB]) {
      if (!video) continue;
      video.onended = null;
      video.onerror = null;
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
    this.ac.abort();
    this.inputRegionMutation.disconnect();
    this.inputRegionResize.disconnect();
    this.inputRegionElements.clear();
    if (this.bubbleTimer !== null) window.clearTimeout(this.bubbleTimer);
    if (this.envTimer !== null) window.clearTimeout(this.envTimer);
    if (this.balanceFadeTimer !== null) window.clearTimeout(this.balanceFadeTimer);
    if (this.whisperTimer !== null) window.clearTimeout(this.whisperTimer);
    if (this.workTimer !== null) window.clearTimeout(this.workTimer);
    if (this.chatMount) {
      this.chatMount.close();
      this.chatMount = null;
    }
    this.closeMenu();
    this.stopThrow();
    this.stopDragFollow();
    this.stopSquash();
    this.stopMove();
    if (this.poseTimer !== null) window.clearTimeout(this.poseTimer);
    this.poseTimer = null;
    window.petBridge?.moveTargets?.forget?.(this.pet.id);
    this.el.remove();
  }

  get facing() {
    return this._facing;
  }

  set facing(next) {
    const value = next === 'right' ? 'right' : 'left';
    if (this._facing === value) return;
    this._facing = value;
    this.markPoseDirty();
  }

  markPoseDirty() {
    if (this.poseTimer !== null) return;
    this.poseTimer = window.setTimeout(() => {
      this.poseTimer = null;
      this.reportPose();
    }, POSE_THROTTLE_MS);
  }

  reportPose() {
    if (!this.pos) return;
    const body = {
      x: (this.pos.x + this.halfW) / VIEW.w,
      y: (this.pos.y + this.halfH) / VIEW.h,
      facing: this.facing,
    };
    const url = POSE_REPORT_URL + '?pet=' + encodeURIComponent(this.pet.id) + '&surface=desktop';
    void S.postAction(url, body);
  }

  sendBounds(px, py) {
    this.pos = { x: Math.round(px), y: Math.round(py) };
    // 窗口落位与上报：系统把窗口钳回工作区时，钳掉的量转成本体在窗口内的偏移（见 fitWindow）
    const fit = this.fitWindow();
    // 偏移有上限：想要的位置超出可达范围时，本体只能停在实际能到的位置。这里把 pos 拉回现实，
    // 否则「想要」与「渲染」越差越远——往回拖要先走完这段虚位，宠物才会动，看着像拖不回来。
    this.pos = { x: Math.round(fit.x + fit.offsetX), y: Math.round(fit.y + fit.offsetY) };
    window.__dshPetDebug.dragPos = { x: this.pos.x, y: this.pos.y };
    this.reportWindow(fit);
    // 位置变了：提示跟的是光标，而光标存视口坐标，窗口一移就必须重摆，否则提示会跟着窗口漂走。
    // 只在显示时重摆（漫游逐帧调本函数，没显示提示时不做无谓的 DOM 写入）。
    if (this.tipOn) this.renderTip();
    // 实况标脏（节流上报，见 markPoseDirty）：所有位移都收口在本函数，所以这里一处就够
    this.markPoseDirty();
  }

  // 角落/边距 → 本体位置；拖拽后按会话内位置（比例）还原。
  // 边界只由 sendBounds 的窗口落位负责，且与网页端同一条规则：命中区至少留 24px 在屏幕内，其余可挂出去。
  position() {
    const W = VIEW.w;
    const H = VIEW.h;
    let x;
    let y;
    if (this.customPos) {
      x = this.customPos.rx * W - this.halfW;
      y = this.customPos.ry * H - this.halfH;
    } else {
      // 角落取**主屏**而不是外接矩形：不规则多屏布局下外接矩形的角落可能不属于任何显示器
      // （实测右倒 T 型双屏，top-left 落在主屏上方的空洞里），配了该角落的宠物开机即隐身。
      const anchor = S.anchorPixel({
        corner: this.pet.position.corner,
        // marginX/marginY 是配置里的绝对像素：页面级缩放（§3.5）已统一放大整窗，
        // 配置值不再手工乘 CONFIG.scale——150% 屏上与「线性化 + 旧 CONFIG.scale 补偿」观感一致
        marginX: this.pet.position.marginX,
        // macOS 顶部边距对齐身体命中盒，扣掉动画画布头顶留白。
        marginY:
          this.pet.position.marginY -
          (this.pet.position.corner.startsWith('top-') ? this.size * CONFIG.topInsetRatio : 0),
        size: this.size,
        W,
        H,
        area: PRIMARY_AREA || undefined,
      });
      x = anchor.x;
      y = anchor.y;
      // 多只桌宠若配置在同一角落，启动时先沿角落向内错开，避免它们从重叠位置一起起跑。
      // 只有同一 corner/margin 的实例参与错位；用户分开配置的位置保持原样。
      const layout = this.layout;
      const position = this.pet.position || {};
      const margin = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
      const sameAnchor = (candidate) => {
        const p = candidate && candidate.position;
        return (
          p &&
          p.corner === position.corner &&
          margin(p.marginX) === margin(position.marginX) &&
          margin(p.marginY) === margin(position.marginY)
        );
      };
      if (sameAnchor(layout)) {
        const layoutIndex = CONFIG.petLayouts.findIndex((candidate) => candidate.id === this.pet.id);
        const preceding = CONFIG.petLayouts.slice(0, layoutIndex < 0 ? this.index : layoutIndex).filter(sameAnchor);
        const gap = 24;
        const inward = position.corner.endsWith('-right') ? -1 : 1;
        const offset = preceding.reduce(
          (sum, sibling) => sum + Math.max(0, Number(sibling.size) || this.size) + gap,
          0,
        );
        x += inward * offset;
        const area = PRIMARY_AREA || { x: 0, y: 0, width: VIEW.w, height: VIEW.h };
        const minX = area.x + margin(position.marginX) - this.sideAllow;
        const maxX = area.x + area.width - margin(position.marginX) - this.size + this.sideAllow;
        x = Math.max(minX, Math.min(maxX, x));
      }
    }
    this.sendBounds(x, y);
  }

  /** 抛掷空间（逐屏 AABB）。AREAS/PANELS 变化时由 relayout() 置空重建——飞行中每帧重算太浪费 */
  throwSpaceOf() {
    if (!this.space || this.space.areas !== AREAS || this.space.panels !== PANELS) {
      this.space = S.throwSpace({ areas: AREAS, panels: PANELS, size: this.size, sideAllow: this.sideAllow });
      for (const b of this.space.bounds) b.minY -= this.size * CONFIG.topInsetRatio;
    }
    return this.space;
  }

  /**
   * 显示器几何变化后就地重挂：抛掷空间作废，并把宠物从可能变成空洞的位置拉回可见区。
   * 拖拽中不动它（用户正握着），飞行中也不动（下一帧物理会按新边界夹取）。
   *
   * 角落模式的位置是声明式的：每次都按新主屏工作区、配置角落与边距重算，夹取结果绝不写成位置——
   * 远程桌面接入会先给一块临时大屏再收窄，写下去就把「跟角落」变成「锁在右边缘」。
   * 自定义位置才按视口比例重算，保住世界坐标。
   */
  relayout(prevView) {
    this.space = null;
    this.gapEscapePending = false;
    const from = prevView || VIEW;
    const wasCustom = !!this.customPos;
    const interruptedMove = this.moveRef !== null || !!this.pendingMove || this.posFollow !== null;
    const source = this.throwState || this.pos;
    const next = S.rebaseRect({ x: source.x, y: source.y, width: this.size, height: this.height }, from, VIEW, AREAS);
    const shiftX = next.x - source.x;
    const shiftY = next.y - source.y;
    const viewShiftX = from.x - VIEW.x;
    const viewShiftY = from.y - VIEW.y;
    const unclampedX = source.x + from.x - VIEW.x;
    const unclampedY = source.y + from.y - VIEW.y;
    const clamped = Math.abs(next.x - unclampedX) > 0.5 || Math.abs(next.y - unclampedY) > 0.5;

    this.pos = { x: Math.round(next.x), y: Math.round(next.y) };
    if (this.dragState.active) {
      this.dragState.petX += shiftX;
      this.dragState.petY += shiftY;
      this.dragState.sx += viewShiftX;
      this.dragState.sy += viewShiftY;
      if (Number.isFinite(this.dragState.anchorX)) this.dragState.anchorX += shiftX;
      if (Number.isFinite(this.dragState.anchorY)) this.dragState.anchorY += shiftY;
      for (const point of this.dragTrail) {
        point.x += viewShiftX;
        point.y += viewShiftY;
      }
      if (this.dragTarget) {
        this.dragTarget.x += shiftX;
        this.dragTarget.y += shiftY;
      }
    }
    if (this.throwState) {
      this.throwState.x = next.x;
      this.throwState.y = next.y;
    }

    if (interruptedMove) this.stopMove();
    if (wasCustom || clamped || interruptedMove) {
      this.customPos = { rx: (this.pos.x + this.halfW) / VIEW.w, ry: (this.pos.y + this.halfH) / VIEW.h };
    }

    if (this.dragState.active || this.throwRef !== null) {
      this.sendBounds(this.pos.x, this.pos.y);
      return;
    }
    if (this.customPos) {
      const from = prevView || VIEW;
      const centerOld = { x: this.pos.x + this.halfW, y: this.pos.y + this.halfH };
      const center = S.rebaseCenter(centerOld, from, VIEW, AREAS);
      this.customPos = { rx: center.x / VIEW.w, ry: center.y / VIEW.h };
    }
    this.position();
    if (this.startDisplayGapEscape()) return;
    if (interruptedMove && !this.resumeWorkStatusAnim()) this.playIdle();
  }

  /** 接近屏缝或显示器空隙时，用移动动画回到当前屏内的最近完整位置。 */
  startDisplayGapEscape(rect = { x: this.pos.x, y: this.pos.y, width: this.size, height: this.height }) {
    if (!S.relocateRectFromDisplayGap(PANELS, rect) || this.gapEscapePending) return false;
    const area = S.resolveRect(PANELS, this.pos.x + this.halfW, this.pos.y + this.halfH);
    const actions = this.animations.moves.actions;
    if (!area || !actions.length || area.width < this.size || area.height < this.height) return false;

    let targetX = Math.max(area.x, Math.min(area.x + area.width - this.size, rect.x));
    let targetY = Math.max(area.y, Math.min(area.y + area.height - this.height, rect.y));
    if (this.pet.horizontalOnly === true) {
      if (this.pos.y < area.y || this.pos.y + this.height > area.y + area.height) return false;
      targetY = this.pos.y;
    }
    if (Math.abs(targetX - this.pos.x) < 0.5 && Math.abs(targetY - this.pos.y) < 0.5) {
      const inset = Math.max(1, this.size * 0.2);
      targetX = Math.max(
        area.x,
        Math.min(area.x + area.width - this.size, this.pos.x + Math.sign(area.x + area.width / 2 - this.pos.x) * inset),
      );
      if (this.pet.horizontalOnly !== true && Math.abs(targetX - this.pos.x) < 0.5) {
        targetY = Math.max(
          area.y,
          Math.min(
            area.y + area.height - this.height,
            this.pos.y + Math.sign(area.y + area.height / 2 - this.pos.y) * inset,
          ),
        );
      }
    }
    if (Math.abs(targetX - this.pos.x) < 0.5 && Math.abs(targetY - this.pos.y) < 0.5) return false;

    const chosen = actions[Math.floor(Math.random() * actions.length)];
    const mp = Object.assign({}, this.animations.moves.default, chosen.params || {});
    this.stopMove();
    this.gapEscapePending = true;
    this.pendingMove = {
      startRatio: (this.pos.x + this.halfW) / VIEW.w,
      startYRatio: (this.pos.y + this.halfH) / VIEW.h,
      targetRatio: (targetX + this.halfW) / VIEW.w,
      targetYRatio: (targetY + this.halfH) / VIEW.h,
      dir: targetX >= this.pos.x ? 1 : -1,
      isVertical: Math.abs(targetY - this.pos.y) > Math.abs(targetX - this.pos.x),
      leadSec: mp.leadSec,
      tailSec: mp.tailSec,
      animationName: chosen.name,
      playbackId: null,
      gapEscape: true,
    };
    this.switchTo(chosen.name, true);
    return true;
  }

  currentCenterX() {
    if (this.customPos) return this.customPos.rx * VIEW.w;
    return this.pos.x + this.halfW;
  }
  currentCenterY() {
    if (this.customPos) return this.customPos.ry * VIEW.h;
    return this.pos.y + this.halfH;
  }

  /**
   * 播放回执上报（issue #122 第 3 项）：把这一段点播的**真实**状态告诉 host。
   *
   * 只对第三方点播（带 playbackId）上报；自播动画（随机链 / 点击 / 拖拽 / 碎碎念 / 余额…）不报。
   * 为什么必须有这一层：host 只知道"受理了"，不知道播没播完——动画在这里播，只有这里知道真相。
   * S.postAction 自带 body 序列化且从不抛异常；再加一层 then 只为留一条排障日志。
   */
  reportPlayback(playbackId, status, reason) {
    if (!playbackId) return;
    const body = reason ? { status, reason } : { status };
    void S.postAction(BASE + '/playback/' + encodeURIComponent(playbackId) + '/report', body).then((ok) => {
      if (!ok) console.warn('[dsh-pet] 播放回执未送达 pet=' + this.pet.id + ' id=' + playbackId + ' status=' + status);
    });
  }

  // 可见夹取矩形：以宠物所在那块屏为界，返回窗口局部坐标；可见区太小则返回 null
  visibleClampRect() {
    // pos 是视口相对坐标，窗口屏幕位置 = pos + VIEW 原点 − 外扩余量（见 sendBounds）；
    // 比较双方都用屏幕坐标（坐标系不混），返回的夹取矩形仍是窗口局部坐标。
    // 夹取用**宠物所在的那块屏**而不是外接矩形：外接矩形含空洞，按它夹菜单会伸进
    // 不属于任何显示器的区域（看不见）；菜单本来也不该跨屏显示。
    const area = S.resolveRect(WORK_AREAS, this.pos.x + this.halfW, this.pos.y + this.halfH);
    if (!area) return null;
    const winX = this.pos.x + VIEW.x - this.winOffset.x;
    const winY = this.pos.y + VIEW.y - this.winOffset.y;
    const winW = this.size + this.margin.l + this.margin.r;
    const winH = this.winH + this.margin.t + this.margin.b;
    const ax = area.x + VIEW.x;
    const ay = area.y + VIEW.y;
    const vx0 = Math.max(ax, winX);
    const vy0 = Math.max(ay, winY);
    const vx1 = Math.min(ax + area.width, winX + winW);
    const vy1 = Math.min(ay + area.height, winY + winH);
    const w = vx1 - vx0;
    const h = vy1 - vy0;
    if (w < 40 || h < 40) return null;
    return { x: vx0 - winX, y: vy0 - winY, w, h };
  }
}
