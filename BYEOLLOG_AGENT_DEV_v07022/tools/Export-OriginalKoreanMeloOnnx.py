#!/usr/bin/env python3
"""Export the original cached Korean MeloTTS checkpoint to ONNX.

This deliberately keeps both contextual embedding inputs.  Korean MeloTTS
routes kyykim/bert-kor-base features through ``ja_bert``; replacing that input
with zeros (as some generic MeloTTS exporters do) corrupts pronunciation.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

import numpy as np
import onnx
import torch
import unidic_lite
from g2pkk import G2p
from mecab import MeCab

# g2pkk 0.1.2 still looks for the obsolete Windows-only eunjeon package.
# The validated prototype uses the API-compatible python-mecab-ko wheel.
os.environ.setdefault("MECABRC", str(Path(unidic_lite.DICDIR) / "mecabrc"))
G2p.check_mecab = lambda self: None
G2p.get_mecab = lambda self: MeCab()

from melo import utils
from melo import commons
from melo.api import TTS


class KoreanMeloWrapper(torch.nn.Module):
    def __init__(self, tts: TTS):
        super().__init__()
        self.model = tts.model

    def forward(
        self,
        x: torch.Tensor,
        x_lengths: torch.Tensor,
        sid: torch.Tensor,
        tones: torch.Tensor,
        language: torch.Tensor,
        bert: torch.Tensor,
        ja_bert: torch.Tensor,
        duration_noise: torch.Tensor,
        latent_noise: torch.Tensor,
        noise_scale: torch.Tensor,
        length_scale: torch.Tensor,
        noise_scale_w: torch.Tensor,
        sdp_ratio: torch.Tensor,
    ) -> torch.Tensor:
        g = self.model.emb_g(sid).unsqueeze(-1)
        g_p = None if self.model.use_vc else g
        encoded, m_p, logs_p, x_mask = self.model.enc_p(
            x, x_lengths, tones, language, bert, ja_bert, g=g_p
        )

        # StochasticDurationPredictor.forward(reverse=True), except the random
        # tensor is caller-owned.  This prevents runtime-specific RNG behavior
        # from turning the same Korean phones into unstable durations.
        predictor = self.model.sdp
        duration_x = torch.detach(encoded)
        duration_x = predictor.pre(duration_x)
        duration_x = duration_x + predictor.cond(torch.detach(g))
        duration_x = predictor.convs(duration_x, x_mask)
        duration_x = predictor.proj(duration_x) * x_mask
        z = duration_noise * noise_scale_w
        flows = list(reversed(predictor.flows))
        flows = flows[:-2] + [flows[-1]]
        for flow in flows:
            z = flow(z, x_mask, g=duration_x, reverse=True)
        logw_sdp, _ = torch.split(z, [1, 1], 1)

        logw = logw_sdp * sdp_ratio + self.model.dp(encoded, x_mask, g=g) * (
            1 - sdp_ratio
        )
        durations = torch.exp(logw) * x_mask * length_scale
        durations = torch.ceil(durations)
        y_lengths = torch.clamp_min(torch.sum(durations, [1, 2]), 1).long()
        y_mask = torch.unsqueeze(commons.sequence_mask(y_lengths, None), 1).to(
            x_mask.dtype
        )
        attention_mask = torch.unsqueeze(x_mask, 2) * torch.unsqueeze(y_mask, -1)
        attention = commons.generate_path(durations, attention_mask)

        m_p = torch.matmul(attention.squeeze(1), m_p.transpose(1, 2)).transpose(1, 2)
        logs_p = torch.matmul(
            attention.squeeze(1), logs_p.transpose(1, 2)
        ).transpose(1, 2)
        controlled_noise = latent_noise[:, :, : m_p.size(2)]
        z_p = m_p + controlled_noise * torch.exp(logs_p) * noise_scale
        z = self.model.flow(z_p, y_mask, g=g, reverse=True)
        return self.model.dec(z * y_mask, g=g)


def add_metadata(path: Path, values: dict[str, object]) -> None:
    model = onnx.load(str(path))
    del model.metadata_props[:]
    for key, value in values.items():
        item = model.metadata_props.add()
        item.key = key
        item.value = str(value)
    onnx.save(model, str(path))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--text", default="테스트 시청자님께 추첨권 두 장 드렸어요!")
    parser.add_argument("--opset", default=18, type=int)
    args = parser.parse_args()

    torch.manual_seed(20260824)
    np.random.seed(20260824)
    torch.set_num_threads(max(1, min(4, os.cpu_count() or 1)))

    tts = TTS(language="KR", device="cpu")
    tts.eval()
    bert, ja_bert, phones, tones, language = utils.get_text_for_tts_infer(
        args.text,
        "KR",
        tts.hps,
        "cpu",
        tts.symbol_to_id,
    )

    x = phones.unsqueeze(0)
    x_lengths = torch.tensor([phones.numel()], dtype=torch.int64)
    sid = torch.tensor([0], dtype=torch.int64)
    tones = tones.unsqueeze(0)
    language = language.unsqueeze(0)
    bert = bert.unsqueeze(0).to(torch.float32)
    ja_bert = ja_bert.unsqueeze(0).to(torch.float32)
    duration_noise = torch.randn((1, 2, phones.numel()), dtype=torch.float32)
    latent_noise = torch.randn((1, 192, 4096), dtype=torch.float32)
    noise_scale = torch.tensor([0.6], dtype=torch.float32)
    length_scale = torch.tensor([1.0 / 1.25], dtype=torch.float32)
    noise_scale_w = torch.tensor([0.8], dtype=torch.float32)
    sdp_ratio = torch.tensor([0.2], dtype=torch.float32)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    wrapper = KoreanMeloWrapper(tts).eval()
    with torch.inference_mode():
        torch.onnx.export(
            wrapper,
            (
                x,
                x_lengths,
                sid,
                tones,
                language,
                bert,
                ja_bert,
                duration_noise,
                latent_noise,
                noise_scale,
                length_scale,
                noise_scale_w,
                sdp_ratio,
            ),
            str(args.output),
            opset_version=args.opset,
            do_constant_folding=True,
            input_names=[
                "x",
                "x_lengths",
                "sid",
                "tones",
                "language",
                "bert",
                "ja_bert",
                "duration_noise",
                "latent_noise",
                "noise_scale",
                "length_scale",
                "noise_scale_w",
                "sdp_ratio",
            ],
            output_names=["audio"],
            dynamic_axes={
                "x": {0: "batch", 1: "text_length"},
                "x_lengths": {0: "batch"},
                "sid": {0: "batch"},
                "tones": {0: "batch", 1: "text_length"},
                "language": {0: "batch", 1: "text_length"},
                "bert": {0: "batch", 2: "text_length"},
                "ja_bert": {0: "batch", 2: "text_length"},
                "duration_noise": {0: "batch", 2: "text_length"},
                "latent_noise": {0: "batch", 2: "noise_length"},
                "audio": {0: "batch", 2: "audio_length"},
            },
            dynamo=False,
        )

    add_metadata(
        args.output,
        {
            "model_type": "byeollog-original-korean-melotts",
            "language": "KR",
            "sample_rate": int(tts.hps.data.sampling_rate),
            "add_blank": int(tts.hps.data.add_blank),
            "bert_dim": 1024,
            "ja_bert_dim": 768,
            "speaker_id": 0,
            "source": "myshell-ai/MeloTTS Korean checkpoint",
        },
    )
    onnx.checker.check_model(str(args.output))

    manifest = {
        "output": str(args.output.resolve()),
        "bytes": args.output.stat().st_size,
        "sampleRate": int(tts.hps.data.sampling_rate),
        "phoneCount": int(phones.numel()),
        "text": args.text,
    }
    args.output.with_suffix(args.output.suffix + ".json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(json.dumps(manifest, ensure_ascii=False))


if __name__ == "__main__":
    main()
