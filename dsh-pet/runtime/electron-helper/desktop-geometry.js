/** Pet motion uses platform-specific screen bounds; menus must stay inside the work area. */
'use strict';

const { HIT_BOX, STAGE_W, CANVAS_H, FEET_Y } = require('./pointer-target.js');

function buildDeskGeometry(displays, primaryId, platform) {
  const workAreas = displays.map((d) => ({ ...d.workArea }));
  const panels = displays.map((d) => ({ ...d.bounds }));
  const areas = displays.map((d, i) => {
    if (platform === 'win32') {
      // The shared transparent window and pet physics must use the complete physical panel.
      // Using workArea here offsets/shrinks the overlay when the taskbar is docked at the top
      // or bottom. Menus and other UI still use workAreas, which are passed separately.
      return { ...panels[i] };
    }
    if (platform !== 'darwin') return { ...workAreas[i] };
    // Keep the Dock exclusion at the bottom/sides, but let the visible head reach the panel top.
    return { ...workAreas[i], y: panels[i].y, height: workAreas[i].y + workAreas[i].height - panels[i].y };
  });
  const x = Math.min(...areas.map((a) => a.x));
  const y = Math.min(...areas.map((a) => a.y));
  return {
    hull: {
      x,
      y,
      width: Math.max(...areas.map((a) => a.x + a.width)) - x,
      height: Math.max(...areas.map((a) => a.y + a.height)) - y,
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
