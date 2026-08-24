from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path

import librosa
import numpy as np
import onnxruntime as ort
import soundfile as sf
import torch
import unidic_lite


os.environ.setdefault("MECABRC", str(Path(unidic_lite.DICDIR) / "mecabrc"))

from g2pkk import G2p
from mecab import MeCab
from melo import commons
from melo.text import cleaned_text_to_sequence
from melo.text.cleaner import clean_text
from transformers import AutoTokenizer


G2p.check_mecab = lambda self: None
G2p.get_mecab = lambda self: MeCab()

MODEL_ID = "kykim/bert-kor-base"
MODEL_REVISION = "1779cc0982ada0216dd6de0dd4e86fb78201926d"
SAMPLE_RATE = 44_100


def scalar(value: float) -> np.ndarray:
    return np.asarray(value, dtype=np.float32)


def estimate_pitch_hz(audio: np.ndarray) -> float:
    f0, voiced_flag, _ = librosa.pyin(
        audio,
        fmin=librosa.note_to_hz("C2"),
        fmax=librosa.note_to_hz("C6"),
        sr=SAMPLE_RATE,
    )
    voiced = f0[np.logical_and(np.isfinite(f0), voiced_flag)]
    return float(np.median(voiced)) if voiced.size else 200.0


def accepted_pitch_shift(audio: np.ndarray, extra_hz: float = 29.0) -> tuple[np.ndarray, dict[str, float]]:
    source_pitch = estimate_pitch_hz(audio)
    target_pitch = source_pitch + extra_hz
    semitones = 12.0 * math.log2(target_pitch / source_pitch)
    shifted = librosa.effects.pitch_shift(
        audio,
        sr=SAMPLE_RATE,
        n_steps=semitones,
        res_type="kaiser_best",
    )
    peak = float(np.max(np.abs(shifted))) if shifted.size else 0.0
    if peak > 0:
        shifted = shifted * (0.92 / peak)
    return shifted.astype(np.float32), {
        "sourcePitchHz": round(source_pitch, 2),
        "targetPitchHz": round(target_pitch, 2),
        "pitchShiftSemitones": round(semitones, 3),
    }


def build_inputs(
    text: str,
    tokenizer: AutoTokenizer,
    bert_runner,
    noise_scale: float = 0.50,
    noise_scale_w: float = 0.64,
    sdp_ratio: float = 0.30,
    context_decimals: int | None = None,
):
    normalized, phones, tones, word2ph = clean_text(text, "KR")
    phone_ids, tone_ids, language_ids = cleaned_text_to_sequence(phones, tones, "KR")
    phone_ids = commons.intersperse(phone_ids, 0)
    tone_ids = commons.intersperse(tone_ids, 0)
    language_ids = commons.intersperse(language_ids, 0)
    word2ph = [value * 2 for value in word2ph]
    word2ph[0] += 1

    encoded = tokenizer(normalized, return_tensors="np")
    feeds = {
        name: encoded[name].astype(np.int64)
        for name in ("input_ids", "attention_mask", "token_type_ids")
    }
    token_context = bert_runner(feeds)[0]
    if context_decimals is not None:
        token_context = np.round(token_context, decimals=context_decimals)
    if token_context.shape[0] != len(word2ph):
        raise RuntimeError(f"BERT/token alignment mismatch: {token_context.shape[0]}/{len(word2ph)}")
    phone_context = np.concatenate(
        [np.repeat(token_context[index : index + 1], count, axis=0) for index, count in enumerate(word2ph)],
        axis=0,
    )
    if phone_context.shape[0] != len(phone_ids):
        raise RuntimeError(f"BERT/phone alignment mismatch: {phone_context.shape[0]}/{len(phone_ids)}")

    length = len(phone_ids)
    return {
        "x": np.asarray([phone_ids], dtype=np.int64),
        "x_lengths": np.asarray([length], dtype=np.int64),
        "sid": np.asarray([0], dtype=np.int64),
        "tone": np.asarray([tone_ids], dtype=np.int64),
        "language": np.asarray([language_ids], dtype=np.int64),
        "bert": np.zeros((1, 1024, length), dtype=np.float32),
        "ja_bert": phone_context.T[np.newaxis, :, :].astype(np.float32),
        "noise_scale": scalar(noise_scale),
        "length_scale": scalar(1.0 / 1.25),
        "noise_scale_w": scalar(noise_scale_w),
        "sdp_ratio": scalar(sdp_ratio),
    }, normalized, tokenizer.tokenize(normalized)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bert-model", type=Path, required=True)
    parser.add_argument("--tts-model", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--noise-scale", type=float, default=0.50)
    parser.add_argument("--noise-scale-w", type=float, default=0.64)
    parser.add_argument("--sdp-ratio", type=float, default=0.30)
    parser.add_argument("--controlled-seed", type=int, default=20261325)
    parser.add_argument("--noise-fixture", type=Path)
    parser.add_argument("--context-decimals", type=int)
    parser.add_argument("--bert-training-mode", action="store_true")
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)

    tokenizer = AutoTokenizer.from_pretrained(
        MODEL_ID,
        revision=MODEL_REVISION,
        local_files_only=True,
    )
    if args.bert_model.suffix.lower() in {".pt", ".pth", ".torchscript"}:
        bert_model = torch.jit.load(str(args.bert_model), map_location="cpu")
        bert_model.train(args.bert_training_mode)

        def bert_runner(feeds):
            with torch.inference_mode():
                torch.manual_seed(args.controlled_seed)
                return bert_model(
                    torch.from_numpy(feeds["input_ids"]),
                    torch.from_numpy(feeds["attention_mask"]),
                    torch.from_numpy(feeds["token_type_ids"]),
                ).cpu().numpy()

    else:
        bert_session = ort.InferenceSession(
            str(args.bert_model), providers=["CPUExecutionProvider"]
        )

        def bert_runner(feeds):
            return bert_session.run(["context"], feeds)[0]
    tts_session = ort.InferenceSession(str(args.tts_model), providers=["CPUExecutionProvider"])
    tts_inputs = {item.name: item for item in tts_session.get_inputs()}
    tts_input_names = set(tts_inputs)
    phrases = {
        "ticket_korean": "테스트 시청자님께 추첨권 두 장 드렸어요!",
        "ticket_latin": "지 에이 에이치 디 에이치 님께 추첨권 백 서른다섯 장 드렸어요!",
        "winner": "테스트 시청자님, 당첨을 축하드려요!",
    }
    results = []
    for phrase_index, (name, text) in enumerate(phrases.items()):
        feeds, normalized, tokens = build_inputs(
            text,
            tokenizer,
            bert_runner,
            args.noise_scale,
            args.noise_scale_w,
            args.sdp_ratio,
            args.context_decimals,
        )
        if "tones" in tts_input_names and "tone" in feeds:
            feeds["tones"] = feeds.pop("tone")
        if "duration_noise" in tts_input_names:
            fixture = None
            if args.noise_fixture and phrase_index == 0:
                fixture = np.load(args.noise_fixture)
                feeds["duration_noise"] = fixture["duration_noise"].astype(np.float32)
            else:
                torch.manual_seed(args.controlled_seed + phrase_index)
                text_length = int(feeds["x"].shape[1])
                feeds["duration_noise"] = torch.randn(
                    (1, 2, text_length), dtype=torch.float32
                ).numpy()
            # First determine the decoder frame count.  The temporary values do
            # not advance the PyTorch generator that reproduces the reference
            # MeloTTS random stream.
            feeds["latent_noise"] = np.zeros((1, 192, 4096), dtype=np.float32)
            probe_feeds = {
                key: value for key, value in feeds.items() if key in tts_input_names
            }
            for key, value in list(probe_feeds.items()):
                if len(tts_inputs[key].shape) == 1 and value.ndim == 0:
                    probe_feeds[key] = value.reshape(1)
            probe_audio = tts_session.run(None, probe_feeds)[0]
            if probe_audio.shape[-1] % 512 != 0:
                raise RuntimeError(
                    f"Unexpected Melo decoder length: {probe_audio.shape[-1]}"
                )
            frame_count = int(probe_audio.shape[-1] // 512)
            if fixture is not None:
                feeds["latent_noise"] = fixture["latent_noise"].astype(np.float32)
                if feeds["latent_noise"].shape[2] != frame_count:
                    raise RuntimeError(
                        "Noise fixture duration changed after BERT inference: "
                        f"{feeds['latent_noise'].shape[2]}/{frame_count}"
                    )
            else:
                feeds["latent_noise"] = torch.randn(
                    (1, 192, frame_count), dtype=torch.float32
                ).numpy()
        feeds = {key: value for key, value in feeds.items() if key in tts_input_names}
        for key, value in list(feeds.items()):
            expected_rank = len(tts_inputs[key].shape)
            if expected_rank == 1 and value.ndim == 0:
                feeds[key] = value.reshape(1)
        missing = sorted(tts_input_names.difference(feeds))
        if missing:
            raise RuntimeError(f"Missing TTS inputs: {missing}")
        audio = tts_session.run(None, feeds)[0].reshape(-1).astype(np.float32)
        raw_path = args.output_dir / f"{name}_raw.wav"
        sf.write(raw_path, audio, SAMPLE_RATE, subtype="PCM_16")
        processed, pitch = accepted_pitch_shift(audio)
        output_path = args.output_dir / f"{name}_int8_bert_speed25_pitch29hz.wav"
        sf.write(output_path, processed, SAMPLE_RATE, subtype="PCM_16")
        results.append(
            {
                "file": output_path.name,
                "rawFile": raw_path.name,
                "text": text,
                "normalized": normalized,
                "tokens": tokens,
                "durationSeconds": round(len(processed) / SAMPLE_RATE, 3),
                "bytes": output_path.stat().st_size,
                **pitch,
            }
        )
    manifest = {
        "bertModel": str(args.bert_model),
        "ttsModel": str(args.tts_model),
        "speedPercent": 25,
        "pitchExtraHz": 29,
        "results": results,
    }
    (args.output_dir / "validation.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
