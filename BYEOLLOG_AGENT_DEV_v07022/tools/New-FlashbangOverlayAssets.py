from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageEnhance, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "Assets" / "Source" / "byeollog_flashbang_effect_source.png"
OUTPUTS = {
    "soft": (0.80, ROOT / "Assets" / "byeollog_flashbang_soft.gif"),
    "standard": (1.00, ROOT / "Assets" / "byeollog_flashbang_standard.gif"),
    "strong": (1.22, ROOT / "Assets" / "byeollog_flashbang_strong.gif"),
}

# GIF has only one-bit transparency. Trying to encode a smooth alpha fade in the
# bitmap itself causes visible salt-and-pepper noise at 1920x1080. These clean,
# opaque frames provide the bloom movement; ByeollogOverlayService applies the
# smooth 5-second alpha recovery in the Browser Source compositor.
FRAME_DURATIONS_MS = [150, 180, 250, 350, 480, 650, 850, 1020, 1070]
BLOOM_CURVE = [1.00, 0.98, 0.94, 0.87, 0.77, 0.65, 0.54, 0.46, 0.40]


def build_frame(source: Image.Image, strength: float, bloom: float) -> Image.Image:
    brightness = 0.92 + (0.40 * strength * bloom)
    contrast = 0.98 + (0.08 * strength * bloom)
    frame = ImageEnhance.Brightness(source).enhance(brightness)
    frame = ImageEnhance.Contrast(frame).enhance(contrast)
    if bloom > 0.60:
        softened = frame.filter(ImageFilter.GaussianBlur(radius=2.2 * bloom))
        frame = Image.blend(frame, softened, min(0.28, 0.18 * strength * bloom))
    return frame.quantize(
        colors=56,
        method=Image.Quantize.MEDIANCUT,
        dither=Image.Dither.NONE,
    )


def main() -> None:
    source = Image.open(SOURCE).convert("RGB")
    if source.size != (1920, 1080):
        raise SystemExit(f"expected 1920x1080 source, got {source.size[0]}x{source.size[1]}")

    for name, (strength, output_path) in OUTPUTS.items():
        frames = [build_frame(source, strength, bloom) for bloom in BLOOM_CURVE]
        frames[0].save(
            output_path,
            save_all=True,
            append_images=frames[1:],
            duration=FRAME_DURATIONS_MS,
            loop=0,
            optimize=True,
            disposal=1,
        )
        print(f"{name}: {output_path} ({output_path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
