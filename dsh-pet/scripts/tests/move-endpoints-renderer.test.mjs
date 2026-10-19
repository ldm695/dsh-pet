import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { MoveTargets } = require('../../runtime/electron-helper/move-targets.js');
const helper = new URL('../../runtime/electron-helper/', import.meta.url);
const source = readFileSync(new URL('sprite.js', helper), 'utf8');
const shared = readFileSync(new URL('shared-core.js', helper), 'utf8');

function fixture() {
  const frames = [];
  const messages = [];
  const math = Object.create(Math);
  math.random = () => 0.5;
  const context = vm.createContext({
    window: {
      petBridge: {
        beginMove: (...args) => messages.push(['begin', ...args]),
        endMove: (...args) => messages.push(['end', ...args]),
      },
    },
    Math: math,
    console: { info() {}, log() {}, warn() {} },
    performance: { now: () => 0 },
    VIEW: { w: 1000, h: 600 },
    AREAS: [{ x: 0, y: 0, width: 1000, height: 600 }],
    toScreen: (v) => v * 1.5,
    requestAnimationFrame: (cb) => {
      frames.push(cb);
      return frames.length;
    },
    cancelAnimationFrame() {},
  });
  vm.runInContext(shared, context);
  context.S = context.PetShared;
  vm.runInContext(source + '\nthis.Sprite = PetSprite;', context);
  const video = () => ({
    duration: 10,
    currentTime: 0,
    style: {},
    loop: false,
    play: () => Promise.resolve(),
    pause() {},
  });
  const sprite = Object.assign(Object.create(context.Sprite.prototype), {
    pet: { id: 'A', fixedEnabled: false },
    size: 320,
    halfW: 160,
    halfH: 90,
    sideAllow: 60,
    pos: { x: 240, y: 210 },
    customPos: null,
    facing: 'right',
    anim: 'idle',
    moveRef: null,
    moveToken: 0,
    moveDriving: false,
    moveDestination: null,
    pendingMove: null,
    moveTargetId: null,
    needsRelocation: false,
    moveTargets: [],
    throwRef: null,
    posFollow: null,
    posFollowToken: 0,
    workState: null,
    playback: null,
    dragState: { active: false },
    front: 0,
    videoA: video(),
    videoB: video(),
    animations: {
      idle: ['idle'],
      turn: ['turn'],
      clicks: ['click'],
      drag: ['float'],
      categories: [],
      events: {},
      moves: {
        actions: [{ name: 'run' }],
        default: {
          minDist: 200,
          maxDist: 200,
          margin: 10,
          leadSec: 0.5,
          tailSec: 0.5,
        },
      },
    },
    weights: {},
    inputBusy: () => false,
    switchTo() {},
    reportPlayback() {},
    sendBounds(x, y) {
      this.pos = { x: Math.round(x), y: Math.round(y) };
    },
  });
  return { context, sprite, frames, messages };
}

test('manual run reverses at the boundary without switching to floating', () => {
  const { sprite } = fixture();
  sprite.pos.x = 720;
  assert.equal(sprite.tryMove('run', null, { manualMove: true }), 'run');
  assert.equal(sprite.pendingMove.animationName, 'run');
  assert.equal(sprite.pendingMove.isVertical, false);
  assert.equal(sprite.pendingMove.dir, -1);
  assert.ok(sprite.pendingMove.targetRatio < sprite.pendingMove.startRatio);
});

test('manual floating retains its selected vertical animation', () => {
  const { sprite } = fixture();
  assert.equal(sprite.tryMove('float', null, { manualMove: true }), 'float');
  assert.equal(sprite.pendingMove.isVertical, true);
});

test('fullscreen hiding pauses both video buffers and restores the active frame', async () => {
  const { sprite } = fixture();
  const makeVideo = (animation, currentTime = 0) => ({
    dataset: { dshPetAnimation: animation, dshPetOnce: 'false' },
    currentTime,
    paused: false,
    ended: false,
    autoplay: true,
    loop: true,
    style: {},
    pause() {
      this.paused = true;
    },
    play() {
      this.paused = false;
      return Promise.resolve();
    },
  });
  sprite.videoA = makeVideo('idle', 4.25);
  sprite.videoB = makeVideo('old');
  sprite.front = 0;
  sprite.anim = 'idle';
  sprite.once = false;
  sprite.fullscreenHidden = false;
  sprite.fullscreenResume = null;
  sprite.fullscreenDeferredAnimation = null;
  sprite.videoReleaseTimers = new Map();
  sprite.el = { classList: { toggle() {} } };
  sprite.disposed = false;
  sprite.moveDriving = false;
  sprite.moveStep = null;
  sprite.moveRef = null;
  sprite.pendingMove = null;
  sprite.pendingSquash = false;
  sprite.firstVisualFrameResolved = true;

  sprite.setFullscreenHidden(true);
  assert.equal(sprite.videoA.paused, true);
  assert.equal(sprite.videoB.paused, true);
  assert.equal(sprite.videoA.autoplay, false);
  assert.equal(sprite.videoB.autoplay, false);

  sprite.videoA.currentTime = 0;
  sprite.setFullscreenHidden(false);
  await Promise.resolve();
  assert.equal(sprite.videoA.currentTime, 4.25);
  assert.equal(sprite.videoA.paused, false);
  assert.equal(sprite.videoA.autoplay, true);
  assert.equal(sprite.videoB.autoplay, true);
});

test('fullscreen-hidden animation changes defer playback and restore the latest request', () => {
  const { sprite } = fixture();
  sprite.fullscreenHidden = true;
  sprite.fullscreenDeferredAnimation = null;
  sprite.playback = null;
  sprite.anim = 'working';
  sprite.once = true;
  contextSpriteSwitchTo(sprite, 'working', true, 'play-1');
  assert.equal(sprite.fullscreenDeferredAnimation.anim, 'working');
  assert.equal(sprite.fullscreenDeferredAnimation.once, true);
  assert.equal(sprite.fullscreenDeferredAnimation.playbackId, 'play-1');
  assert.equal(sprite.pending, undefined);

  const restored = [];
  sprite.switchTo = (...args) => restored.push(args);
  sprite.videoA = { dataset: { dshPetAnimation: 'idle', dshPetOnce: 'false' } };
  sprite.videoB = {};
  sprite.front = 0;
  sprite.fullscreenResume = { shouldPlay: true };
  sprite.fullscreenHidden = false;
  sprite.moveDriving = false;
  sprite.pendingMove = null;
  sprite.pendingSquash = false;
  sprite.videoReleaseTimers = new Map();
  sprite.resumeFromFullscreen();
  assert.deepEqual(restored, [['working', true, 'play-1']]);
});

function contextSpriteSwitchTo(sprite, ...args) {
  return Object.getPrototypeOf(sprite).switchTo.call(sprite, ...args);
}

test('O forces the next autonomous decision even with zero random movement probability', () => {
  const { context, sprite } = fixture();
  context.S = { ...context.S, rollKind: () => 'idle' };
  sprite.pet.fixedEnabled = true;
  sprite.needsRelocation = true;
  const moves = [];
  sprite.stopMove = () => {};
  sprite.tryMove = (_name, _playback, options) => {
    moves.push(options);
    return 'run';
  };
  sprite.playOnce = () => {};
  sprite.playIdle();
  assert.equal(moves.length, 1);
  assert.equal(moves[0].relocate, true);
  sprite.needsRelocation = false;
  sprite.playIdle();
  assert.equal(moves.length, 1);
});

test('O finishes a normal loop but defers while work is active', () => {
  const { sprite } = fixture();
  const targets = [{ petId: 'A', needsMove: true, x: 600, y: 400, size: 480 }];
  sprite.videoA.loop = true;
  sprite.workState = 'working';
  sprite.updateMoveTargets(targets);
  assert.equal(sprite.videoA.loop, true);
  assert.equal(sprite.canRelocate(), false);
  sprite.workState = null;
  sprite.updateMoveTargets(targets);
  assert.equal(sprite.videoA.loop, false);
  assert.equal(typeof sprite.videoA.onended, 'function');
  assert.equal(sprite.canRelocate(), true);
});

test('forced relocation explores distinct headings, prefers a free endpoint, and retains O when crowded', () => {
  const { sprite } = fixture();
  const candidate = (x) => ({
    startRatio: 0.4,
    startYRatio: 0.5,
    targetRatio: x,
    targetYRatio: 0.5,
    isVertical: false,
  });
  sprite.moveTargets = [{ petId: 'B', x: 750, y: 450, size: 480 }];
  const headings = [];
  sprite.planMoveCandidate = (_mp, _dir, _mode, _origin, sample) => {
    headings.push(sample);
    return candidate(headings.length === 1 ? 0.5 : headings.length === 2 ? 0.9 : 0.5);
  };
  sprite.tryMove(undefined, undefined, { relocate: true });
  assert.equal(sprite.pendingMove.targetRatio, 0.9);
  assert.equal(headings.length, 32);
  assert.equal(
    new Set(headings.map((item) => `${item.mode}:${item.angleDegrees}:${item.dir}:${item.verticalDir}`)).size,
    32,
  );
  assert.equal(new Set(headings.map((item) => item.distanceRatio)).size, 3);
  assert.equal(sprite.pendingMove.relocate, true);
  sprite.pendingMove = null;
  headings.length = 0;
  sprite.planMoveCandidate = () => {
    headings.push({});
    return candidate(0.5);
  };
  sprite.tryMove(undefined, undefined, { relocate: true });
  assert.equal(headings.length, 32);
  assert.equal(sprite.pendingMove.targetRatio, 0.5);
});

test('forced relocation picks the greatest-clearance legal endpoint when every candidate overlaps', () => {
  const { sprite } = fixture();
  const candidate = (x) => ({
    startRatio: 0.4,
    startYRatio: 0.5,
    targetRatio: x,
    targetYRatio: 0.5,
    isVertical: false,
  });
  sprite.moveTargets = [{ petId: 'B', x: 750, y: 450, size: 480 }];
  sprite.planMoveCandidate = (_mp, _dir, _mode, _origin, sample) => {
    if (sample.distanceRatio === 0) return candidate(0.5);
    if (sample.distanceRatio === 0.5) return candidate(0.6);
    return candidate(0.65);
  };

  sprite.tryMove(undefined, undefined, { relocate: true });

  assert.equal(sprite.pendingMove.targetRatio, 0.65);
  assert.equal(sprite.pendingMove.relocate, true);
});

test('relocation distance samples span the selected action minimum, midpoint, and maximum', () => {
  const { context, sprite } = fixture();
  const distances = [];
  context.S.planMove = (options) => {
    distances.push([options.minDist, options.maxDist]);
    return {
      startRatio: 0.4,
      startYRatio: 0.5,
      targetRatio: 0.6,
      targetYRatio: 0.5,
    };
  };

  for (const distanceRatio of [0, 0.5, 1]) {
    sprite.planMoveCandidate({ minDist: 100, maxDist: 300, margin: 0 }, 1, 'horizontal', null, {
      mode: 'horizontal',
      dir: 1,
      angleDegrees: 0,
      verticalDir: 1,
      distanceRatio,
    });
  }

  const scale = sprite.size / context.S.PET_REF_WIDTH;
  assert.deepEqual(
    distances.map(([min, max]) => [min / scale, max / scale]),
    [
      [100, 100],
      [200, 200],
      [300, 300],
    ],
  );
});

test('manual and automatic moves both register their endpoint before any animation frames', async () => {
  for (const manualMove of [true, false]) {
    const { sprite, frames, messages } = fixture();
    sprite.tryMove('run', null, { manualMove });
    const expected = sprite.pendingMove;
    sprite.startMoveDrive(sprite.videoA);
    assert.equal(messages[0][0], 'begin');
    assert.equal(messages[0][4], 'claim');
    assert.equal(messages[0][5], manualMove ? 'manual-movement' : 'automatic-movement');
    assert.ok(Math.abs(messages[0][3].x - expected.targetRatio * 1500) < 1e-8);
    assert.ok(Math.abs(messages[0][3].y - expected.targetYRatio * 900) < 1e-8);
    assert.equal(frames.length, 1);
    sprite.videoA.currentTime = 5;
    frames[0]();
    assert.equal(messages.length, 1, 'intermediate animation frames do not replace the endpoint');
    sprite.stopMove();
    assert.equal(messages[1][0], 'end');
    assert.equal(messages[1][3].x, (sprite.pos.x + sprite.halfW) * 1.5);
    assert.equal(sprite.moveTargetId, null);
    await Promise.resolve();
  }
  const { sprite, messages } = fixture();
  sprite.needsRelocation = true;
  sprite.tryMove(undefined, null, { relocate: true });
  sprite.startMoveDrive(sprite.videoA);
  assert.equal(messages[0][4], 'yield');
  assert.equal(messages[0][5], 'overlap-yield');
});

test('smooth position commands register a new claim with a diagnostic reason', () => {
  const { context, sprite, messages } = fixture();
  context.S.clampPointToRegion = (_areas, x, y) => ({ x, y });

  sprite.moveToCenter(0.5, 0.5, true);

  assert.equal(messages[0][0], 'begin');
  assert.equal(messages[0][4], 'claim');
  assert.equal(messages[0][5], 'position-command');
});

test('completed moves commit the exact endpoint even if ended beats the last rAF', () => {
  const { sprite, messages } = fixture();
  sprite.moveDriving = true;
  sprite.moveTargetId = 'test';
  sprite.moveDestination = { rx: 0.8, ry: 0.6 };
  sprite.needsRelocation = true;
  sprite.playIdle = () => {};
  sprite.handleEnded();
  assert.equal(sprite.pos.x, 640);
  assert.equal(sprite.pos.y, 270);
  assert.equal(messages[0][0], 'end');
  assert.equal(messages[0][3].x, 1200);
  assert.equal(messages[0][4], 'completed');
  assert.equal(sprite.moveDriving, false);
});

test('renderer begin/end messages and registry preserve newest ownership across interruption', () => {
  const { context, sprite, messages } = fixture();
  const registry = new MoveTargets();
  context.window.petBridge.beginMove = (petId, id, target, kind) => registry.begin(petId, id, target, kind);
  context.window.petBridge.endMove = (petId, id, actual) => registry.end(petId, id, actual);
  sprite.beginMoveTarget(700, 300);
  registry.begin('B', 'b', { x: 1050, y: 450, size: 480 });
  sprite.updateMoveTargets(registry.snapshot());
  assert.equal(sprite.needsRelocation, true);
  sprite.finishMoveTarget('interrupted');
  assert.equal(registry.snapshot().find((target) => target.petId === 'A').x, 600);
  sprite.updateMoveTargets(registry.snapshot());
  assert.equal(sprite.needsRelocation, false);
  assert.equal(messages.length, 0);
});

test('playback rejection releases its endpoint at the actual position', async () => {
  const { sprite, messages } = fixture();
  sprite.playIdle = () => {};
  sprite.videoA.play = () => Promise.reject(new Error('decode failed'));
  sprite.tryMove('run', null, { manualMove: true });
  sprite.startMoveDrive(sprite.videoA);
  await new Promise(setImmediate);
  assert.deepEqual(
    messages.map((message) => message[0]),
    ['begin', 'end'],
  );
  assert.equal(messages[1][3].x, 600);
  assert.equal(sprite.moveDriving, false);
  assert.equal(sprite.moveTargetId, null);
});

test('preload carries endpoint messages, snapshots, and unknown drag/throw destinations', () => {
  let bridge;
  const sends = [];
  const subscriptions = new Map();
  vm.runInNewContext(readFileSync(new URL('preload.js', helper), 'utf8'), {
    require: () => ({
      contextBridge: {
        exposeInMainWorld(_name, value) {
          bridge = value;
        },
      },
      ipcRenderer: {
        send: (...args) => sends.push(args),
        on: (channel, callback) => subscriptions.set(channel, callback),
      },
    }),
  });
  bridge.setBounds('A', 0, 0, 600, 400, 100, 200, 480, 20, 0, 0, 100, 100, 0, 0, 100, 100, true, true);
  assert.equal(sends[0][1].freeMotion, true);
  assert.equal(sends[0][1].positionClaim, true);
  assert.equal(sends[0][1].size, 480);
  bridge.beginMove('A', '1', { x: 600, y: 400, size: 480 }, 'yield', 'overlap-yield');
  assert.equal(sends[1][1].kind, 'yield');
  assert.equal(sends[1][1].reason, 'overlap-yield');
  bridge.endMove('A', '1', { x: 300, y: 400, size: 480 }, 'interrupted');
  bridge.forgetMoveTarget('A');
  assert.deepEqual(
    sends.slice(1).map((message) => message[0]),
    ['pet:begin-move', 'pet:end-move', 'pet:forget-move-target'],
  );
  let received;
  bridge.onMoveTargets((snapshot) => {
    received = snapshot;
  });
  const targets = [{ petId: 'A', needsMove: true }];
  subscriptions.get('pet:move-targets')(null, targets);
  assert.equal(received, targets);
});
