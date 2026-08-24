from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
import torch
from onnxruntime.quantization import QuantType, quantize_dynamic
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
            return_dict=True,
        )
        # MeloTTS Korean uses hidden_states[-3], i.e. encoder layer 10 of the
        # 12-layer BERT model. Later layers and the masked-LM head are pruned
        # from the exported graph because they do not contribute to this output.
        return result.hidden_states[-3]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--text", default="테스트 시청자님께 추첨권 두 장 드렸어요!")
    args = parser.parse_args()

    args.output_dir.mkdir(parents=True, exist_ok=True)
    fp32_path = args.output_dir / "byeollog_ko_bert_context_fp32.onnx"
    int8_path = args.output_dir / "byeollog_ko_bert_context_int8.onnx"
    vocab_path = args.output_dir / "byeollog_ko_bert_vocab.txt"

    tokenizer = AutoTokenizer.from_pretrained(
        MODEL_ID,
        revision=MODEL_REVISION,
        local_files_only=True,
    )
    model = AutoModelForMaskedLM.from_pretrained(
        MODEL_ID,
        revision=MODEL_REVISION,
        local_files_only=True,
    ).eval()
    wrapper = KoreanBertContext(model).eval()
    encoded = tokenizer(args.text, return_tensors="pt")

    with torch.no_grad():
        expected = wrapper(
            encoded["input_ids"],
            encoded["attention_mask"],
            encoded["token_type_ids"],
        ).cpu().numpy()

    torch.onnx.export(
        wrapper,
        (
            encoded["input_ids"],
            encoded["attention_mask"],
            encoded["token_type_ids"],
        ),
        str(fp32_path),
        input_names=["input_ids", "attention_mask", "token_type_ids"],
        output_names=["context"],
        dynamic_axes={
            "input_ids": {1: "sequence"},
            "attention_mask": {1: "sequence"},
            "token_type_ids": {1: "sequence"},
            "context": {1: "sequence"},
        },
        opset_version=17,
        do_constant_folding=True,
        dynamo=False,
    )
    onnx.checker.check_model(onnx.load(str(fp32_path)))

    quantize_dynamic(
        model_input=str(fp32_path),
        model_output=str(int8_path),
        weight_type=QuantType.QInt8,
        per_channel=True,
        reduce_range=False,
    )
    onnx.checker.check_model(onnx.load(str(int8_path)))

    vocabulary = tokenizer.get_vocab()
    ordered_vocab = [None] * len(vocabulary)
    for token, token_id in vocabulary.items():
        ordered_vocab[token_id] = token
    if any(token is None for token in ordered_vocab):
        raise RuntimeError("Tokenizer vocabulary IDs are not contiguous.")
    vocab_path.write_bytes(("\n".join(ordered_vocab) + "\n").encode("utf-8"))

    feeds = {
        name: encoded[name].cpu().numpy().astype(np.int64)
        for name in ("input_ids", "attention_mask", "token_type_ids")
    }
    fp32_actual = ort.InferenceSession(
        str(fp32_path), providers=["CPUExecutionProvider"]
    ).run(["context"], feeds)[0]
    int8_actual = ort.InferenceSession(
        str(int8_path), providers=["CPUExecutionProvider"]
    ).run(["context"], feeds)[0]
    fp32_error = float(np.max(np.abs(expected - fp32_actual)))
    int8_mean_error = float(np.mean(np.abs(expected - int8_actual)))
    int8_max_error = float(np.max(np.abs(expected - int8_actual)))
    if fp32_error > 1e-3:
        raise RuntimeError(f"FP32 export parity failed: {fp32_error}")
    if int8_mean_error > 0.055 or int8_max_error > 0.75:
        raise RuntimeError(
            f"INT8 export parity failed: mean={int8_mean_error}, max={int8_max_error}"
        )

    result = {
        "model": MODEL_ID,
        "revision": MODEL_REVISION,
        "hiddenState": -3,
        "sampleText": args.text,
        "tokens": tokenizer.tokenize(args.text),
        "inputIds": encoded["input_ids"][0].tolist(),
        "fp32": {
            "file": fp32_path.name,
            "bytes": fp32_path.stat().st_size,
            "sha256": sha256(fp32_path),
            "maxAbsoluteError": fp32_error,
        },
        "int8": {
            "file": int8_path.name,
            "bytes": int8_path.stat().st_size,
            "sha256": sha256(int8_path),
            "meanAbsoluteError": int8_mean_error,
            "maxAbsoluteError": int8_max_error,
        },
        "vocabulary": {
            "file": vocab_path.name,
            "bytes": vocab_path.stat().st_size,
            "sha256": sha256(vocab_path),
            "tokens": len(ordered_vocab),
        },
    }
    manifest_path = args.output_dir / "byeollog_ko_bert_export.json"
    manifest_path.write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    main()
