from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    mode: str = "mock"
    stt_engine: str = "faster-whisper"
    translation_engine: str = "nllb-200"
    tts_engine: str = "piper"
    voice_engine: str = "speechbrain"

    class Config:
        env_prefix = "NATIVA_"


settings = Settings()
