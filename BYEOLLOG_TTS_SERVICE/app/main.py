from __future__ import annotations

import hashlib
import hmac
import os
from contextlib import asynccontextmanager

import anyio
from fastapi import FastAPI, Header, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field

from .engine import WinnerSpeechEngine
from .text import roulette_result_phrase, roulette_result_voice_key, voice_key, winner_phrase

SERVICE_VERSION = "raffle-winner-cosyvoice3-v1"
engine: WinnerSpeechEngine | None = None


class WinnerRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    actorName: str = Field(min_length=1, max_length=120)
    voiceKey: str = Field(pattern=r"^[0-9a-f]{64}$")


class RouletteResultRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str = Field(min_length=1, max_length=160)
    voiceKey: str = Field(pattern=r"^[0-9a-f]{64}$")


def shared_secret() -> str:
    value = os.environ.get("BYEOLLOG_TTS_SHARED_SECRET", "").strip()
    if not 43 <= len(value) <= 200:
        raise RuntimeError("BYEOLLOG_TTS_SHARED_SECRET is not configured")
    return value


def authorize(authorization: str | None) -> None:
    expected = "Bearer " + shared_secret()
    if authorization is None or not hmac.compare_digest(authorization, expected):
        raise HTTPException(status_code=401, detail="unauthorized")


@asynccontextmanager
async def lifespan(_: FastAPI):
    global engine
    engine = await anyio.to_thread.run_sync(WinnerSpeechEngine)
    yield
    engine = None


app = FastAPI(
    title="Byeollog private raffle TTS",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
    lifespan=lifespan,
)


@app.get("/healthz")
def healthz() -> dict[str, object]:
    return {"healthy": engine is not None, "version": SERVICE_VERSION}


@app.post("/v1/raffle-winner", response_class=Response)
async def raffle_winner(
    request: WinnerRequest,
    authorization: str | None = Header(default=None),
) -> Response:
    authorize(authorization)
    if not hmac.compare_digest(voice_key(request.actorName), request.voiceKey):
        raise HTTPException(status_code=400, detail="invalid voice key")
    current = engine
    if current is None:
        raise HTTPException(status_code=503, detail="model unavailable")
    phrase = winner_phrase(request.actorName)
    wav = await anyio.to_thread.run_sync(current.synthesize, phrase, request.voiceKey)
    digest = hashlib.sha256(wav).hexdigest()
    return Response(
        content=wav,
        media_type="audio/wav",
        headers={
            "cache-control": "private, no-store",
            "x-content-type-options": "nosniff",
            "x-byeollog-audio-sha256": digest,
            "x-byeollog-voice-key": request.voiceKey,
            "x-byeollog-voice-version": SERVICE_VERSION,
        },
    )


@app.post("/v1/roulette-result", response_class=Response)
async def roulette_result(
    request: RouletteResultRequest,
    authorization: str | None = Header(default=None),
) -> Response:
    authorize(authorization)
    phrase = roulette_result_phrase(request.text)
    if not hmac.compare_digest(roulette_result_voice_key(phrase), request.voiceKey):
        raise HTTPException(status_code=400, detail="invalid voice key")
    current = engine
    if current is None:
        raise HTTPException(status_code=503, detail="model unavailable")
    wav = await anyio.to_thread.run_sync(current.synthesize, phrase, request.voiceKey)
    digest = hashlib.sha256(wav).hexdigest()
    return Response(
        content=wav,
        media_type="audio/wav",
        headers={
            "cache-control": "private, no-store",
            "x-content-type-options": "nosniff",
            "x-byeollog-audio-sha256": digest,
            "x-byeollog-voice-key": request.voiceKey,
            "x-byeollog-voice-version": SERVICE_VERSION,
        },
    )
