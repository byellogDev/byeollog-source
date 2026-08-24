#!/usr/bin/env python3
"""Compare deterministic original Korean MeloTTS and its ONNX export."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

import numpy as np
import onnxruntime as ort
import librosa
import soundfile as sf
import torch
import unidic_lite
from g2pkk import G2p
from mecab import MeCab
from unittest.mock import patch

os.environ.setdefault("MECABRC", str(Path(unidic_lite.DICDIR) / "mecabrc"))
G2p.check_mecab = lambda self: None
G2p.get_mecab = lambda self: MeCab()

from melo import utils
from melo.api import TTS


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True, type=Path)
    parser.add_argument("--text", default="테스트 시청자님께 추첨권 두 장 드렸어요!")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--noise-fixture", type=Path)
    parser.add_argument("--sdp-ratio", type=float, default=0.3)
    args = parser.parse_args()

    torch.manual_seed(7)
    np.random.seed(7)
    tts = TTS(language="KR", device="cpu").eval()
    bert, ja_bert, phones, tones, language = utils.get_text_for_tts_infer(
        args.text, "KR", tts.hps, "cpu", tts.symbol_to_id
    )
    x = phones.unsqueeze(0)
    x_lengths = torch.tensor([phones.numel()], dtype=torch.int64)
    sid = torch.tensor([0], dtype=torch.int64)
    tones = tones.unsqueeze(0)
    language = language.unsqueeze(0)
    bert = bert.unsqueeze(0).to(torch.float32)
    ja_bert = ja_bert.unsqueeze(0).to(torch.float32)

    session = ort.InferenceSession(str(args.model), providers=["CPUExecutionProvider"])
    input_names = {item.name for item in session.get_inputs()}
    feeds = {
            "x": x.numpy(),
            "x_lengths": x_lengths.numpy(),
            "sid": sid.numpy(),
            "tones": tones.numpy(),
            "language": language.numpy(),
            "bert": bert.numpy(),
            "ja_bert": ja_bert.numpy(),
            "noise_scale": np.asarray([0.5], dtype=np.float32),
            "length_scale": np.asarray([0.8], dtype=np.float32),
            "noise_scale_w": np.asarray([0.64], dtype=np.float32),
            "sdp_ratio": np.asarray([args.sdp_ratio], dtype=np.float32),
    }

    captured_randn: list[torch.Tensor] = []
    captured_randn_like: list[torch.Tensor] = []
    real_randn = torch.randn
    real_randn_like = torch.randn_like

    def capture_randn(*values, **kwargs):
        result = real_randn(*values, **kwargs)
        captured_randn.append(result.detach().cpu().clone())
        return result

    def capture_randn_like(*values, **kwargs):
        result = real_randn_like(*values, **kwargs)
        captured_randn_like.append(result.detach().cpu().clone())
        return result

    torch.manual_seed(20261325)
    with torch.inference_mode(), patch("torch.randn", side_effect=capture_randn), patch(
        "torch.randn_like", side_effect=capture_randn_like
    ):
        expected = tts.model.infer(
            x,
            x_lengths,
            sid,
            tones,
            language,
            bert,
            ja_bert,
            noise_scale=0.5,
            length_scale=0.8,
            noise_scale_w=0.64,
            sdp_ratio=args.sdp_ratio,
        )[0].cpu().numpy()

    if "duration_noise" in input_names:
        if len(captured_randn) != 1 or len(captured_randn_like) != 1:
            raise RuntimeError(
                f"unexpected Melo noise calls: {len(captured_randn)}/{len(captured_randn_like)}"
            )
        feeds["duration_noise"] = captured_randn[0].numpy()
        feeds["latent_noise"] = captured_randn_like[0].numpy()
        if args.noise_fixture:
            args.noise_fixture.parent.mkdir(parents=True, exist_ok=True)
            np.savez_compressed(
                args.noise_fixture,
                duration_noise=feeds["duration_noise"],
                latent_noise=feeds["latent_noise"],
            )

    actual = session.run(["audio"], feeds)[0]

    if expected.shape != actual.shape:
        raise RuntimeError(f"shape mismatch: {expected.shape} != {actual.shape}")
    delta = np.abs(expected - actual)
    result = {
        "shape": list(actual.shape),
        "meanAbsoluteError": float(delta.mean()),
        "maxAbsoluteError": float(delta.max()),
        "referencePeak": float(np.abs(expected).max()),
        "exportPeak": float(np.abs(actual).max()),
    }
    print(json.dumps(result, ensure_ascii=False))
    if result["meanAbsoluteError"] > 1e-4 or result["maxAbsoluteError"] > 1e-2:
        raise RuntimeError(f"export parity failed: {result}")
    if args.output:
        audio = actual.reshape(-1).astype(np.float32)
        f0, voiced, _ = librosa.pyin(
            audio,
            fmin=librosa.note_to_hz("C2"),
            fmax=librosa.note_to_hz("C6"),
            sr=44_100,
        )
        voiced_f0 = f0[np.logical_and(np.isfinite(f0), voiced)]
        source_pitch = float(np.median(voiced_f0)) if voiced_f0.size else 220.0
        semitones = 12.0 * np.log2((source_pitch + 29.0) / source_pitch)
        audio = librosa.effects.pitch_shift(
            audio, sr=44_100, n_steps=float(semitones), res_type="kaiser_best"
        ).astype(np.float32)
        peak = float(np.max(np.abs(audio))) if audio.size else 0.0
        if peak > 0:
            audio *= 0.92 / peak
        args.output.parent.mkdir(parents=True, exist_ok=True)
        sf.write(args.output, audio, 44_100, subtype="PCM_16")


if __name__ == "__main__":
    main()
