from __future__ import annotations

import hashlib
import hmac
import io
import os
import subprocess
import sys
import tempfile
import threading
from collections import OrderedDict
from pathlib import Path

import numpy as np
import soundfile as sf

SAMPLE_RATE = 24_000
MAX_CACHE_ITEMS = 128
MAX_AUDIO_BYTES = 2 * 1024 * 1024
ZERO_SHOT_SPEAKER_ID = "byeollog-raffle-winner-v1"
PROMPT_PREFIX = "You are a helpful assistant.<|endofprompt|>"


class WinnerSpeechEngine:
    def __init__(self) -> None:
        cosyvoice_root = Path(os.environ.get("BYEOLLOG_COSYVOICE_ROOT", "/opt/CosyVoice"))
        model_dir = Path(
            os.environ.get(
                "BYEOLLOG_COSYVOICE_MODEL_DIR",
                "/models/Fun-CosyVoice3-0.5B-2512",
            )
        )
        reference_source = Path(
            os.environ.get("BYEOLLOG_COSYVOICE_REFERENCE_AUDIO", "")
        )
        prompt_text = os.environ.get(
            "BYEOLLOG_COSYVOICE_PROMPT_TEXT",
            "추 천 권 을 드렸 어요.",
        ).strip()
        if not cosyvoice_root.is_dir() or not model_dir.is_dir():
            raise RuntimeError("CosyVoice runtime or model is missing")
        if not reference_source.is_file() or not prompt_text:
            raise RuntimeError("CosyVoice reference voice is not configured")

        sys.path.insert(0, str(cosyvoice_root))
        sys.path.insert(0, str(cosyvoice_root / "third_party" / "Matcha-TTS"))
        import torch
        from cosyvoice.cli.cosyvoice import AutoModel
        from cosyvoice.utils.common import set_all_random_seed

        if not torch.cuda.is_available():
            raise RuntimeError("CosyVoice production runtime requires CUDA")

        self._torch = torch
        self._set_all_random_seed = set_all_random_seed
        self._reference_temp = tempfile.TemporaryDirectory(prefix="byeollog-voice-")
        reference_wav = Path(self._reference_temp.name) / "reference.wav"
        self._convert_reference(reference_source, reference_wav)

        self._model = AutoModel(
            model_dir=str(model_dir),
            load_trt=False,
            load_vllm=False,
            fp16=True,
        )
        if int(self._model.sample_rate) != SAMPLE_RATE:
            raise RuntimeError("unexpected CosyVoice sample rate")
        if not self._model.add_zero_shot_spk(
            PROMPT_PREFIX + prompt_text,
            str(reference_wav),
            ZERO_SHOT_SPEAKER_ID,
        ):
            raise RuntimeError("failed to register CosyVoice reference speaker")

        self._lock = threading.Lock()
        # Bind every cached WAV to both the database-derived voice key and the
        # exact phrase. Reusing a key for another winner fails closed.
        self._cache: OrderedDict[str, tuple[str, bytes]] = OrderedDict()

    @staticmethod
    def _convert_reference(source: Path, destination: Path) -> None:
        completed = subprocess.run(
            [
                "ffmpeg",
                "-nostdin",
                "-v",
                "error",
                "-i",
                str(source),
                "-ac",
                "1",
                "-ar",
                str(SAMPLE_RATE),
                "-c:a",
                "pcm_s16le",
                "-y",
                str(destination),
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            timeout=30,
            check=False,
        )
        if completed.returncode != 0 or not destination.is_file():
            raise RuntimeError("failed to prepare CosyVoice reference audio")
        audio, rate = sf.read(destination, dtype="float32", always_2d=False)
        if rate != SAMPLE_RATE or audio.ndim != 1 or audio.size < SAMPLE_RATE:
            raise RuntimeError("invalid CosyVoice reference audio")

    def synthesize(self, text: str, cache_key: str) -> bytes:
        with self._lock:
            text_digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
            cached = self._cache.get(cache_key)
            if cached is not None:
                cached_text_digest, cached_wav = cached
                if not hmac.compare_digest(cached_text_digest, text_digest):
                    raise RuntimeError("voice cache identity mismatch")
                self._cache.move_to_end(cache_key)
                return cached_wav

            self._set_all_random_seed(0)
            parts = []
            with self._torch.inference_mode():
                for output in self._model.inference_zero_shot(
                    text,
                    "",
                    "",
                    zero_shot_spk_id=ZERO_SHOT_SPEAKER_ID,
                    stream=False,
                    speed=1.0,
                    text_frontend=False,
                ):
                    speech = output.get("tts_speech")
                    if speech is None or speech.ndim != 2 or speech.shape[1] == 0:
                        raise RuntimeError("invalid CosyVoice model output")
                    parts.append(speech.detach().to(device="cpu", dtype=self._torch.float32))
            if not parts:
                raise RuntimeError("CosyVoice produced no audio")

            audio = self._torch.concat(parts, dim=1).squeeze(0).numpy()
            if audio.ndim != 1 or audio.size == 0 or not np.all(np.isfinite(audio)):
                raise RuntimeError("invalid CosyVoice audio")
            peak = float(np.max(np.abs(audio)))
            if peak > 0.98:
                audio = audio * (0.98 / peak)

            output = io.BytesIO()
            sf.write(output, audio, SAMPLE_RATE, format="WAV", subtype="PCM_16")
            wav = output.getvalue()
            if (
                not 44 <= len(wav) <= MAX_AUDIO_BYTES
                or wav[:4] != b"RIFF"
                or wav[8:12] != b"WAVE"
            ):
                raise RuntimeError("invalid synthesized WAV")
            self._cache[cache_key] = (text_digest, wav)
            self._cache.move_to_end(cache_key)
            while len(self._cache) > MAX_CACHE_ITEMS:
                self._cache.popitem(last=False)
            return wav
