import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildDeskGeometry } = require('../../runtime/electron-helper/desktop-geometry.js');
const { HIT_BOX, CANVAS_H, STAGE_W, FEET_Y } = require('../../runtime/electron-helper/pet-geometry.js');

const primary = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 24, width: 1920, height: 1000 },
};

test('macOS: movement reaches panel top while menus and Dock exclusions keep the work area', () => {
  const geo = buildDeskGeometry([primary], 1, 'darwin');
  assert.deepEqual(geo.areas, [{ x: 0, y: 0, width: 1920, height: 1024 }]);
  assert.deepEqual(geo.workAreas, [primary.workArea]);
  assert.deepEqual(geo.panels, [primary.bounds]);
  assert.equal(geo.topInsetRatio, 80 / 640); // video head padding + stage bottomPad
  assert.equal(primary.workArea.y, 24, 'do not mutate Electron display objects');
});

test('Windows pet windows and movement use the display work area', () => {
  const geo = buildDeskGeometry([primary], 1, 'win32');
  assert.deepEqual(geo.areas, [primary.workArea]);
  assert.deepEqual(geo.hull, primary.workArea);
  assert.deepEqual(geo.workAreas, [primary.workArea]);
  assert.equal(geo.topInsetRatio, 0);
});

test('Linux keeps its work-area movement boundary', () => {
  const geo = buildDeskGeometry([primary], 1, 'linux');
  assert.deepEqual(geo.areas, [primary.workArea]);
  assert.deepEqual(geo.hull, primary.workArea);
  assert.equal(geo.topInsetRatio, 0);
});

test('irregular multi-screen layouts retain per-screen boundaries, negative origins and primary index', () => {
  const second = {
    id: 2,
    bounds: { x: -1280, y: -900, width: 1280, height: 900 },
    workArea: { x: -1230, y: -876, width: 1230, height: 876 },
  };
  const geo = buildDeskGeometry([second, primary], 1, 'darwin');
  assert.equal(geo.primaryIndex, 1);
  assert.deepEqual(geo.hull, { x: -1230, y: -900, width: 3150, height: 1924 });
  assert.deepEqual(geo.areas[0], { x: -1230, y: -900, width: 1230, height: 900 });
  assert.equal(geo.areas.length, 2, 'never fill the gaps between physical screens');
});

test('physical top alignment accounts for the pet body inset without window-margin hit testing', () => {
  const geo = buildDeskGeometry([primary], 1, 'darwin');
  const size = 150;
  const bodyTopOffset = (size * (HIT_BOX.y0 + CANVAS_H - FEET_Y)) / STAGE_W;
  const petRootY = geo.areas[0].y - size * geo.topInsetRatio;
  assert.equal(geo.topInsetRatio, (HIT_BOX.y0 + CANVAS_H - FEET_Y) / STAGE_W);
  assert.equal(petRootY + bodyTopOffset, geo.areas[0].y);
});
