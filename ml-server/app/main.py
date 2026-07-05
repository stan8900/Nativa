from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import StreamingResponse

from app.config import settings
from app.schemas import TranslateRequest, TranslateResponse, VoiceCloneResponse
from app.services import SttService, TranslationService, TtsService, VoiceCloneService

app = FastAPI(title="NATIVA ML Server", version="0.1.0")

stt_service = SttService(mode=settings.mode)
translation_service = TranslationService(mode=settings.mode)
tts_service = TtsService(mode=settings.mode)
voice_clone_service = VoiceCloneService(mode=settings.mode)


@app.get("/health")
async def health():
    return {
        "ok": True,
        "mode": settings.mode,
        "stack": {
            "stt": settings.stt_engine,
            "translation": settings.translation_engine,
            "tts": settings.tts_engine,
            "voice": settings.voice_engine,
        },
    }


@app.post("/stt")
async def stt(audio: UploadFile = File(...), sourceLang: str = Form("English")):
    audio_bytes = await audio.read()
    text = await stt_service.transcribe(audio_bytes, sourceLang)
    return {"text": text}


@app.post("/translate", response_model=TranslateResponse)
async def translate(payload: TranslateRequest):
    translation = await translation_service.translate(
        source_lang=payload.sourceLang,
        target_lang=payload.targetLang,
        text=payload.text,
        history=[turn.model_dump() for turn in payload.history],
    )
    return TranslateResponse(translation=translation)


@app.post("/tts-stream")
async def tts_stream(payload: dict):
    text = str(payload.get("text", ""))
    voice_id = str(payload.get("voiceId", "default"))
    return StreamingResponse(
        tts_service.synthesize_stream(text=text, voice_id=voice_id),
        media_type="audio/wav",
    )


@app.post("/voice-clone", response_model=VoiceCloneResponse)
async def voice_clone(sample: UploadFile = File(...)):
    sample_bytes = await sample.read()
    voice_id = await voice_clone_service.clone(sample_bytes)
    return VoiceCloneResponse(voiceId=voice_id)
