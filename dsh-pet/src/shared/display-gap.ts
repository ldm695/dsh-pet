/**
 * 屏幕接缝避让规划：仅判断物理碰撞框是否完整落在一块可用屏幕内，并计算最近的屏内目标。
 * 不依赖 Electron 或桌面窗口状态，供渲染端和桌面 Helper 共用。
 * @module dsh-pet/src/shared/display-gap
 */
import type { Rect } from './types.ts';

export interface CollisionRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** 身体完整落在任一屏幕区域内时返回 true；接缝或屏幕间隙都会返回 false。 */
export function isCollisionRectOnSingleDisplay(box: CollisionRect, areas: readonly Rect[]): boolean {
  return areas.some(
    (area) =>
      box.left >= area.x && box.top >= area.y && box.right <= area.x + area.width && box.bottom <= area.y + area.height,
  );
}

/**
 * 为处于接缝/间隙的身体碰撞框选择最近的完整屏内位置。
 * 无法容纳整只身体的屏幕不作为候选；已位于一块屏内时返回 null。
 */
export function nearestDisplayInteriorTarget(
  box: CollisionRect,
  areas: readonly Rect[],
  options: { horizontalOnly?: boolean } = {},
): { x: number; y: number } | null {
  if (isCollisionRectOnSingleDisplay(box, areas)) return null;
  const width = box.right - box.left;
  const height = box.bottom - box.top;
  let best: { x: number; y: number; distance: number } | null = null;
  for (const area of areas) {
    if (width > area.width || height > area.height) continue;
    if (options.horizontalOnly && (box.top < area.y || box.bottom > area.y + area.height)) continue;
    const x = Math.min(Math.max(box.left, area.x), area.x + area.width - width);
    const y = options.horizontalOnly ? box.top : Math.min(Math.max(box.top, area.y), area.y + area.height - height);
    const distance = Math.hypot(x - box.left, y - box.top);
    if (best === null || distance < best.distance) best = { x, y, distance };
  }
  return best ? { x: best.x, y: best.y } : null;
}
