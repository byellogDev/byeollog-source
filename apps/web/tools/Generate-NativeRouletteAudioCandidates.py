#!/usr/bin/env python3
"""Generate five deterministic, three-second native roulette WAV candidates.

The generator intentionally uses only the Python standard library so candidate
assets can be rebuilt without a DAW, third-party package, or network access.
"""

from __future__ import annotations

import argparse
import math
import random
import struct
import wave
from array import array
from pathlib import Path


SAMPLE_RATE = 48_000
DURATION_SECONDS = 3.0
FRAME_COUNT = int(SAMPLE_RATE * DURATION_SECONDS)
TAU = math.tau


def stereo_buffer() -> tuple[array, array]:
    return array("d", [0.0]) * FRAME_COUNT, array("d", [0.0]) * FRAME_COUNT


def pan_gains(pan: float) -> tuple[float, float]:
    angle = (max(-1.0, min(1.0, pan)) + 1.0) * math.pi / 4.0
    return math.cos(angle), math.sin(angle)


def add_tone(
    channels: tuple[array, array],
    start: float,
    duration: float,
    frequency_start: float,
    frequency_end: float | None,
    amplitude: float,
    attack: float,
    decay: float,
    pan: float = 0.0,
    harmonic: float = 0.0,
) -> None:
    first = max(0, int(start * SAMPLE_RATE))
    count = min(int(duration * SAMPLE_RATE), FRAME_COUNT - first)
    if count <= 0:
        return
    left_gain, right_gain = pan_gains(pan)
    phase = 0.0
    end_frequency = frequency_start if frequency_end is None else frequency_end
    for offset in range(count):
        local_time = offset / SAMPLE_RATE
        progress = offset / max(1, count - 1)
        frequency = frequency_start + (end_frequency - frequency_start) * progress
        phase += TAU * frequency / SAMPLE_RATE
        attack_gain = min(1.0, local_time / max(attack, 1.0 / SAMPLE_RATE))
        release_gain = math.exp(-decay * local_time)
        sample = math.sin(phase)
        if harmonic:
            sample += harmonic * math.sin(phase * 2.01 + 0.35)
        sample *= amplitude * attack_gain * release_gain
        channels[0][first + offset] += sample * left_gain
        channels[1][first + offset] += sample * right_gain


def add_filtered_noise(
    channels: tuple[array, array],
    rng: random.Random,
    start: float,
    duration: float,
    amplitude: float,
    attack: float,
    decay: float,
    smoothing: float,
    pan: float = 0.0,
) -> None:
    first = max(0, int(start * SAMPLE_RATE))
    count = min(int(duration * SAMPLE_RATE), FRAME_COUNT - first)
    if count <= 0:
        return
    left_gain, right_gain = pan_gains(pan)
    low_pass = 0.0
    previous_low_pass = 0.0
    for offset in range(count):
        local_time = offset / SAMPLE_RATE
        white = rng.uniform(-1.0, 1.0)
        low_pass += smoothing * (white - low_pass)
        band = low_pass - previous_low_pass
        previous_low_pass += 0.12 * (low_pass - previous_low_pass)
        attack_gain = min(1.0, local_time / max(attack, 1.0 / SAMPLE_RATE))
        envelope = attack_gain * math.exp(-decay * local_time)
        sample = band * amplitude * envelope
        channels[0][first + offset] += sample * left_gain
        channels[1][first + offset] += sample * right_gain


def add_click(
    channels: tuple[array, array],
    rng: random.Random,
    at: float,
    body_hz: float,
    brightness: float,
    amplitude: float,
    pan: float,
    softness: float = 0.0,
) -> None:
    decay = 54.0 - softness * 18.0
    add_tone(
        channels, at, 0.075 + softness * 0.025, body_hz, body_hz * 0.82,
        amplitude, 0.0005 + softness * 0.0015, decay, pan, harmonic=0.24 * brightness,
    )
    add_tone(
        channels, at + 0.0015, 0.035, body_hz * (2.2 + brightness),
        body_hz * 1.7, amplitude * 0.34 * brightness, 0.0003, 105.0, pan,
    )
    add_filtered_noise(
        channels, rng, at, 0.028 + softness * 0.015,
        amplitude * (0.75 - softness * 0.28), 0.00025, 120.0 - softness * 30.0,
        0.18 - softness * 0.08, pan,
    )


def decelerating_ticks(
    start: float = 0.08,
    stop: float = 2.74,
    initial_interval: float = 0.050,
    growth: float = 1.075,
) -> list[float]:
    result: list[float] = []
    at = start
    interval = initial_interval
    while at < stop:
        result.append(at)
        at += interval
        interval = min(0.31, interval * growth)
    return result


def add_rotational_bed(
    channels: tuple[array, array],
    rng: random.Random,
    amplitude: float,
    tonal_hz: float,
    air: float,
    duration: float = 2.82,
) -> None:
    add_tone(channels, 0.0, duration, tonal_hz, tonal_hz * 0.38, amplitude, 0.025, 0.58, -0.18, 0.14)
    add_tone(channels, 0.0, duration, tonal_hz * 1.47, tonal_hz * 0.52, amplitude * 0.55, 0.04, 0.72, 0.20)
    add_filtered_noise(channels, rng, 0.0, duration + 0.02, air, 0.025, 0.78, 0.012, 0.0)


def final_stop(channels: tuple[array, array], rng: random.Random, at: float, body_hz: float, amplitude: float) -> None:
    add_click(channels, rng, at, body_hz, 0.55, amplitude, 0.0, softness=0.18)
    add_tone(channels, at + 0.008, 0.20, body_hz * 0.48, body_hz * 0.34, amplitude * 0.36, 0.002, 23.0, 0.0)


def candidate_classic() -> tuple[array, array]:
    channels = stereo_buffer()
    rng = random.Random(31001)
    add_rotational_bed(channels, rng, 0.095, 145.0, 0.20)
    ticks = decelerating_ticks(initial_interval=0.047, growth=1.073)
    for index, at in enumerate(ticks):
        progress = index / max(1, len(ticks) - 1)
        add_click(channels, rng, at, 760.0 - progress * 150.0, 0.58, 0.31 + progress * 0.10, (-0.22, 0.18)[index % 2])
    final_stop(channels, rng, 2.77, 610.0, 0.62)
    return channels


def candidate_wooden() -> tuple[array, array]:
    channels = stereo_buffer()
    rng = random.Random(31002)
    add_rotational_bed(channels, rng, 0.12, 105.0, 0.13)
    ticks = decelerating_ticks(initial_interval=0.055, growth=1.081)
    for index, at in enumerate(ticks):
        progress = index / max(1, len(ticks) - 1)
        add_click(channels, rng, at, 470.0 - progress * 75.0, 0.30, 0.38 + progress * 0.12, (-0.12, 0.12)[index % 2], softness=0.38)
        add_tone(channels, at + 0.002, 0.055, 225.0, 185.0, 0.10, 0.001, 42.0, 0.0)
    final_stop(channels, rng, 2.77, 430.0, 0.68)
    return channels


def candidate_arcade() -> tuple[array, array]:
    channels = stereo_buffer()
    rng = random.Random(31003)
    add_rotational_bed(channels, rng, 0.072, 185.0, 0.10)
    ticks = decelerating_ticks(initial_interval=0.050, growth=1.078)
    for index, at in enumerate(ticks):
        progress = index / max(1, len(ticks) - 1)
        pitch = 1_180.0 - progress * 480.0
        add_tone(channels, at, 0.050, pitch, pitch * 0.92, 0.24 + progress * 0.08, 0.0007, 72.0, (-0.25, 0.25)[index % 2], 0.16)
        add_filtered_noise(channels, rng, at, 0.018, 0.12, 0.0002, 150.0, 0.20, 0.0)
    add_tone(channels, 2.74, 0.23, 520.0, 390.0, 0.34, 0.002, 21.0, 0.0, 0.20)
    final_stop(channels, rng, 2.79, 560.0, 0.50)
    return channels


def candidate_premium() -> tuple[array, array]:
    channels = stereo_buffer()
    rng = random.Random(31004)
    add_rotational_bed(channels, rng, 0.065, 92.0, 0.09)
    ticks = decelerating_ticks(initial_interval=0.060, growth=1.084)
    for index, at in enumerate(ticks):
        progress = index / max(1, len(ticks) - 1)
        add_click(channels, rng, at, 610.0 - progress * 120.0, 0.24, 0.25 + progress * 0.08, (-0.16, 0.16)[index % 2], softness=0.65)
        add_tone(channels, at + 0.004, 0.08, 320.0, 270.0, 0.055, 0.003, 34.0, 0.0)
    add_tone(channels, 2.73, 0.25, 440.0, 330.0, 0.22, 0.004, 19.0, 0.0, 0.12)
    final_stop(channels, rng, 2.79, 480.0, 0.46)
    return channels


def candidate_tension() -> tuple[array, array]:
    channels = stereo_buffer()
    rng = random.Random(31005)
    add_rotational_bed(channels, rng, 0.13, 72.0, 0.15)
    ticks = decelerating_ticks(initial_interval=0.045, growth=1.071)
    for index, at in enumerate(ticks):
        progress = index / max(1, len(ticks) - 1)
        add_click(channels, rng, at, 680.0 - progress * 210.0, 0.43, 0.28 + progress * 0.17, (-0.30, 0.30)[index % 2], softness=0.20)
        if index >= len(ticks) - 5:
            add_tone(channels, at, 0.13, 125.0, 96.0, 0.09 + progress * 0.05, 0.002, 28.0, 0.0)
    add_tone(channels, 2.60, 0.34, 155.0, 78.0, 0.22, 0.01, 10.0, 0.0)
    final_stop(channels, rng, 2.78, 520.0, 0.65)
    return channels


def add_impact(channels: tuple[array, array], rng: random.Random, at: float, amount: float) -> None:
    add_tone(channels, at, 0.20, 108.0, 58.0, amount, 0.001, 19.0, 0.0, 0.08)
    add_filtered_noise(channels, rng, at, 0.055, amount * 0.78, 0.0004, 72.0, 0.075, 0.0)


def add_brass_note(
    channels: tuple[array, array],
    at: float,
    duration: float,
    frequency: float,
    amount: float,
    warmth: float,
    pan: float = 0.0,
) -> None:
    # A compact, copyright-free brass-like stack: strong fundamental, controlled
    # upper partials, and a tiny downward pitch settle instead of a harsh beep.
    partials = ((1.0, 1.0), (2.0, 0.34), (3.0, 0.17), (4.0, 0.07))
    for multiplier, level in partials:
        high_reduction = 1.0 - warmth * max(0.0, multiplier - 1.0) * 0.17
        add_tone(
            channels, at, duration, frequency * multiplier,
            frequency * multiplier * (0.982 - warmth * 0.006),
            amount * level * high_reduction, 0.006 + warmth * 0.004,
            4.4 + multiplier * 1.15, pan, harmonic=0.0,
        )


def add_two_hit_stinger(
    channels: tuple[array, array],
    rng: random.Random,
    first_hz: float,
    second_hz: float,
    start: float,
    warmth: float,
    amount: float,
    impact: float,
) -> None:
    add_brass_note(channels, start, 0.19, first_hz, amount * 0.82, warmth, -0.05)
    add_impact(channels, rng, start, impact * 0.68)
    second_at = start + 0.245
    add_brass_note(channels, second_at, 0.55, second_hz, amount, warmth, 0.04)
    add_brass_note(channels, second_at, 0.51, second_hz * 0.75, amount * 0.42, min(1.0, warmth + 0.12), -0.05)
    add_impact(channels, rng, second_at, impact)


def add_short_spin(
    channels: tuple[array, array],
    rng: random.Random,
    body_hz: float,
    brightness: float,
    softness: float,
    strength: float,
) -> None:
    add_rotational_bed(channels, rng, 0.075 + strength * 0.035, 108.0, 0.10 + brightness * 0.07, duration=2.14)
    ticks = decelerating_ticks(start=0.055, stop=2.08, initial_interval=0.047, growth=1.079)
    for index, at in enumerate(ticks):
        progress = index / max(1, len(ticks) - 1)
        add_click(
            channels, rng, at, body_hz - progress * 120.0, brightness,
            (0.22 + strength * 0.12) + progress * 0.08,
            (-0.18, 0.18)[index % 2], softness=softness,
        )
    add_click(channels, rng, 2.08, body_hz * 0.78, brightness * 0.80, 0.44 + strength * 0.12, 0.0, softness=softness)


def candidate_stinger_game_show() -> tuple[array, array]:
    channels = stereo_buffer()
    rng = random.Random(32001)
    add_short_spin(channels, rng, 650.0, 0.47, 0.28, 0.62)
    add_two_hit_stinger(channels, rng, 392.0, 523.25, 2.17, 0.38, 0.31, 0.24)
    return channels


def candidate_stinger_warm_fanfare() -> tuple[array, array]:
    channels = stereo_buffer()
    rng = random.Random(32002)
    add_short_spin(channels, rng, 510.0, 0.28, 0.52, 0.72)
    add_two_hit_stinger(channels, rng, 349.23, 466.16, 2.17, 0.72, 0.34, 0.28)
    add_tone(channels, 2.42, 0.47, 155.56, 146.83, 0.075, 0.012, 5.2, 0.0, 0.08)
    return channels


def candidate_stinger_bright_prize() -> tuple[array, array]:
    channels = stereo_buffer()
    rng = random.Random(32003)
    add_short_spin(channels, rng, 720.0, 0.50, 0.32, 0.52)
    add_two_hit_stinger(channels, rng, 440.0, 587.33, 2.16, 0.30, 0.27, 0.19)
    for delay, pitch, pan in ((0.00, 987.77, -0.25), (0.055, 1174.66, 0.20), (0.11, 1318.51, -0.05)):
        add_tone(channels, 2.48 + delay, 0.22, pitch, pitch * 0.94, 0.055, 0.001, 16.0, pan, 0.10)
    return channels


def candidate_stinger_cinematic() -> tuple[array, array]:
    channels = stereo_buffer()
    rng = random.Random(32004)
    add_short_spin(channels, rng, 580.0, 0.38, 0.25, 0.78)
    add_two_hit_stinger(channels, rng, 293.66, 392.0, 2.17, 0.66, 0.33, 0.34)
    add_tone(channels, 2.41, 0.52, 98.0, 65.0, 0.16, 0.004, 7.0, 0.0, 0.05)
    return channels


def candidate_stinger_cute_pop() -> tuple[array, array]:
    channels = stereo_buffer()
    rng = random.Random(32005)
    add_short_spin(channels, rng, 690.0, 0.36, 0.48, 0.44)
    add_two_hit_stinger(channels, rng, 493.88, 659.25, 2.17, 0.48, 0.25, 0.16)
    add_tone(channels, 2.42, 0.40, 1318.51, 1184.0, 0.045, 0.002, 12.0, 0.25, 0.08)
    return channels


def master(channels: tuple[array, array]) -> bytes:
    # Remove DC, apply a gentle low-frequency roll-off, soft-limit, and leave 1 dB headroom.
    processed: list[array] = []
    for channel in channels:
        mean = sum(channel) / len(channel)
        high_passed = array("d", [0.0]) * FRAME_COUNT
        previous_input = 0.0
        previous_output = 0.0
        coefficient = 0.9935
        for index, value in enumerate(channel):
            value -= mean
            output = coefficient * (previous_output + value - previous_input)
            high_passed[index] = math.tanh(output * 1.35) / math.tanh(1.35)
            previous_input = value
            previous_output = output
        fade_frames = int(SAMPLE_RATE * 0.08)
        for index in range(FRAME_COUNT - fade_frames, FRAME_COUNT):
            fade = (FRAME_COUNT - index - 1) / fade_frames
            high_passed[index] *= max(0.0, fade)
        processed.append(high_passed)
    peak = max(max(abs(value) for value in channel) for channel in processed)
    gain = (10 ** (-1.0 / 20.0)) / max(peak, 1e-9)
    interleaved = bytearray(FRAME_COUNT * 4)
    for index in range(FRAME_COUNT):
        left = int(max(-1.0, min(1.0, processed[0][index] * gain)) * 32767.0)
        right = int(max(-1.0, min(1.0, processed[1][index] * gain)) * 32767.0)
        struct.pack_into("<hh", interleaved, index * 4, left, right)
    return bytes(interleaved)


def write_wave(path: Path, channels: tuple[array, array]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as output:
        output.setnchannels(2)
        output.setsampwidth(2)
        output.setframerate(SAMPLE_RATE)
        output.writeframes(master(channels))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--edition", choices=("mechanical", "stinger"), default="stinger")
    args = parser.parse_args()
    if args.edition == "mechanical":
        candidates = [
            ("01_classic_mechanical", candidate_classic),
            ("02_warm_wooden", candidate_wooden),
            ("03_clean_arcade", candidate_arcade),
            ("04_soft_premium", candidate_premium),
            ("05_tension_ratchet", candidate_tension),
        ]
    else:
        candidates = [
            ("v2_01_game_show_stinger", candidate_stinger_game_show),
            ("v2_02_warm_fanfare", candidate_stinger_warm_fanfare),
            ("v2_03_bright_prize", candidate_stinger_bright_prize),
            ("v2_04_cinematic_win", candidate_stinger_cinematic),
            ("v2_05_cute_broadcast", candidate_stinger_cute_pop),
        ]
    for name, generator in candidates:
        path = args.output / f"byeollog_roulette_{name}_3s.wav"
        write_wave(path, generator())
        print(path.resolve())


if __name__ == "__main__":
    main()
