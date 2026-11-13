/** Simulate display topology changes against the desktop sprite's actual relayout method. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';

import { rebaseRect, relocateRectFromDisplayGap, resolveRect } from '../shared/displays.ts';
import type { Rect } from '../shared/types.ts';

type Viewport = { x: number; y: number; w: number; h: number };
type SpriteClass = { prototype: object };
type SpriteHarness = {
  relayout(prevView?: Viewport): void;
  startMoveDrive(video: MoveVideo): void;
  pos: { x: number; y: number };
  size: number;
  height: number;
  halfW: number;
  halfH: number;
  customPos: { rx: number; ry: number } | null;
  space: object | null;
  dragState: {
    active: boolean;
    petX: number;
    petY: number;
    sx: number;
    anchorX: number;
    anchorY: number;
  };
  dragTarget: { x: number; y: number } | null;
  dragTrail: Array<{ t: number; x: number; y: number }>;
  throwState: { x: number; y: number; vx: number; vy: number } | null;
  throwRef: number | null;
  moveDriving: boolean;
  pendingMove: object | null;
  posFollow: number | null;
  moveToken: number;
  moveRef: number | null;
  moveStep: (() => void) | null;
  moveDestination: { rx: number; ry: number } | null;
  moveTargetId: string | null;
  gapEscapePending: boolean;
  idleRestarted?: boolean;
  front: number;
  anim: string;
  once: boolean;
  facing: string;
  animations: { drag: string[]; moves: { actions: Array<{ name: string; params?: object }>; default: object } };
  pet: { id: string; horizontalOnly?: boolean };
  beginMoveTarget(x: number, y: number, kind: string, reason: string): void;
  finishMoveTarget(reason: string): void;
  stopMove(): void;
  sendBounds(x: number, y: number): void;
  position(): void;
  startDisplayGapEscape(): boolean;
  switchTo(name: string, once?: boolean, playbackId?: string | null): void;
  resumeWorkStatusAnim(): boolean;
  playIdle(): void;
};
type MoveVideo = {
  duration: number;
  currentTime: number;
  loop: boolean;
  onended: (() => void) | null;
  onerror: (() => void) | null;
  style: { transform: string };
  play(): Promise<void>;
};

const readSpriteSource = (): string =>
  readFileSync(fileURLToPath(new URL('../../runtime/electron-helper/sprite.js', import.meta.url)), 'utf8');

const createHarness = (view: Viewport, areas: Rect[], panels: Rect[]) => {
  const sandbox: Record<string, unknown> = {
    navigator: { platform: 'Win32', userAgent: '' },
    BASE: 'http://127.0.0.1',
    S: { rebaseRect, relocateRectFromDisplayGap, resolveRect },
    VIEW: view,
    AREAS: areas,
    PANELS: panels,
    window: {},
  };
  runInNewContext(readSpriteSource() + '\n;globalThis.__PetSpriteForTest = PetSprite;', sandbox);
  const PetSprite = sandbox.__PetSpriteForTest as SpriteClass;
  return { sandbox, PetSprite };
};

const createSprite = (PetSprite: SpriteClass, overrides: Partial<SpriteHarness> = {}): SpriteHarness =>
  Object.assign(
    Object.create(PetSprite.prototype) as SpriteHarness,
    {
      pos: { x: 2620, y: 300 },
      size: 240,
      height: 135,
      halfW: 120,
      halfH: 67.5,
      customPos: { rx: 0.75, ry: 0.5 },
      space: {},
      dragState: { active: false, petX: 2620, petY: 300, sx: 850, anchorX: 2740, anchorY: 367.5 },
      dragTarget: null,
      dragTrail: [],
      throwState: null,
      throwRef: null,
      moveDriving: false,
      pendingMove: null,
      gapEscapePending: false,
      posFollow: null,
      stopMove() {},
      sendBounds(x: number, y: number) {
        this.pos = { x: Math.round(x), y: Math.round(y) };
      },
      position() {},
      startDisplayGapEscape() {
        return false;
      },
      switchTo() {},
      resumeWorkStatusAnim() {
        return false;
      },
      playIdle() {},
    },
    overrides,
  );

const oldView = { x: -1920, y: 0, w: 3840, h: 1080 };
const newView = { x: 0, y: 0, w: 1920, h: 1080 };
const newAreas = [{ x: 0, y: 0, width: 1920, height: 1080 }];

test('拓扑变化时正在拖拽：宠物位置、拖拽起点和鼠标增量一起重基准', () => {
  const { sandbox, PetSprite } = createHarness(newView, newAreas, newAreas);
  const sprite = createSprite(PetSprite, {
    dragState: { active: true, petX: 2620, petY: 300, sx: 850, anchorX: 2740, anchorY: 367.5 },
    dragTarget: { x: 2630, y: 310 },
    dragTrail: [{ t: 10, x: 850, y: 367.5 }],
  });

  sprite.relayout(oldView);

  assert.deepEqual(sprite.pos, { x: 700, y: 300 });
  assert.equal(sprite.dragState.petX, 700);
  assert.equal(sprite.dragState.anchorX, 820);
  assert.deepEqual(sprite.dragTarget, { x: 710, y: 310 });
  assert.equal(sprite.dragState.sx, -1070, '鼠标起点也要随虚拟桌面原点一起重基准');
  assert.equal(sprite.dragTrail[0].x, -1070, '拖拽轨迹要平移，避免松手速度计算出现坐标跳变');
  assert.equal(sprite.dragState.petX + (-1052 - sprite.dragState.sx), 718);
  assert.equal((sandbox as { VIEW: Viewport }).VIEW.x, 0);
});

test('拓扑变化时正在抛掷：飞行状态坐标与原生宠物窗口同步重基准', () => {
  const { PetSprite } = createHarness(newView, newAreas, newAreas);
  const sprite = createSprite(PetSprite, {
    throwState: { x: 2620, y: 300, vx: 200, vy: -80 },
    throwRef: 1,
  });

  sprite.relayout(oldView);

  assert.equal(sprite.throwState?.x, 700);
  assert.equal(sprite.throwState?.y, 300);
  assert.deepEqual(sprite.pos, { x: 700, y: 300 });
});

test('拓扑变化中断自主移动后会重新启动动画链', () => {
  const { PetSprite } = createHarness(newView, newAreas, newAreas);
  let stopped = false;
  let restarted = false;
  const sprite = createSprite(PetSprite, {
    moveDriving: true,
    stopMove() {
      stopped = true;
      this.moveDriving = false;
    },
    playIdle() {
      restarted = true;
    },
  });

  sprite.relayout(oldView);

  assert.equal(stopped, true);
  assert.equal(restarted, true, '停止位置插值后不能把当前视频留在暂停帧');
});

test('自主移动即将跨过屏幕接缝时，改播移动动画退回当前屏内', () => {
  const displays = [
    { x: 0, y: 0, width: 1000, height: 700 },
    { x: 1000, y: 0, width: 1000, height: 700 },
  ];
  const { sandbox, PetSprite } = createHarness({ x: 0, y: 0, w: 2000, h: 700 }, displays, displays);
  const frameRecorder: { callback: (() => void) | null } = { callback: null };
  sandbox.requestAnimationFrame = (callback: FrameRequestCallback) => {
    frameRecorder.callback = callback as () => void;
    return 1;
  };
  const sentBounds: Array<{ x: number; y: number }> = [];
  const sprite = createSprite(PetSprite, {
    pos: { x: 680, y: 250 },
    size: 240,
    height: 135,
    halfW: 120,
    halfH: 67.5,
    pendingMove: {
      startRatio: 0.4,
      startYRatio: 317.5 / 700,
      targetRatio: 0.6,
      targetYRatio: 317.5 / 700,
      isVertical: false,
      dir: 1,
      leadSec: 0,
      tailSec: 0,
      animationName: 'walk',
    },
    moveToken: 0,
    moveRef: null,
    moveStep: null,
    moveDestination: null,
    moveTargetId: null,
    front: 0,
    anim: 'walk',
    once: true,
    facing: 'right',
    animations: { drag: [], moves: { actions: [{ name: 'walk', params: {} }], default: { leadSec: 0, tailSec: 0 } } },
    pet: { id: 'main', horizontalOnly: true },
    startDisplayGapEscape(rect?: Rect) {
      return (PetSprite.prototype as { startDisplayGapEscape(box?: Rect): boolean }).startDisplayGapEscape.call(
        this,
        rect,
      );
    },
    beginMoveTarget() {
      this.moveTargetId = 'move-1';
    },
    finishMoveTarget() {
      this.moveTargetId = null;
    },
    sendBounds(x, y) {
      sentBounds.push({ x, y });
      this.pos = { x: Math.round(x), y: Math.round(y) };
    },
    stopMove() {
      this.moveDriving = false;
    },
    playIdle() {
      this.idleRestarted = true;
    },
    switchTo(name: string) {
      this.anim = name;
    },
  });
  const video: MoveVideo = {
    duration: 10,
    currentTime: 5,
    loop: true,
    onended: null,
    onerror: null,
    style: { transform: '' },
    play: () => Promise.resolve(),
  };

  sprite.startMoveDrive(video);
  video.currentTime = 5;
  frameRecorder.callback?.();

  assert.deepEqual(sentBounds, [], '不能先把宠物瞬移或渲染到跨屏位置');
  assert.equal(sprite.pos.x, 680, '启动避让动画时仍留在原位置');
  assert.equal((sprite.pendingMove as { targetRatio: number }).targetRatio, 0.44);
  assert.equal((sprite.pendingMove as { targetYRatio: number }).targetYRatio, 317.5 / 700);
  assert.equal(sprite.gapEscapePending, true);
  assert.equal(sprite.anim, 'walk');
  assert.equal(sprite.moveDriving, false);
});
