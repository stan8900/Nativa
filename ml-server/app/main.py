from __future__ import annotations

import logging
from urllib.parse import quote

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from app.config import settings
from app.schemas import SttResponse, TranslateRequest, TtsRequest, VoiceCloneResponse
from app.services import ensure_runtime_dirs, iter_bytes, language_code, services

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("nativa.ml")

app = FastAPI(title="NATIVA ML Server", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:3000", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=[
        "X-Transcript",
        "X-Translation",
        "X-Latency-STT",
        "X-Latency-Translate",
        "X-Latency-TTS",
    ],
)


@app.on_event("startup")
async def load_models():
    ensure_runtime_dirs()
    logger.info("Starting NATIVA ML server in %s mode.", settings.mode)
    if settings.mode == "mock":
        logger.warning("NATIVA_MODE=mock is no longer a mock implementation; set real dependencies before use.")
    await services.run_blocking(services.load_all)


@app.get("/health")
async def health():
    return {
        "ok": True,
        "mode": settings.mode,
        "device": settings.device,
        "voices_dir": str(settings.voices_dir),
        "models_dir": str(settings.models_dir),
        "stack": {
            "stt": settings.stt_engine,
            "translation": settings.translation_engine,
            "tts": settings.tts_engine,
            "voice": settings.voice_engine,
        },
    }


@app.post("/voice-clone", response_model=VoiceCloneResponse)
async def voice_clone(
    audio: UploadFile | None = File(default=None),
    sample: UploadFile | None = File(default=None),
):
    upload = audio or sample
    if upload is None:
        raise HTTPException(status_code=400, detail="Audio file is required.")

    voice_id = await services.run_blocking(services.voice_clone.clone, upload)
    return VoiceCloneResponse(voice_id=voice_id)


@app.post("/tts-stream")
async def tts_stream(payload: TtsRequest):
    voice_id = payload.voice_id or payload.voiceId
    if not voice_id:
        raise HTTPException(status_code=400, detail="voice_id is required.")

    audio, latency_ms = await services.run_blocking(
        services.tts.synthesize,
        payload.text,
        voice_id,
        payload.language,
    )
    return StreamingResponse(
        iter_bytes(audio),
        media_type="audio/wav",
        headers={"X-Latency-TTS": str(latency_ms)},
    )


@app.post("/stt", response_model=SttResponse)
async def stt(
    audio: UploadFile = File(...),
    sourceLang: str | None = Form(default=None),
    src_lang: str | None = Form(default=None),
):
    text, language, latency_ms = await services.run_blocking(
        services.stt.transcribe,
        audio,
        src_lang or sourceLang,
    )
    return SttResponse(text=text, language=language, latency_ms=latency_ms)


@app.post("/translate")
async def translate(payload: TranslateRequest):
    src = payload.src_lang or payload.sourceLang
    tgt = payload.tgt_lang or payload.targetLang
    if not src or not tgt:
        raise HTTPException(status_code=400, detail="src_lang/tgt_lang are required.")

    text, latency_ms = await services.run_blocking(
        services.translation.translate,
        payload.text,
        src,
        tgt,
    )
    return {"text": text, "translation": text, "latency_ms": latency_ms}


@app.post("/pipeline")
async def pipeline(
    audio: UploadFile = File(...),
    voice_id: str = Form(...),
    src_lang: str = Form(...),
    tgt_lang: str = Form(...),
):
    transcript, detected_language, stt_latency = await services.run_blocking(
        services.stt.transcribe,
        audio,
        src_lang,
    )
    translation, translate_latency = await services.run_blocking(
        services.translation.translate,
        transcript,
        detected_language or src_lang,
        tgt_lang,
    )
    tts_audio, tts_latency = await services.run_blocking(
        services.tts.synthesize,
        translation,
        voice_id,
        language_code(tgt_lang),
    )

    return StreamingResponse(
        iter_bytes(tts_audio),
        media_type="audio/wav",
        headers={
            "X-Transcript": quote(transcript),
            "X-Translation": quote(translation),
            "X-Latency-STT": str(stt_latency),
            "X-Latency-Translate": str(translate_latency),
            "X-Latency-TTS": str(tts_latency),
        },
    )
