"""Create a deterministic photorealistic confetti overlay from an AI photo sprite sheet.

The checked-in source sheet uses a uniform chroma background so this script can
recover a clean alpha channel without shipping generated checkerboard pixels.
Requires Pillow and NumPy only for release-asset generation.
"""

from __future__ import annotations

import argparse
from collections import deque
import math
from pathlib import Path
import random

import numpy as np
from PIL import Image, ImageEnhance, ImageFilter


WIDTH = 1280
HEIGHT = 720
FPS = 30
FRAME_COUNT = 120
PARTICLE_COUNT = 216
SEED = 827_104


def chroma_to_rgba(source: Image.Image) -> Image.Image:
    rgb = np.asarray(source.convert("RGB"), dtype=np.float32)
    corners = np.concatenate(
        (rgb[:24, :24].reshape(-1, 3), rgb[-24:, -24:].reshape(-1, 3)), axis=0
    )
    key = np.median(corners, axis=0)
    distance = np.linalg.norm(rgb - key, axis=2)
    alpha = np.clip((distance - 5.0) / 42.0, 0.0, 1.0)
    alpha = alpha * alpha * (3.0 - 2.0 * alpha)

    safe_alpha = np.maximum(alpha[..., None], 1.0 / 255.0)
    foreground = (rgb - key * (1.0 - safe_alpha)) / safe_alpha
    foreground = np.clip(foreground, 0.0, 255.0)
    rgba = np.concatenate((foreground, (alpha * 255.0)[..., None]), axis=2)
    rgba[alpha < 0.01, :3] = 0.0
    return Image.fromarray(rgba.astype(np.uint8), "RGBA")


def connected_boxes(alpha: np.ndarray) -> list[tuple[int, int, int, int, int]]:
    work = alpha > 92
    height, width = work.shape
    boxes: list[tuple[int, int, int, int, int]] = []
    for y in range(height):
        for x in range(width):
            if not work[y, x]:
                continue
            queue = deque(((x, y),))
            work[y, x] = False
            min_x = max_x = x
            min_y = max_y = y
            area = 0
            while queue:
                px, py = queue.popleft()
                area += 1
                min_x = min(min_x, px)
                max_x = max(max_x, px)
                min_y = min(min_y, py)
                max_y = max(max_y, py)
                for ny in range(max(0, py - 1), min(height, py + 2)):
                    for nx in range(max(0, px - 1), min(width, px + 2)):
                        if work[ny, nx]:
                            work[ny, nx] = False
                            queue.append((nx, ny))
            if area >= 220 and max_x - min_x >= 8 and max_y - min_y >= 8:
                boxes.append((min_x, min_y, max_x + 1, max_y + 1, area))
    return sorted(boxes, key=lambda item: item[4], reverse=True)


def extract_sprites(source_path: Path, sheet_output: Path) -> list[Image.Image]:
    rgba = chroma_to_rgba(Image.open(source_path))
    rgba.save(sheet_output)
    alpha = np.asarray(rgba.getchannel("A"))
    sprites: list[Image.Image] = []
    for x0, y0, x1, y1, _ in connected_boxes(alpha):
        margin = 4
        crop = rgba.crop(
            (max(0, x0 - margin), max(0, y0 - margin), min(rgba.width, x1 + margin), min(rgba.height, y1 + margin))
        )
        if crop.width <= 260 and crop.height <= 300:
            sprites.append(crop)
    if len(sprites) < 48:
        raise RuntimeError(f"sprite extraction produced only {len(sprites)} usable pieces")
    return sprites


def alpha_scaled(image: Image.Image, opacity: float) -> Image.Image:
    if opacity >= 0.999:
        return image
    result = image.copy()
    alpha = result.getchannel("A").point(lambda value: round(value * opacity))
    result.putalpha(alpha)
    return result


def render(source_path: Path, frames_dir: Path, transparent_sheet: Path) -> None:
    rng = random.Random(SEED)
    sprites = extract_sprites(source_path, transparent_sheet)
    frames_dir.mkdir(parents=True, exist_ok=True)

    particles = []
    chosen = list(range(len(sprites)))
    rng.shuffle(chosen)
    for index in range(PARTICLE_COUNT):
        sprite_index = chosen[index % len(chosen)]
        sprite = sprites[sprite_index]
        source_ratio = max(sprite.width, sprite.height) / max(1, min(sprite.width, sprite.height))
        is_ribbon = source_ratio >= 2.7
        group = index % 19
        if group == 0:
            origin_x = rng.uniform(WIDTH * 0.42, WIDTH * 0.58)
            velocity_x = rng.uniform(-6.5, 6.5)
        elif index % 2 == 0:
            origin_x = rng.uniform(-70, WIDTH * 0.12)
            velocity_x = rng.uniform(4.5, 9.0)
        else:
            origin_x = rng.uniform(WIDTH * 0.88, WIDTH + 70)
            velocity_x = rng.uniform(-9.0, -4.5)
        layer = rng.random()
        if layer < 0.16:
            scale = rng.uniform(0.44, 0.62)
            softness = 0.45
        elif layer < 0.72:
            scale = rng.uniform(0.29, 0.47)
            softness = 0.0
        else:
            scale = rng.uniform(0.21, 0.34)
            softness = 0.25
        if is_ribbon:
            scale *= 0.88
        particles.append(
            {
                "sprite": sprite,
                "origin_x": origin_x,
                "origin_y": rng.uniform(HEIGHT + 22, HEIGHT + 95),
                "vx": velocity_x,
                "vy": rng.uniform(-27.0, -20.5),
                "gravity": rng.uniform(0.48, 0.58),
                "launch": rng.randint(0, 11),
                "scale": scale,
                "angle": rng.uniform(0, 360),
                "spin": rng.uniform(-5.4, 5.4),
                "phase": rng.uniform(0, math.tau),
                "flutter": rng.uniform(0.14, 0.24),
                "drift": rng.uniform(4.0, 13.0),
                "softness": softness,
                "brightness": rng.uniform(0.92, 1.08),
            }
        )

    for frame_number in range(1, FRAME_COUNT + 1):
        canvas = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
        if frame_number < FRAME_COUNT:
            for particle in particles:
                age = frame_number - particle["launch"]
                if age < 0:
                    continue
                x = particle["origin_x"] + particle["vx"] * age
                x += math.sin(particle["phase"] + age * 0.105) * particle["drift"]
                y = particle["origin_y"] + particle["vy"] * age + 0.5 * particle["gravity"] * age * age
                if y < -230 or y > HEIGHT + 170 or x < -260 or x > WIDTH + 260:
                    continue

                flutter = 0.42 + 0.58 * abs(math.sin(particle["phase"] + age * particle["flutter"]))
                base = particle["sprite"]
                target_width = max(3, round(base.width * particle["scale"]))
                target_height = max(3, round(base.height * particle["scale"] * flutter))
                piece = base.resize((target_width, target_height), Image.Resampling.LANCZOS)
                piece = ImageEnhance.Brightness(piece).enhance(particle["brightness"] * (0.86 + 0.14 * flutter))
                piece = piece.rotate(
                    particle["angle"] + particle["spin"] * age,
                    resample=Image.Resampling.BICUBIC,
                    expand=True,
                )
                speed = abs(particle["vy"] + particle["gravity"] * age)
                if particle["softness"] > 0 or speed > 22:
                    piece = piece.filter(ImageFilter.GaussianBlur(particle["softness"] + max(0.0, speed - 22) * 0.025))
                opacity = min(1.0, (age + 1) / 4.0)
                if frame_number > FRAME_COUNT - 10:
                    opacity *= (FRAME_COUNT - frame_number) / 10.0
                piece = alpha_scaled(piece, max(0.0, opacity))
                canvas.alpha_composite(piece, (round(x - piece.width / 2), round(y - piece.height / 2)))
        canvas.save(frames_dir / f"photoreal_confetti_{frame_number:04d}.png", optimize=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--frames-dir", type=Path, required=True)
    parser.add_argument("--sheet-output", type=Path, required=True)
    args = parser.parse_args()
    render(args.source.resolve(), args.frames_dir.resolve(), args.sheet_output.resolve())


if __name__ == "__main__":
    main()
