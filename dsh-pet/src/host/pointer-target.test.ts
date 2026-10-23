/** Desktop helper stage geometry stays synchronized with shared animation constants. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const helper = '../../runtime/electron-helper/';
const { HIT_BOX, CANVAS_H, STAGE_W, FEET_Y } = require(helper + 'pet-geometry.js');
const readSource = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

test('HIT_BOX and stage dimensions match shared constants and renderer usage', () => {
  const shared = readSource('../shared/constants.ts');
  const num = (name: string): number => {
    const match = new RegExp(String.raw`export const ${name} = (\d+)`).exec(shared);
    assert.ok(match, 'shared constants missing ' + name);
    return Number(match[1]);
  };
  assert.equal(CANVAS_H, num('CANVAS_H'));
  assert.equal(FEET_Y, num('FEET_Y'));
  const hit = /export const HIT_BOX = \{ x0: (\d+), y0: (\d+), x1: (\d+), y1: (\d+) \}/.exec(shared);
  assert.ok(hit, 'shared HIT_BOX structure changed');
  assert.deepEqual(HIT_BOX, { x0: Number(hit[1]), y0: Number(hit[2]), x1: Number(hit[3]), y1: Number(hit[4]) });
  assert.equal(STAGE_W, 640);
  assert.ok(/S\.HIT_BOX\.x0 \/ 640/.test(readSource(helper + 'sprite.js')));
});
