from __future__ import annotations

import argparse
import importlib.util
import os
from pathlib import Path

import numpy as np
import onnxruntime as ort
import unidic_lite


os.environ.setdefault("MECABRC", str(Path(unidic_lite.DICDIR) / "mecabrc"))

from g2pkk import G2p
from mecab import MeCab
from melo.api import TTS
from melo.utils import get_text_for_tts_infer
from transformers import AutoTokenizer


G2p.check_mecab = lambda self: None
G2p.get_mecab = lambda self: MeCab()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bert-model", type=Path, required=True)
    parser.add_argument("--validator", type=Path, required=True)
    args = parser.parse_args()
    spec = importlib.util.spec_from_file_location("byeollog_voice_validator", args.validator)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)

    text = "테스트 시청자님께 추첨권 두 장 드렸어요!"
    full_model = TTS(language="KR", device="cpu")
    original_bert, original_ja_bert, original_phone, original_tone, original_language = (
        get_text_for_tts_infer(text, "KR", full_model.hps, "cpu")
    )

    tokenizer = AutoTokenizer.from_pretrained(
        module.MODEL_ID,
        revision=module.MODEL_REVISION,
        local_files_only=True,
    )
    levels = [
        ("disabled", ort.GraphOptimizationLevel.ORT_DISABLE_ALL),
        ("basic", ort.GraphOptimizationLevel.ORT_ENABLE_BASIC),
        ("extended", ort.GraphOptimizationLevel.ORT_ENABLE_EXTENDED),
        ("all", ort.GraphOptimizationLevel.ORT_ENABLE_ALL),
    ]
    for level_name, level in levels:
        options = ort.SessionOptions()
        options.graph_optimization_level = level
        options.intra_op_num_threads = 1
        options.inter_op_num_threads = 1
        session = ort.InferenceSession(
            str(args.bert_model), options, providers=["CPUExecutionProvider"]
        )
        actual, _, _ = module.build_inputs(text, tokenizer, session)
        comparisons = {
            "phone": (original_phone.numpy(), actual["x"][0]),
            "tone": (original_tone.numpy(), actual["tone"][0]),
            "language": (original_language.numpy(), actual["language"][0]),
            "bert": (original_bert.numpy(), actual["bert"][0]),
            "ja_bert": (original_ja_bert.numpy(), actual["ja_bert"][0]),
        }
        for name, (expected, observed) in comparisons.items():
            if expected.shape != observed.shape:
                print(f"{level_name}/{name}: shape mismatch {expected.shape}/{observed.shape}")
                continue
            difference = np.abs(expected.astype(np.float32) - observed.astype(np.float32))
            print(
                f"{level_name}/{name}: shape={expected.shape} "
                f"exact={np.array_equal(expected, observed)} "
                f"mean={float(np.mean(difference)):.9f} "
                f"max={float(np.max(difference)):.9f}"
            )
            if level_name == "disabled" and name == "ja_bert":
                for decimals in (6, 5, 4, 3, 2, 1, 0):
                    expected_rounded = np.round(expected, decimals=decimals)
                    observed_rounded = np.round(observed, decimals=decimals)
                    mismatch = int(np.count_nonzero(expected_rounded != observed_rounded))
                    print(
                        f"rounded/{decimals}: mismatches={mismatch}/"
                        f"{expected_rounded.size}"
                    )


if __name__ == "__main__":
    main()
