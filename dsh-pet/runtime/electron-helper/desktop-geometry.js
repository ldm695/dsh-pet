/** Keep the overlay hull separate from the pet's per-display movement areas. */
'use strict';

const { HIT_BOX, STAGE_W, CANVAS_H, FEET_Y } = require('./pointer-target.js');

function buildDeskGeometry(displays, primaryId, platform) {
  const workAreas = displays.map((d) => ({ ...d.workArea }));
  const panels = displays.map((d) => ({ ...d.bounds }));
  const areas = displays.map((d, i) => {
    if (platform === 'win32') {
      // The overlay still spans complete panels (see hull below), while pet movement and
      // resting positions stay inside the usable work area above/beside the taskbar.
      return { ...workAreas[i] };
    }
    if (platform !== 'darwin') return { ...workAreas[i] };
    // Keep the Dock exclusion at the bottom/sides, but let the visible head reach the panel top.
    return { ...workAreas[i], y: panels[i].y, height: workAreas[i].y + workAreas[i].height - panels[i].y };
  });
  const hullAreas = platform === 'win32' ? panels : areas;
  const x = Math.min(...hullAreas.map((a) => a.x));
  const y = Math.min(...hullAreas.map((a) => a.y));
  return {
    hull: {
      x,
      y,
      width: Math.max(...hullAreas.map((a) => a.x + a.width)) - x,
      height: Math.max(...hullAreas.map((a) => a.y + a.height)) - y,
    },
    areas,
    workAreas,
    panels,
    primaryIndex: Math.max(
      0,
      displays.findIndex((d) => d.id === primaryId),
    ),
    topInsetRatio: platform === 'darwin' ? (HIT_BOX.y0 + CANVAS_H - FEET_Y) / STAGE_W : 0,
  };
}

module.exports = { buildDeskGeometry };
