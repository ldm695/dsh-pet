/**
 * Desktop pet stage geometry shared by the renderer and host movement code.
 * Values mirror src/shared/constants.ts; each pet runs in its own transparent window.
 */
'use strict';

/** Pet body hit box in 640×360 stage coordinates. */
const HIT_BOX = Object.freeze({ x0: 200, y0: 50, x1: 440, y1: 335 });
const CANVAS_H = 360;
const STAGE_W = 640;
const FEET_Y = 330;

module.exports = { HIT_BOX, CANVAS_H, STAGE_W, FEET_Y };
