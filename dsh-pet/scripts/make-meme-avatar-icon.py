#!/usr/bin/env python3
"""Generate a 16x16 avatar icon from the chibi meme artwork.

Pipeline
--------
1. Read the RGB source image.
2. Flood-fill the near-white paper background from the border to build alpha.
3. Find the largest warm skin blob (the character's face) for crop anchoring.
4. Derive a square head crop that includes the bonnet, hair and face.
5. Downscale to 16x16, then apply a light unsharp/saturation/contrast pass.
6. Verify the artwork reaches all four canvas edges (no transparent margin)
   and write an RGBA PNG.

Usage
-----
    python make-meme-avatar-icon.py
    python make-meme-avatar-icon.py --source ... --output ... --preview ...

Requirements: Python 3.10+, Pillow, numpy.
"""

from __future__ import annotations

import argparse
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageEnhance, ImageFilter

DEFAULT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SOURCE = DEFAULT_ROOT / "assets" / "memes" / "可爱.png"
DEFAULT_OUTPUT = DEFAULT_ROOT / "assets" / "icons" / "cute-avatar-16.png"

SIZE = 16
# Head crop proportions, measured from the source artwork's face box.
# The bonnet occupies the space above the face, so the crop is shifted up
# relative to the face and only slightly below the chin.
CROP_WIDTH_RATIO = 1.65   # crop side / face width
CROP_SHIFT_X = 0.483      # crop left = face centre - side * SHIFT_X
CROP_SHIFT_Y = 0.475      # crop top  = face top    - side * SHIFT_Y


def background_alpha(rgb: np.ndarray) -> np.ndarray:
    """Return an alpha channel: 0 for border-connected near-white paper."""
    h, w, _ = rgb.shape
    near_white = (rgb.min(axis=2) >= 236) & (rgb.max(axis=2) - rgb.min(axis=2) <= 14)
    bg = np.zeros((h, w), dtype=bool)
    queue: deque[tuple[int, int]] = deque()

    def push(y: int, x: int) -> None:
        if near_white[y, x] and not bg[y, x]:
            bg[y, x] = True
            queue.append((y, x))

    for x in range(w):
        push(0, x)
        push(h - 1, x)
    for y in range(h):
        push(y, 0)
        push(y, w - 1)
    while queue:
        y, x = queue.popleft()
        if y > 0:
            push(y - 1, x)
        if y + 1 < h:
            push(y + 1, x)
        if x > 0:
            push(y, x - 1)
        if x + 1 < w:
            push(y, x + 1)
    return np.where(bg, 0, 255).astype(np.uint8)


def find_face_box(rgb: np.ndarray) -> tuple[int, int, int, int]:
    """Locate the face as the largest warm-tone connected component."""
    r = rgb[..., 0].astype(np.int16)
    g = rgb[..., 1].astype(np.int16)
    b = rgb[..., 2].astype(np.int16)
    skin = (
        (r > 215) & (g > 180) & (b > 160)
        & (r - b > 18) & (r - g > 4) & (r >= g) & (g >= b)
    )
    h, w = skin.shape
    labels = np.zeros((h, w), dtype=bool)
    best: tuple[int, int, int, int, int] | None = None
    for y0 in range(h):
        row = skin[y0]
        if not row.any():
            continue
        for x0 in np.flatnonzero(row & ~labels[y0]):
            if labels[y0, x0]:
                continue
            queue = deque([(y0, int(x0))])
            labels[y0, x0] = True
            area = 0
            min_x = max_x = int(x0)
            min_y = max_y = y0
            while queue:
                y, x = queue.popleft()
                area += 1
                min_x = min(min_x, x)
                max_x = max(max_x, x)
                min_y = min(min_y, y)
                max_y = max(max_y, y)
                for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
                    if 0 <= ny < h and 0 <= nx < w and skin[ny, nx] and not labels[ny, nx]:
                        labels[ny, nx] = True
                        queue.append((ny, nx))
            if area >= 150 and (best is None or area > best[0]):
                best = (area, min_x, min_y, max_x, max_y)
    if best is None:
        raise RuntimeError("Could not locate the face; adjust skin thresholds.")
    _, x0, y0, x1, y1 = best
    return int(x0), int(y0), int(x1), int(y1)


def head_crop_box(face: tuple[int, int, int, int], width: int, height: int) -> tuple[int, int, int, int]:
    """Compute a square crop around the head from the detected face box."""
    fx0, fy0, fx1, fy1 = face
    face_w = fx1 - fx0 + 1
    cx = (fx0 + fx1) / 2
    side = int(round(face_w * CROP_WIDTH_RATIO))
    left = int(round(cx - side * CROP_SHIFT_X))
    top = int(round(fy0 - side * CROP_SHIFT_Y))
    left = max(0, min(left, width - side))
    top = max(0, min(top, height - side))
    return left, top, left + side, top + side


def render_icon(crop: Image.Image, size: int) -> Image.Image:
    """Downscale the RGBA head crop and apply a light clarity pass."""
    icon = crop.resize((size, size), Image.LANCZOS)
    icon = icon.filter(ImageFilter.UnsharpMask(radius=0.7, percent=90, threshold=0))
    icon = ImageEnhance.Contrast(icon).enhance(1.08)
    icon = ImageEnhance.Color(icon).enhance(1.25)
    return icon


def edge_report(icon: Image.Image) -> dict[str, int]:
    alpha = np.asarray(icon)[..., 3]
    return {
        "top": int((alpha[0] > 0).sum()),
        "bottom": int((alpha[-1] > 0).sum()),
        "left": int((alpha[:, 0] > 0).sum()),
        "right": int((alpha[:, -1] > 0).sum()),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--preview", type=Path, default=None,
                        help="optional nearest-neighbour 16x preview PNG")
    args = parser.parse_args()

    source = args.source.expanduser().resolve()
    output = args.output.expanduser().resolve()
    if not source.is_file():
        raise SystemExit(f"Source not found: {source}")

    original = Image.open(source).convert("RGB")
    rgb = np.asarray(original)
    height, width = rgb.shape[:2]

    alpha = background_alpha(rgb)
    rgba = Image.fromarray(np.dstack([rgb, alpha]), "RGBA")
    face = find_face_box(rgb)
    box = head_crop_box(face, width, height)
    crop = rgba.crop(box)
    icon = render_icon(crop, SIZE)

    # Guarantee the avatar touches the canvas: no uniform transparent border.
    if np.asarray(icon)[..., 3].max() == 0:
        raise SystemExit("Rendered icon is fully transparent.")
    edges = edge_report(icon)
    empty = [name for name, count in edges.items() if count == 0]
    if empty:
        raise SystemExit(f"Transparent gap on edge(s): {', '.join(empty)}")

    bbox = icon.getchannel("A").getbbox()
    if bbox != (0, 0, SIZE, SIZE):
        raise SystemExit(f"Alpha bbox {bbox} does not fill {SIZE}x{SIZE}.")

    output.parent.mkdir(parents=True, exist_ok=True)
    icon.save(output, "PNG", optimize=True)

    if args.preview:
        args.preview.parent.mkdir(parents=True, exist_ok=True)
        icon.resize((SIZE * 16, SIZE * 16), Image.NEAREST).save(args.preview, "PNG")

    print(f"source : {source} ({width}x{height})")
    print(f"face   : {face}")
    print(f"crop   : {box}  ({box[2] - box[0]}px square)")
    print(f"icon   : {output} ({icon.width}x{icon.height}, {icon.mode})")
    print(f"alpha  : bbox={bbox}, opaque pixels={int((np.asarray(icon)[..., 3] > 0).sum())}/{SIZE * SIZE}")
    print("edges  : " + ", ".join(f"{name}={count}/{SIZE}" for name, count in edges.items()))


if __name__ == "__main__":
    main()
