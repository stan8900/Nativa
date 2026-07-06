from pathlib import Path

import torch
from pydantic_settings import BaseSettings


ROOT_DIR = Path(__file__).resolve().parents[1]


class Settings(BaseSettings):
    mode: str = "real"
    stt_engine: str = "faster-whisper"
    translation_engine: str = "helsinki-opus-mt"
    tts_engine: str = "xtts-v2"
    voice_engine: str = "xtts-reference-wav"
    voices_dir: Path = ROOT_DIR / "voices"
    models_dir: Path = ROOT_DIR / "models"
    min_voice_seconds: float = 6.0
    voice_sample_rate: int = 22050
    chunk_size: int = 64 * 1024
    whisper_model_size: str = "base"
    whisper_compute_type: str = "int8"
    xtts_model_name: str = "tts_models/multilingual/multi-dataset/xtts_v2"

    class Config:
        env_prefix = "NATIVA_"

    @property
    def device(self) -> str:
        return "cuda" if torch.cuda.is_available() else "cpu"


settings = Settings()
