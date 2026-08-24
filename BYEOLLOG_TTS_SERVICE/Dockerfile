# syntax=docker/dockerfile:1.7
FROM pytorch/pytorch:2.7.1-cuda12.8-cudnn9-runtime

ARG COSYVOICE_COMMIT=074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc
ARG COSYVOICE_MODEL_REVISION=29e01c4e8d000f4bcd70751be16fa94bf3d85a18
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/models/huggingface \
    HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    BYEOLLOG_COSYVOICE_ROOT=/opt/CosyVoice \
    BYEOLLOG_COSYVOICE_MODEL_DIR=/models/Fun-CosyVoice3-0.5B-2512 \
    BYEOLLOG_COSYVOICE_REFERENCE_AUDIO=/run/byeollog-voice/reference.mp3 \
    BYEOLLOG_COSYVOICE_PROMPT_TEXT="추 천 권 을 드렸 어요."

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       build-essential ffmpeg git libsndfile1 libsox-dev sox \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 byeollog \
    && mkdir -p /app /models /opt /licenses /run/byeollog-voice \
    && chown -R byeollog:byeollog /app /models /run/byeollog-voice

WORKDIR /app
COPY requirements.txt /app/requirements.txt
RUN python -m pip install --no-cache-dir --upgrade \
      pip==25.0.1 setuptools==75.8.0 wheel==0.45.1 \
    && python -m pip install --no-cache-dir --force-reinstall \
      numpy==1.26.4 \
    && python -m pip install --no-cache-dir --no-build-isolation \
      -r /app/requirements.txt \
    && python -m pip install --no-cache-dir --no-build-isolation --no-deps \
      openai-whisper==20231117

RUN git clone --filter=blob:none --recurse-submodules \
      https://github.com/FunAudioLLM/CosyVoice.git /opt/CosyVoice \
    && git -C /opt/CosyVoice checkout --detach "${COSYVOICE_COMMIT}" \
    && git -C /opt/CosyVoice submodule update --init --recursive \
    && test "$(git -C /opt/CosyVoice rev-parse HEAD)" = "${COSYVOICE_COMMIT}" \
    && cp /opt/CosyVoice/LICENSE /licenses/CosyVoice.txt \
    && rm -rf /opt/CosyVoice/.git /opt/CosyVoice/third_party/Matcha-TTS/.git

# Pin the exact model revision and only retain files used by basic fp16
# zero-shot inference. TensorRT, batch tokenizer, and RL checkpoints are not
# part of this runtime.
RUN HF_HUB_OFFLINE=0 TRANSFORMERS_OFFLINE=0 python -c \
  "from huggingface_hub import snapshot_download; snapshot_download(repo_id='FunAudioLLM/Fun-CosyVoice3-0.5B-2512', revision='${COSYVOICE_MODEL_REVISION}', local_dir='/models/Fun-CosyVoice3-0.5B-2512', allow_patterns=['cosyvoice3.yaml','llm.pt','flow.pt','hift.pt','campplus.onnx','speech_tokenizer_v3.onnx','CosyVoice-BlankEN/*','speech_tokenizer_v3/*','asset/*','README.md','LICENSE'])" \
    && rm -rf /models/Fun-CosyVoice3-0.5B-2512/.cache /models/huggingface

# Nicknames are already converted to bounded Korean syllables by app/text.py.
# Remove WeText so startup cannot attempt an unpinned network download.
RUN python -m pip uninstall --yes wetext

COPY --chown=byeollog:byeollog app /app/app
RUN python -m compileall -q /app/app \
    && test -f /models/Fun-CosyVoice3-0.5B-2512/cosyvoice3.yaml \
    && test -f /models/Fun-CosyVoice3-0.5B-2512/llm.pt \
    && test -f /models/Fun-CosyVoice3-0.5B-2512/flow.pt \
    && test -f /models/Fun-CosyVoice3-0.5B-2512/hift.pt

USER byeollog
EXPOSE 8080
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1", "--limit-concurrency", "8", "--timeout-keep-alive", "5", "--no-access-log"]
