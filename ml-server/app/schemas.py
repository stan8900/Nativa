from typing import Literal

from pydantic import BaseModel, Field


class TranslateTurn(BaseModel):
    sourceLang: str = ""
    targetLang: str = ""
    transcript: str = ""
    translation: str = ""


class TranslateRequest(BaseModel):
    sourceLang: str | None = None
    targetLang: str | None = None
    src_lang: str | None = None
    tgt_lang: str | None = None
    text: str
    history: list[TranslateTurn] = Field(default_factory=list)


class TranslateResponse(BaseModel):
    text: str
    latency_ms: int

    @property
    def translation(self) -> str:
        return self.text


class VoiceCloneResponse(BaseModel):
    voice_id: str

    @property
    def voiceId(self) -> str:
        return self.voice_id


class TtsRequest(BaseModel):
    text: str
    voice_id: str | None = None
    voiceId: str | None = None
    language: Literal["ru", "en"] = "ru"


class SttResponse(BaseModel):
    text: str
    language: str
    latency_ms: int


class PipelineForm(BaseModel):
    voice_id: str
    src_lang: str
    tgt_lang: str
