import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isCollisionRectOnSingleDisplay, nearestDisplayInteriorTarget } from './display-gap.ts';
import type { Rect } from './types.ts';

const left: Rect = { x: 0, y: 0, width: 1000, height: 800 };
const right: Rect = { x: 1000, y: 100, width: 1000, height: 700 };

describe('display-gap —— 屏缝避让规划', () => {
  it('accepts a collision box fully within one display', () => {
    assert.equal(isCollisionRectOnSingleDisplay({ left: 900, top: 300, right: 980, bottom: 500 }, [left, right]), true);
    assert.equal(nearestDisplayInteriorTarget({ left: 900, top: 300, right: 980, bottom: 500 }, [left, right]), null);
  });

  it('moves a seam-straddling collision box to the closest display interior', () => {
    const box = { left: 960, top: 250, right: 1040, bottom: 450 };
    assert.equal(isCollisionRectOnSingleDisplay(box, [left, right]), false);
    assert.deepEqual(nearestDisplayInteriorTarget(box, [left, right]), { x: 920, y: 250 });
  });

  it('does not choose a display that cannot fit the full collision box', () => {
    assert.equal(
      nearestDisplayInteriorTarget({ left: 400, top: 300, right: 700, bottom: 600 }, [
        { x: 0, y: 0, width: 250, height: 800 },
      ]),
      null,
    );
  });
});
