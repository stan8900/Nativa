from pydantic import BaseModel, Field


class TranslateTurn(BaseModel):
    sourceLang: str = ""
    targetLang: str = ""
    transcript: str = ""
    translation: str = ""


class TranslateRequest(BaseModel):
    sourceLang: str
    targetLang: str
    text: str
    history: list[TranslateTurn] = Field(default_factory=list)


class TranslateResponse(BaseModel):
    translation: str


class VoiceCloneResponse(BaseModel):
    voiceId: str
