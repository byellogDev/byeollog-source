from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path

import torch
from transformers import AutoModelForMaskedLM, AutoTokenizer


MODEL_ID = "kykim/bert-kor-base"
MODEL_REVISION = "1779cc0982ada0216dd6de0dd4e86fb78201926d"


class KoreanBertContext(torch.nn.Module):
    def __init__(self, model: torch.nn.Module) -> None:
        super().__init__()
        self.model = model

    def forward(
        self,
        input_ids: torch.Tensor,
        attention_mask: torch.Tensor,
        token_type_ids: torch.Tensor,
    ) -> torch.Tensor:
        result = self.model(
            input_ids=input_ids,
            attention_mask=attention_mask,
            token_type_ids=token_type_ids,
            output_hidden_states=True,
            return_dict=False,
        )
        # return_dict=False result layout is (logits, hidden_states).
        return result[1][-3]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument(
        "--text", default="테스트 시청자님께 추첨권 두 장 드렸어요!"
    )
    parser.add_argument(
        "--preserve-inference-dropout",
        action="store_true",
        help=(
            "Preserve the upstream MeloTTS Korean frontend behavior. Its BERT "
            "model remains in training mode during inference, so dropout must "
            "remain active for pronunciation parity."
        ),
    )
    args = parser.parse_args()

    torch.manual_seed(20260824)
    torch.set_num_threads(max(1, min(4, os.cpu_count() or 1)))
    tokenizer = AutoTokenizer.from_pretrained(
        MODEL_ID,
        revision=MODEL_REVISION,
        local_files_only=True,
    )
    model = AutoModelForMaskedLM.from_pretrained(
        MODEL_ID,
        revision=MODEL_REVISION,
        local_files_only=True,
    )
    if args.preserve_inference_dropout:
        model.train()
    else:
        model.eval()
    wrapper = KoreanBertContext(model)
    wrapper.train(args.preserve_inference_dropout)
    encoded = tokenizer(args.text, return_tensors="pt")
    inputs = (
        encoded["input_ids"],
        encoded["attention_mask"],
        encoded["token_type_ids"],
    )

    with torch.inference_mode():
        torch.manual_seed(20261325)
        expected = wrapper(*inputs)
        traced = torch.jit.trace(
            wrapper,
            inputs,
            strict=True,
            check_trace=not args.preserve_inference_dropout,
        )
        if args.preserve_inference_dropout:
            traced.train()
        else:
            traced = torch.jit.freeze(traced.eval())
        torch.manual_seed(20261325)
        actual = traced(*inputs)

    delta = torch.abs(expected - actual)
    max_error = float(delta.max().item())
    mean_error = float(delta.mean().item())
    if max_error > 1e-7:
        raise RuntimeError(
            f"TorchScript parity failed: mean={mean_error}, max={max_error}"
        )

    args.output.parent.mkdir(parents=True, exist_ok=True)
    torch.jit.save(traced, str(args.output))
    loaded = torch.jit.load(str(args.output), map_location="cpu")
    loaded.train(args.preserve_inference_dropout)
    with torch.inference_mode():
        torch.manual_seed(20261325)
        reloaded = loaded(*inputs)
    reload_delta = torch.abs(expected - reloaded)
    reload_max_error = float(reload_delta.max().item())
    reload_mean_error = float(reload_delta.mean().item())
    if reload_max_error > 1e-7:
        raise RuntimeError(
            "Reloaded TorchScript parity failed: "
            f"mean={reload_mean_error}, max={reload_max_error}"
        )

    print(
        json.dumps(
            {
                "model": MODEL_ID,
                "revision": MODEL_REVISION,
                "inferenceDropout": args.preserve_inference_dropout,
                "file": str(args.output),
                "bytes": args.output.stat().st_size,
                "sha256": sha256(args.output),
                "meanAbsoluteError": reload_mean_error,
                "maxAbsoluteError": reload_max_error,
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    main()
