/**
 * 共享 overlay 交互源码守卫与舞台几何常量同步检查。
 * 旧的逐窗口 pointer-target 判定算法已退出运行时路径。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const helper = '../../runtime/electron-helper/';
const { HIT_BOX, CANVAS_H, STAGE_W, FEET_Y } = require(helper + 'pet-geometry.js');

/** 包内文件源码（守卫用；相对 src/host/ 解析） */
const readSource = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('共享 overlay 交互源码守卫', () => {
  const main = readSource(helper + 'main.js');

  test('ready-to-show 未触发时，加载完成后仍会显示窗口', () => {
    assert.ok(/once\('ready-to-show', \(\) => win\.showInactive\(\)\)/.test(main));
    assert.ok(/once\('did-finish-load'/.test(main));
    assert.ok(/!win\.isDestroyed\(\) && !win\.isVisible\(\)\) win\.showInactive\(\)/.test(main));
  });

  test('共享 overlay 轮询使用真实光标和共享交互矩形', () => {
    assert.ok(!/pointer-target\.js/.test(main), 'main.js 不应再使用已退役的逐窗口算法');
    assert.ok(/screen\.getCursorScreenPoint\(\)/.test(main));
    assert.ok(/POINTER_POLL_MS/.test(main));
    assert.ok(/overlayPointIsInteractive\(win, point\)/.test(main));
    const poll = /setInterval\(\(\) => \{([\s\S]*?)\}, POINTER_POLL_MS\);/.exec(main);
    assert.ok(poll, '共享 overlay 指针轮询必须存在');
    assert.ok(/overlayInputs\].some\(\(\[petId, entry\]\) => !fullscreenHiddenPets\.has\(petId\) && entry\.dragging\)/.test(poll[1]));
    assert.ok(/!overlayPointIsInteractive\(win, point\)/.test(poll[1]));
    assert.ok((main.match(/setWindowIgnore\(/g) ?? []).length >= 3);
    assert.ok(!/win\.setIgnoreMouseEvents\(/.test(main.replace(/function setWindowIgnore[\s\S]*?\n}/, '')));
    assert.ok(/clearInterval\(pointerTimer\)/.test(main));
  });

  test('逐宠物 busy 状态存储在共享 overlay 输入表中', () => {
    assert.ok(/const overlayInputs = new Map\(\)/.test(main));
    assert.ok(/ipcMain\.on\('pet:input-busy'/.test(main));
    assert.ok(/overlayInputs\.set\(petId, \{ \.\.\.prior, busy: payload\.busy === true \}\)/.test(main));
    assert.ok(!/\b(?:winMargins|offBodyMs|inputRegions|inputBusy)\b/.test(main));
    assert.ok(!/ipcMain\.on\('pet:input-busy'[\s\S]{0,400}?setWindowIgnore\(/.test(main));
  });
});

describe('舞台几何常量与共享物理保持同步', () => {
  test('HIT_BOX 和舞台尺寸与 shared 常量及渲染端一致', () => {
    const shared = readSource('../shared/constants.ts');
    const num = (name: string): number => {
      const match = new RegExp(String.raw`export const ${name} = (\d+)`).exec(shared);
      assert.ok(match, 'shared 常量中缺少 ' + name);
      return Number(match[1]);
    };
    assert.equal(CANVAS_H, num('CANVAS_H'));
    assert.equal(FEET_Y, num('FEET_Y'));
    const hit = /export const HIT_BOX = \{ x0: (\d+), y0: (\d+), x1: (\d+), y1: (\d+) \}/.exec(shared);
    assert.ok(hit, 'shared HIT_BOX 的结构发生变化');
    assert.deepEqual(HIT_BOX, { x0: Number(hit[1]), y0: Number(hit[2]), x1: Number(hit[3]), y1: Number(hit[4]) });
    assert.equal(STAGE_W, 640);
    assert.ok(/S\.HIT_BOX\.x0 \/ 640/.test(readSource(helper + 'sprite.js')));
  });
});

describe('渲染端 input-busy 仍接入共享 overlay', () => {
  const sprite = readSource(helper + 'sprite.js');

  test('busy 覆盖拖拽、菜单和对话状态', () => {
    const match = /inputBusy\(\)\s*\{([\s\S]*?)\n {2}\}/.exec(sprite);
    assert.ok(match, 'sprite.js 必须定义 inputBusy()');
    for (const flag of ['dragState.active', 'menuOpen', 'chatOpen']) assert.ok(match[1].includes(flag));
  });

  test('拖拽以及 UI 的打开和关闭都会上报 input-busy', () => {
    assert.ok(/setPointerCapture[\s\S]{0,600}?this\.syncInputBusy\(\)/.test(sprite));
    assert.ok(/d\.dragging = true;[\s\S]{0,400}?this\.syncInputBusy\(\)/.test(sprite));
    assert.ok(/this\.menuOpen = true;[\s\S]{0,300}?this\.syncInputBusy\(\)/.test(sprite));
    assert.ok(/this\.chatOpen = true;[\s\S]{0,300}?this\.syncInputBusy\(\)/.test(sprite));
    assert.ok(/onPointerUp\(e\) \{[\s\S]{0,400}?this\.syncInputBusy\(\)/.test(sprite));
    assert.ok(/closeMenu\(\) \{[\s\S]{0,400}?this\.syncInputBusy\(\)/.test(sprite));
    assert.ok(/onClose: \(\) => \{\s*this\.menuOpen = false;[\s\S]{0,200}?this\.syncInputBusy\(\)/.test(sprite));
    assert.ok(/this\.chatOpen = false;[\s\S]{0,300}?this\.syncInputBusy\(\)/.test(sprite));
  });

  test('busy 上报会去重，并由 preload 暴露', () => {
    assert.ok(/if \(busy === this\._inputBusy\) return;/.test(sprite));
    assert.ok(/window\.petBridge\.setInputBusy\(busy\)/.test(sprite));
    const preload = readSource(helper + 'preload.js');
    assert.ok(/setInputBusy\(busy\)/.test(preload));
    assert.ok(/'pet:input-busy'/.test(preload));
  });
});
