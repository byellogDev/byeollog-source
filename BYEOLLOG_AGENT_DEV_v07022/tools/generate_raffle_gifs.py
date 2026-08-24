from __future__ import annotations

import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter


FRAME_COUNT = 24
DRAW_FRAME_COUNT = 32
CANVAS_SIZE = 640
ART_SIZE = 520
FRAME_MS = 70
SUPERSAMPLE = 3

NAVY = (7, 28, 61, 255)
NAVY_2 = (24, 58, 112, 255)
CREAM = (255, 248, 225, 255)
GOLD = (245, 182, 61, 255)
CORAL = (235, 98, 82, 255)
SKY = (203, 228, 239, 255)


def star_points(cx: float, cy: float, outer: float, inner: float, count: int = 5) -> list[tuple[float, float]]:
    points: list[tuple[float, float]] = []
    for index in range(count * 2):
        angle = -math.pi / 2 + index * math.pi / count
        radius = outer if index % 2 == 0 else inner
        points.append((cx + math.cos(angle) * radius, cy + math.sin(angle) * radius))
    return points


def scaled_artwork(draw_function) -> Image.Image:
    size = ART_SIZE * SUPERSAMPLE
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw_function(canvas, ImageDraw.Draw(canvas, "RGBA"), SUPERSAMPLE)
    return canvas.resize((ART_SIZE, ART_SIZE), Image.Resampling.LANCZOS)


def build_raffle_ticket(s: int) -> Image.Image:
    def p(value: float) -> int:
        return round(value * s)

    outline = p(9)
    ticket = Image.new("RGBA", (p(340), p(230)), (0, 0, 0, 0))
    ticket_draw = ImageDraw.Draw(ticket, "RGBA")
    ticket_draw.rounded_rectangle((p(8), p(8), p(332), p(222)), radius=p(24), fill=CREAM, outline=NAVY, width=outline)
    ticket_draw.rounded_rectangle((p(35), p(35), p(305), p(195)), radius=p(16), outline=GOLD, width=p(7))
    ticket_draw.polygon(star_points(p(170), p(115), p(52), p(23)), fill=GOLD, outline=NAVY)
    for y in (62, 92, 122, 152):
        ticket_draw.ellipse((p(18), p(y), p(28), p(y + 10)), fill=GOLD)
        ticket_draw.ellipse((p(312), p(y), p(322), p(y + 10)), fill=GOLD)
    return ticket


def build_ticket_artwork() -> Image.Image:
    def render(canvas: Image.Image, draw: ImageDraw.ImageDraw, s: int) -> None:
        def p(value: float) -> int:
            return round(value * s)

        outline = p(9)
        draw.rounded_rectangle((p(76), p(205), p(444), p(438)), radius=p(32), fill=NAVY_2, outline=NAVY, width=outline)
        draw.polygon([(p(84), p(228)), (p(260), p(92)), (p(436), p(228))], fill=NAVY_2, outline=NAVY)

        ticket = build_raffle_ticket(s)
        ticket = ticket.rotate(-7, Image.Resampling.BICUBIC, expand=True)
        canvas.alpha_composite(ticket, (p(91), p(84)))

        draw.polygon([(p(82), p(258)), (p(260), p(375)), (p(438), p(258)), (p(432), p(430)), (p(88), p(430))], fill=NAVY_2, outline=NAVY)
        draw.line([(p(86), p(424)), (p(218), p(316))], fill=NAVY, width=outline)
        draw.line([(p(434), p(424)), (p(302), p(316))], fill=NAVY, width=outline)
        draw.ellipse((p(218), p(333), p(302), p(417)), fill=GOLD, outline=NAVY, width=outline)
        draw.polygon(star_points(p(260), p(375), p(27), p(12)), fill=CREAM, outline=NAVY)
        draw.line([(p(68), p(150)), (p(95), p(181))], fill=CORAL, width=p(13))
        draw.line([(p(425), p(155)), (p(452), p(128))], fill=CORAL, width=p(13))

    return scaled_artwork(render)


def vertical_gradient(size: tuple[int, int], top: tuple[int, int, int, int], bottom: tuple[int, int, int, int]) -> Image.Image:
    gradient = Image.new("RGBA", size, top)
    gradient_draw = ImageDraw.Draw(gradient, "RGBA")
    denominator = max(1, size[1] - 1)
    for y in range(size[1]):
        mix = y / denominator
        color = tuple(round(top[index] * (1.0 - mix) + bottom[index] * mix) for index in range(4))
        gradient_draw.line((0, y, size[0], y), fill=color)
    return gradient


def build_draw_ticket() -> Image.Image:
    s = SUPERSAMPLE

    def p(value: float) -> int:
        return round(value * s)

    width, height = p(310), p(356)
    ticket = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    mask = Image.new("L", ticket.size, 0)
    mask_draw = ImageDraw.Draw(mask)
    mask_draw.rounded_rectangle((p(6), p(6), width - p(6), height - p(6)), radius=p(24), fill=255)
    face = vertical_gradient(ticket.size, (255, 252, 240, 255), (255, 246, 220, 255))
    face.putalpha(mask)
    ticket.alpha_composite(face)

    draw = ImageDraw.Draw(ticket, "RGBA")
    draw.rounded_rectangle(
        (p(6), p(6), width - p(6), height - p(6)),
        radius=p(24),
        outline=NAVY,
        width=p(10),
    )
    draw.rounded_rectangle((p(37), p(42), width - p(37), height - p(42)), radius=p(17), outline=GOLD, width=p(7))
    draw.polygon(star_points(width / 2, height / 2 + p(6), p(62), p(27)), fill=GOLD)
    for y in (78, 120, 162, 204, 246):
        draw.ellipse((p(18), p(y), p(30), p(y + 12)), fill=GOLD)
        draw.ellipse((width - p(30), p(y), width - p(18), p(y + 12)), fill=GOLD)
    return ticket.resize((310, 356), Image.Resampling.LANCZOS)


def build_draw_layers() -> tuple[Image.Image, Image.Image, Image.Image]:
    s = SUPERSAMPLE
    size = CANVAS_SIZE * s

    def p(value: float) -> int:
        return round(value * s)

    box = Image.new("RGBA", (size, size), (0, 0, 0, 0))

    top_mask = Image.new("L", box.size, 0)
    top_mask_draw = ImageDraw.Draw(top_mask)
    top_mask_draw.polygon(
        [(p(-30), p(430)), (p(92), p(314)), (p(548), p(314)), (p(670), p(430))],
        fill=255,
    )
    top_face = vertical_gradient(box.size, (34, 77, 143, 255), (17, 52, 104, 255))
    top_face.putalpha(top_mask)
    box.alpha_composite(top_face)

    front_mask = Image.new("L", box.size, 0)
    front_mask_draw = ImageDraw.Draw(front_mask)
    front_mask_draw.rounded_rectangle((p(-18), p(424), p(658), p(710)), radius=p(34), fill=255)
    front_face = vertical_gradient(box.size, (29, 70, 132, 255), (13, 43, 91, 255))
    front_face.putalpha(front_mask)
    box.alpha_composite(front_face)

    box_draw = ImageDraw.Draw(box, "RGBA")
    box_draw.line([(p(-15), p(428)), (p(655), p(428))], fill=NAVY, width=p(12))
    box_draw.rounded_rectangle((p(124), p(365), p(516), p(406)), radius=p(20), fill=(5, 24, 54, 255))
    box_draw.line([(p(94), p(314)), (p(548), p(314))], fill=(45, 88, 153, 230), width=p(3))

    front_lip = Image.new("RGBA", box.size, (0, 0, 0, 0))
    lip_draw = ImageDraw.Draw(front_lip, "RGBA")
    lip_draw.rounded_rectangle((p(124), p(388), p(516), p(408)), radius=p(10), fill=(4, 23, 52, 255))

    box = box.resize((CANVAS_SIZE, CANVAS_SIZE), Image.Resampling.LANCZOS)
    front_lip = front_lip.resize((CANVAS_SIZE, CANVAS_SIZE), Image.Resampling.LANCZOS)
    return box, build_draw_ticket(), front_lip


def compose_draw_artwork(
    layers: tuple[Image.Image, Image.Image, Image.Image],
    ticket_progress: float = 1.0,
    ticket_rotation: float = 0.0,
    ticket_x_offset: int = 0,
) -> Image.Image:
    box, ticket, front_lip = layers
    canvas = Image.new("RGBA", (CANVAS_SIZE, CANVAS_SIZE), (0, 0, 0, 0))
    canvas.alpha_composite(box)

    progress = max(0.0, min(1.06, ticket_progress))
    start_y = 356
    finish_y = 76
    ticket_y = round(start_y + (finish_y - start_y) * progress)
    transformed_ticket = ticket.rotate(ticket_rotation, Image.Resampling.BICUBIC, expand=True)
    ticket_x = (CANVAS_SIZE - transformed_ticket.width) // 2 + ticket_x_offset

    moved_ticket = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    moved_ticket.alpha_composite(transformed_ticket, (ticket_x, ticket_y))

    shadow_alpha = moved_ticket.getchannel("A").filter(ImageFilter.GaussianBlur(8))
    shadow = Image.new("RGBA", canvas.size, (2, 15, 38, 0))
    shadow.putalpha(shadow_alpha.point(lambda value: round(value * 0.36)))
    visible_shadow = shadow.crop((0, 0, CANVAS_SIZE, 404))
    canvas.alpha_composite(visible_shadow, (5, 7))

    # Anything below the slot remains inside the box. The near lip is then
    # painted over the ticket so it visibly passes through the opening.
    visible_ticket = moved_ticket.crop((0, 0, CANVAS_SIZE, 404))
    canvas.alpha_composite(visible_ticket, (0, 0))
    canvas.alpha_composite(front_lip)
    return canvas


def build_draw_artwork(layers: tuple[Image.Image, Image.Image, Image.Image]) -> Image.Image:
    return compose_draw_artwork(layers, 1.0)


def composite_center(canvas: Image.Image, artwork: Image.Image, scale: float, rotation: float, y_offset: int) -> None:
    width = max(1, round(artwork.width * scale))
    height = max(1, round(artwork.height * scale))
    transformed = artwork.resize((width, height), Image.Resampling.LANCZOS)
    transformed = transformed.rotate(rotation, Image.Resampling.BICUBIC, expand=True)
    x = (canvas.width - transformed.width) // 2
    y = (canvas.height - transformed.height) // 2 + y_offset
    canvas.alpha_composite(transformed, (x, y))


def sparkle(draw: ImageDraw.ImageDraw, x: float, y: float, radius: float, opacity: int) -> None:
    draw.polygon(star_points(x, y, radius, radius * 0.4, 4), fill=(245, 182, 61, opacity))


def build_ticket_frames(artwork: Image.Image) -> list[Image.Image]:
    frames: list[Image.Image] = []
    for frame_index in range(FRAME_COUNT):
        phase = frame_index / FRAME_COUNT * math.tau
        canvas = Image.new("RGBA", (CANVAS_SIZE, CANVAS_SIZE), (0, 0, 0, 0))
        scale = 0.94 + 0.028 * math.sin(phase)
        composite_center(canvas, artwork, scale, 1.2 * math.sin(phase), round(-6 * math.sin(phase)))
        draw = ImageDraw.Draw(canvas, "RGBA")
        for offset, x, y in ((0.0, 105, 145), (2.2, 532, 190)):
            pulse = max(0.0, math.sin(phase + offset))
            sparkle(draw, x, y, 7 + 12 * pulse, round(230 * pulse))
        frames.append(canvas)
    return frames


def build_draw_frames(layers: tuple[Image.Image, Image.Image, Image.Image]) -> list[Image.Image]:
    frames: list[Image.Image] = []
    settle_progress = (1.045, 1.018, 0.994, 1.0)
    hold_offsets = (1, 0, -1, 0, 1, 0, -1, 0, 1, 0, -1, 0, 1)
    for frame_index in range(DRAW_FRAME_COUNT):
        if frame_index < 3:
            progress = frame_index * 0.01
            rotation = -1.8 + frame_index * 0.25
            x_offset = 0
        elif frame_index < 15:
            rise = (frame_index - 3) / 11
            eased = 1.0 - (1.0 - rise) ** 3
            progress = eased * 1.045
            rotation = -1.3 * (1.0 - eased) + 0.45 * math.sin(eased * math.pi)
            x_offset = round(4 * math.sin(eased * math.pi))
        elif frame_index < 19:
            progress = settle_progress[frame_index - 15]
            rotation = (0.35, -0.18, 0.08, 0.0)[frame_index - 15]
            x_offset = (1, 0, 0, 0)[frame_index - 15]
        else:
            offset = hold_offsets[frame_index - 19]
            progress = 1.0 - offset / 280
            rotation = offset * 0.08
            x_offset = 0

        frames.append(compose_draw_artwork(layers, progress, rotation, x_offset))
    return frames


def to_transparent_palette(frame: Image.Image) -> Image.Image:
    rgba = frame.convert("RGBA")
    alpha = rgba.getchannel("A")
    quantized = rgba.convert("RGB").quantize(colors=255, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    palette = [0, 0, 0] + quantized.getpalette()[: 255 * 3]
    palette.extend([0] * (768 - len(palette)))
    output = Image.new("P", rgba.size, 0)
    output.putpalette(palette)
    output.putdata([0 if opacity < 96 else min(255, color_index + 1) for color_index, opacity in zip(quantized.getdata(), alpha.getdata())])
    output.info["transparency"] = 0
    return output


def verify_transparent_gif(destination: Path, expected_frames: int, allow_bottom_edge_artwork: bool = False) -> None:
    with Image.open(destination) as image:
        if image.n_frames != expected_frames:
            raise ValueError(f"unexpected frame count: {image.n_frames}")
        transparent_probes = [(0, 0), (image.width - 1, 0)]
        if not allow_bottom_edge_artwork:
            transparent_probes.extend(((0, image.height - 1), (image.width - 1, image.height - 1)))
        for index in range(image.n_frames):
            image.seek(index)
            rgba = image.convert("RGBA")
            if any(rgba.getpixel(point)[3] != 0 for point in transparent_probes):
                raise ValueError(f"opaque GIF background detected in frame {index}")


def save_gif(
    frames: list[Image.Image],
    destination: Path,
    loop: int | None = 0,
    allow_bottom_edge_artwork: bool = False,
) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    palette_frames = [to_transparent_palette(frame) for frame in frames]
    save_options = {
        "save_all": True,
        "append_images": palette_frames[1:],
        "duration": FRAME_MS,
        "disposal": 2,
        "transparency": 0,
        "optimize": False,
    }
    if loop is not None:
        save_options["loop"] = loop
    palette_frames[0].save(destination, **save_options)
    verify_transparent_gif(destination, len(frames), allow_bottom_edge_artwork)


def save_source_sprite(ticket: Image.Image, draw: Image.Image, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    sprite = Image.new("RGBA", (CANVAS_SIZE * 2, CANVAS_SIZE), (0, 0, 0, 0))
    sprite.alpha_composite(ticket, ((CANVAS_SIZE - ticket.width) // 2, (CANVAS_SIZE - ticket.height) // 2))
    sprite.alpha_composite(draw, (CANVAS_SIZE, 0))
    sprite.save(destination, format="PNG")


def main() -> int:
    if len(sys.argv) != 4:
        raise SystemExit("usage: generate_raffle_gifs.py SOURCE_SPRITE TICKET_GIF DRAW_GIF")
    source_path, ticket_path, draw_path = map(Path, sys.argv[1:])
    ticket = build_ticket_artwork()
    draw_layers = build_draw_layers()
    draw = build_draw_artwork(draw_layers)
    save_source_sprite(ticket, draw, source_path)
    save_gif(build_ticket_frames(ticket), ticket_path)
    save_gif(build_draw_frames(draw_layers), draw_path, loop=0, allow_bottom_edge_artwork=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
