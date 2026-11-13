#!/usr/bin/env python3
"""Draw a transparent 16x16 icon pixel by pixel from a flat-background avatar.

Every output pixel is chosen explicitly from its source cell:

* coverage = fraction of the source cell that belongs to the avatar
* alpha    = 255 when coverage >= threshold, otherwise 0 (strictly binary)
* colour   = mean RGB of the opaque source pixels in that cell

No image resampling and no alpha blending are used, so the result contains
no semi-transparent pixels at all.

Requirements: Python 3.10+, Pillow, numpy.
"""

from __future__ import annotations

import argparse
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image

DEFAULT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SOURCE = DEFAULT_ROOT / "assets" / "icons" / "pixel-avatar-source.png"
DEFAULT_OUTPUT = DEFAULT_ROOT / "assets" / "icons" / "pixel-avatar-16.png"


def flat_background_alpha(rgb: np.ndarray, tolerance: float) -> np.ndarray:
    """Alpha = 0 for border-connected pixels matching the flat background."""
    h, w, _ = rgb.shape
    border = np.concatenate((rgb[0, :], rgb[-1, :], rgb[:, 0], rgb[:, -1]), axis=0)
    bg_colour = np.median(border, axis=0)
    distance = np.sqrt(((rgb.astype(np.float64) - bg_colour) ** 2).sum(axis=2))
    candidate = distance <= tolerance

    background = np.zeros((h, w), dtype=bool)
    queue: deque[tuple[int, int]] = deque()

    def push(y: int, x: int) -> None:
        if candidate[y, x] and not background[y, x]:
            background[y, x] = True
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

    return np.where(background, 0, 255).astype(np.uint8)


def square_avatar_crop(rgba: Image.Image) -> Image.Image:
    """Crop to the alpha bbox and pad the short side with transparency."""
    bbox = rgba.getchannel("A").getbbox()
    if bbox is None:
        raise SystemExit("The source is fully transparent.")
    left, top, right, bottom = bbox
    side = max(right - left, bottom - top)
    cx, cy = (left + right) / 2, (top + bottom) / 2
    crop_left = int(round(cx - side / 2))
    crop_top = int(round(cy - side / 2))
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(rgba, (-crop_left, -crop_top), rgba)
    return canvas


def build_pixel_icon(crop: Image.Image, size: int, threshold: float) -> np.ndarray:
    """Choose every output pixel from its source cell; alpha is 0 or 255."""
    src = np.asarray(crop).astype(np.float64)
    h, w, _ = src.shape
    out = np.zeros((size, size, 4), dtype=np.uint8)

    for j in range(size):
        y0 = int(round(j * h / size))
        y1 = int(round((j + 1) * h / size))
        for i in range(size):
            x0 = int(round(i * w / size))
            x1 = int(round((i + 1) * w / size))
            cell = src[y0:y1, x0:x1]
            opaque = cell[..., 3] > 0
            coverage = float(opaque.mean())
            if coverage < threshold or not opaque.any():
                continue
            colour = cell[opaque][:, :3].mean(axis=0)
            out[j, i, :3] = np.clip(np.rint(colour), 0, 255).astype(np.uint8)
            out[j, i, 3] = 255

    # Remove isolated opaque pixels and fill one-pixel holes, still per pixel.
    solid = out[..., 3] > 0
    neighbours = np.zeros_like(solid, dtype=np.int8)
    neighbours[1:, :] += solid[:-1, :]
    neighbours[:-1, :] += solid[1:, :]
    neighbours[:, 1:] += solid[:, :-1]
    neighbours[:, :-1] += solid[:, 1:]
    out[solid & (neighbours == 0)] = 0

    solid = out[..., 3] > 0
    neighbours = np.zeros_like(solid, dtype=np.int8)
    neighbours[1:, :] += solid[:-1, :]
    neighbours[:-1, :] += solid[1:, :]
    neighbours[:, 1:] += solid[:, :-1]
    neighbours[:, :-1] += solid[:, 1:]
    for j, i in zip(*np.where((~solid) & (neighbours == 4))):
        nearby = []
        for dj, di in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            y, x = j + dj, i + di
            if 0 <= y < size and 0 <= x < size and out[y, x, 3] == 255:
                nearby.append(out[y, x, :3].astype(np.float64))
        if nearby:
            out[j, i, :3] = np.clip(np.rint(np.mean(nearby, axis=0)), 0, 255).astype(np.uint8)
            out[j, i, 3] = 255

    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--size", type=int, default=16)
    parser.add_argument("--threshold", type=float, default=0.4)
    parser.add_argument("--tolerance", type=float, default=17.0)
    parser.add_argument("--preview", type=Path, default=None)
    args = parser.parse_args()

    source = args.source.expanduser().resolve()
    output = args.output.expanduser().resolve()
    if not source.is_file():
        raise SystemExit(f"Source not found: {source}")

    original = Image.open(source).convert("RGB")
    rgb = np.asarray(original)
    alpha = flat_background_alpha(rgb, args.tolerance)
    rgba = Image.fromarray(np.dstack([rgb, alpha]), "RGBA")
    crop = square_avatar_crop(rgba)
    pixels = build_pixel_icon(crop, args.size, args.threshold)
    icon = Image.fromarray(pixels, "RGBA")

    values = np.unique(pixels[..., 3])
    if not set(values.tolist()) <= {0, 255}:
        raise SystemExit(f"Semi-transparent pixels produced: {values.tolist()}")
    if int((pixels[..., 3] == 255).sum()) == 0:
        raise SystemExit("Every pixel is transparent; lower --threshold.")

    output.parent.mkdir(parents=True, exist_ok=True)
    icon.save(output, "PNG", optimize=True)

    if args.preview:
        args.preview.parent.mkdir(parents=True, exist_ok=True)
        icon.resize((args.size * 16, args.size * 16), Image.NEAREST).save(args.preview, "PNG")

    opaque = int((pixels[..., 3] == 255).sum())
    print(f"source          : {source} ({original.width}x{original.height})")
    print(f"crop             : square {crop.width}px around the avatar bbox")
    print(f"icon             : {output} ({icon.width}x{icon.height}, {icon.mode})")
    print(f"pixels           : {opaque} opaque, {args.size * args.size - opaque} transparent")
    print(f"alpha values      : {values.tolist()}")
    print("semi-transparent : 0")


if __name__ == "__main__":
    main()
