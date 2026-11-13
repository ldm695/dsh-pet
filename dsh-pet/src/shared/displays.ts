/**
 * 多显示器几何：把「桌面」建模为工作区矩形的并集，而不是它们的外接矩形。
 * 摆放不规则时会留下大片不属于任何屏的空洞（实测右倒 T 型双屏近四分之一面积），
 * 以外接矩形为边界会把宠物放进用户看不见的地方。
 * 坐标系由调用方决定，本文件不假定原点在 0；浏览器半侧 overlay 只有一块屏，退化为单矩形。
 * @module dsh-pet/src/shared/displays
 */
import type { Rect } from './types.ts';

/** 矩形右缘（不含） */
export const rectRight = (r: Rect): number => r.x + r.width;
/** 矩形下缘（不含） */
export const rectBottom = (r: Rect): number => r.y + r.height;

/** 外接矩形：视口 VIEW 仍取它（作为坐标系原点与比例换算基准），但**边界判定一律走并集**。
 *  空列表返回 0×0（调用方兜底）。 */
export const boundingRect = (rects: Rect[]): Rect => {
  if (rects.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, rectRight(r));
    y1 = Math.max(y1, rectBottom(r));
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
};

/** 点是否落在矩形内（右/下缘不含，与 workArea 拼接语义一致：相邻两屏缝隙为 0 时点归左/上那块） */
export const pointInRect = (r: Rect, x: number, y: number): boolean =>
  x >= r.x && x < rectRight(r) && y >= r.y && y < rectBottom(r);

/** 点被哪块屏覆盖；无则 null。重叠时取列表中第一块（与 Chromium「先发现者优先」一致） */
export const rectAtPoint = (rects: Rect[], x: number, y: number): Rect | null => {
  for (const r of rects) if (pointInRect(r, x, y)) return r;
  return null;
};

/** 同上，返回下标（−1 = 无覆盖）：抛掷需要用下标记住「当前所在屏」 */
export const indexAtPoint = (rects: Rect[], x: number, y: number): number => {
  for (let i = 0; i < rects.length; i++) if (pointInRect(rects[i], x, y)) return i;
  return -1;
};

/** 点到矩形的最短距离平方（点在矩形内为 0） */
export const distToRectSq = (r: Rect, x: number, y: number): number => {
  const dx = Math.max(r.x - x, 0, x - rectRight(r));
  const dy = Math.max(r.y - y, 0, y - rectBottom(r));
  return dx * dx + dy * dy;
};

/** 离点最近的屏下标（并集非空时恒有解；空列表返回 −1）。用于宠物落在空洞/屏幕被拔掉后归位 */
export const nearestIndex = (rects: Rect[], x: number, y: number): number => {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < rects.length; i++) {
    const d = distToRectSq(rects[i], x, y);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
};

/** 点所在屏；不在任何屏上时取最近的那块（恒非 null，除非列表为空） */
export const resolveRect = (rects: Rect[], x: number, y: number): Rect | null => {
  const hit = rectAtPoint(rects, x, y);
  if (hit) return hit;
  const i = nearestIndex(rects, x, y);
  return i < 0 ? null : rects[i];
};

/** 把点夹进指定矩形（右/下缘留 1px，保证夹取结果仍满足 pointInRect） */
export const clampPointInRect = (r: Rect, x: number, y: number): { x: number; y: number } => ({
  x: Math.min(Math.max(x, r.x), rectRight(r) - 1),
  y: Math.min(Math.max(y, r.y), rectBottom(r) - 1),
});

/** 把点夹进并集：已在并集内原样返回，否则夹进最近的那块屏。
 *  用于显示器拔插/改分辨率后把落在空洞里的宠物拉回可见区。 */
export const clampPointToRegion = (rects: Rect[], x: number, y: number): { x: number; y: number } => {
  if (rectAtPoint(rects, x, y)) return { x, y };
  const i = nearestIndex(rects, x, y);
  return i < 0 ? { x, y } : clampPointInRect(rects[i], x, y);
};

/** 并集面积（各屏不重叠时 = 面积和；重叠会重复计，仅作诊断用） */
/** Preserve a pet's world position when display topology moves the virtual viewport. */
export const rebaseCenter = (
  center: { x: number; y: number },
  fromView: { x: number; y: number },
  toView: { x: number; y: number },
  areas: Rect[],
): { x: number; y: number } =>
  clampPointToRegion(areas, center.x + fromView.x - toView.x, center.y + fromView.y - toView.y);

/** Rebase a pet box when the virtual desktop origin changes; coordinates remain view-local. */
export const rebaseRect = (
  rect: Rect,
  fromView: { x: number; y: number },
  toView: { x: number; y: number },
  areas: Rect[],
): Rect => {
  const center = rebaseCenter({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }, fromView, toView, areas);
  return { ...rect, x: center.x - rect.width / 2, y: center.y - rect.height / 2 };
};

const rectContainsRect = (outer: Rect, inner: Rect): boolean =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  rectRight(inner) <= rectRight(outer) &&
  rectBottom(inner) <= rectBottom(outer);

const rectsIntersect = (a: Rect, b: Rect): boolean =>
  a.x < rectRight(b) && rectRight(a) > b.x && a.y < rectBottom(b) && rectBottom(a) > b.y;

/**
 * If a pet box straddles displays or occupies a real gap inside the virtual desktop, return the
 * nearest position where the entire box fits on one display. Boxes clipped only by the outside
 * edge of the whole desktop are left alone.
 */
export const relocateRectFromDisplayGap = (areas: Rect[], rect: Rect): Rect | null => {
  const displays = areas.filter((area) => area.width > 0 && area.height > 0);
  if (displays.length < 2 || displays.some((area) => rectContainsRect(area, rect))) return null;

  const overlappingDisplays = displays.filter((area) => rectsIntersect(area, rect));
  let occupiesGap = overlappingDisplays.length > 1;
  if (!occupiesGap) {
    const hull = boundingRect(displays);
    const clipped = {
      x: Math.max(rect.x, hull.x),
      y: Math.max(rect.y, hull.y),
      width: Math.min(rectRight(rect), rectRight(hull)) - Math.max(rect.x, hull.x),
      height: Math.min(rectBottom(rect), rectBottom(hull)) - Math.max(rect.y, hull.y),
    };
    if (clipped.width > 0 && clipped.height > 0) {
      const xEdges = [clipped.x, rectRight(clipped)];
      const yEdges = [clipped.y, rectBottom(clipped)];
      for (const area of displays) {
        for (const edge of [area.x, rectRight(area)]) {
          if (edge > clipped.x && edge < rectRight(clipped)) xEdges.push(edge);
        }
        for (const edge of [area.y, rectBottom(area)]) {
          if (edge > clipped.y && edge < rectBottom(clipped)) yEdges.push(edge);
        }
      }
      xEdges.sort((a, b) => a - b);
      yEdges.sort((a, b) => a - b);
      for (let xi = 0; xi < xEdges.length - 1 && !occupiesGap; xi++) {
        for (let yi = 0; yi < yEdges.length - 1; yi++) {
          const x = (xEdges[xi] + xEdges[xi + 1]) / 2;
          const y = (yEdges[yi] + yEdges[yi + 1]) / 2;
          if (!rectAtPoint(displays, x, y)) {
            occupiesGap = true;
            break;
          }
        }
      }
    }
  }
  if (!occupiesGap) return null;

  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  const centerDisplay = rectAtPoint(displays, centerX, centerY);
  const candidates = centerDisplay ? [centerDisplay, ...displays.filter((area) => area !== centerDisplay)] : displays;
  let best: Rect | null = null;
  let bestDistance = Infinity;
  for (const area of candidates) {
    if (area.width < rect.width || area.height < rect.height) continue;
    const x = Math.max(area.x, Math.min(rectRight(area) - rect.width, centerX - rect.width / 2));
    const y = Math.max(area.y, Math.min(rectBottom(area) - rect.height, centerY - rect.height / 2));
    const distance = (x + rect.width / 2 - centerX) ** 2 + (y + rect.height / 2 - centerY) ** 2;
    if (distance < bestDistance) {
      best = { ...rect, x, y };
      bestDistance = distance;
    }
  }
  return best;
};

export const regionArea = (rects: Rect[]): number => rects.reduce((s, r) => s + r.width * r.height, 0);

/** 外接矩形中不属于任何显示器的面积占比 0~1（诊断/日志用；矩形不重叠时精确） */
export const regionHoleRatio = (rects: Rect[]): number => {
  const hull = boundingRect(rects);
  const hullArea = hull.width * hull.height;
  if (hullArea <= 0) return 0;
  return Math.max(0, 1 - regionArea(rects) / hullArea);
};

/** 把一组矩形整体平移（屏幕坐标 → 视口相对坐标：减去 VIEW 原点） */
export const translateRects = (rects: Rect[], dx: number, dy: number): Rect[] =>
  rects.map((r) => ({ x: r.x + dx, y: r.y + dy, width: r.width, height: r.height }));
