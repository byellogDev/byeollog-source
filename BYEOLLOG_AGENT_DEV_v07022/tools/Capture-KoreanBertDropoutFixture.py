from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
from unittest.mock import patch

import numpy as np
import torch
import unidic_lite
from g2pkk import G2p
from mecab import MeCab


os.environ.setdefault("MECABRC", str(Path(unidic_lite.DICDIR) / "mecabrc"))
G2p.check_mecab = lambda self: None
G2p.get_mecab = lambda self: MeCab()

from melo import utils
from melo.api import TTS
from melo.text import japanese_bert
from transformers import AutoModelForMaskedLM


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--text", default="테스트 시청자님께 추첨권 두 장 드렸어요!"
    )
    parser.add_argument("--initial-seed", type=int, default=7)
    args = parser.parse_args()

    torch.manual_seed(args.initial_seed)
    np.random.seed(args.initial_seed)
    tts = TTS(language="KR", device="cpu").eval()
    real_from_pretrained = AutoModelForMaskedLM.from_pretrained
    captured: dict[str, torch.Tensor] = {}

    def load_and_instrument(*values, **kwargs):
        model = real_from_pretrained(*values, **kwargs)

        def before_forward(_module, _inputs):
            captured["rng_state"] = torch.get_rng_state().cpu().clone()

        def after_forward(_module, _inputs, output):
            captured["token_context"] = (
                output.hidden_states[-3][0].detach().cpu().clone()
            )

        model.register_forward_pre_hook(before_forward)
        model.register_forward_hook(after_forward)
        return model

    japanese_bert.models.clear()
    japanese_bert.tokenizers.clear()
    with patch.object(
        japanese_bert.AutoModelForMaskedLM,
        "from_pretrained",
        side_effect=load_and_instrument,
    ):
        _bert, ja_bert, phones, _tones, _language = utils.get_text_for_tts_infer(
            args.text,
            "KR",
            tts.hps,
            "cpu",
            tts.symbol_to_id,
        )

    if "rng_state" not in captured or "token_context" not in captured:
        raise RuntimeError("Original Korean BERT inference was not captured.")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(
        args.output,
        rng_state=captured["rng_state"].numpy(),
        token_context=captured["token_context"].numpy(),
        phone_context=ja_bert.numpy(),
        phones=phones.numpy(),
    )
    print(
        json.dumps(
            {
                "file": str(args.output),
                "bytes": args.output.stat().st_size,
                "sha256": sha256(args.output),
                "initialSeed": args.initial_seed,
                "rngStateBytes": int(captured["rng_state"].numel()),
                "tokenContextShape": list(captured["token_context"].shape),
                "phoneContextShape": list(ja_bert.shape),
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    main()
