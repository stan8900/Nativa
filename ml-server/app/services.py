from __future__ import annotations

import asyncio
import logging
import os
import shutil
import subprocess
import tempfile
import time
import uuid
import wave
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

import torch
import torchaudio
from fastapi import HTTPException, UploadFile

from app.config import settings

logger = logging.getLogger("nativa.ml")


def ensure_runtime_dirs() -> None:
    settings.voices_dir.mkdir(parents=True, exist_ok=True)
    settings.models_dir.mkdir(parents=True, exist_ok=True)


def language_code(language: str | None) -> str:
    value = (language or "").strip().lower()
    aliases = {
        "russian": "ru",
        "русский": "ru",
        "ru": "ru",
        "english": "en",
        "английский": "en",
        "en": "en",
    }
    return aliases.get(value, value or "en")


def wav_duration_seconds(path: Path) -> float:
    with wave.open(str(path), "rb") as wav_file:
        frames = wav_file.getnframes()
        rate = wav_file.getframerate()
        return frames / float(rate)


def waveform_to_wav_bytes(waveform: Iterable[float] | torch.Tensor, sample_rate: int) -> bytes:
    import io

    tensor = torch.as_tensor(waveform, dtype=torch.float32).detach().cpu()
    if tensor.ndim > 1:
        tensor = tensor.squeeze()
    tensor = tensor.clamp(-1.0, 1.0).unsqueeze(0)

    buffer = io.BytesIO()
    torchaudio.save(buffer, tensor, sample_rate=sample_rate, format="wav")
    return buffer.getvalue()


def iter_bytes(payload: bytes, chunk_size: int = settings.chunk_size):
    for index in range(0, len(payload), chunk_size):
        yield payload[index : index + chunk_size]


@dataclass
class AudioService:
    def save_upload_to_temp(self, upload: UploadFile) -> Path:
        suffix = Path(upload.filename or "audio").suffix or ".bin"
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            shutil.copyfileobj(upload.file, tmp)
            return Path(tmp.name)

    def convert_to_wav(
        self,
        source_path: Path,
        target_path: Path,
        sample_rate: int = settings.voice_sample_rate,
    ) -> None:
        if shutil.which("ffmpeg"):
            command = [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-i",
                str(source_path),
                "-ac",
                "1",
                "-ar",
                str(sample_rate),
                str(target_path),
            ]
            subprocess.run(command, check=True)
            return

        waveform, original_rate = torchaudio.load(str(source_path))
        if waveform.shape[0] > 1:
            waveform = waveform.mean(dim=0, keepdim=True)
        if original_rate != sample_rate:
            waveform = torchaudio.functional.resample(waveform, original_rate, sample_rate)
        torchaudio.save(str(target_path), waveform, sample_rate=sample_rate)

    def normalized_temp_wav(self, upload: UploadFile, sample_rate: int = settings.voice_sample_rate) -> Path:
        source_path = self.save_upload_to_temp(upload)
        with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as target:
            target_path = Path(target.name)
        try:
            try:
                self.convert_to_wav(source_path, target_path, sample_rate=sample_rate)
            except (subprocess.CalledProcessError, RuntimeError, OSError) as exc:
                target_path.unlink(missing_ok=True)
                logger.warning("Audio conversion failed for %s: %s", upload.filename, exc)
                raise HTTPException(status_code=400, detail="Could not decode or convert uploaded audio.") from exc
        finally:
            source_path.unlink(missing_ok=True)
        return target_path


@dataclass
class VoiceCloneService:
    audio: AudioService

    def clone(self, upload: UploadFile) -> str:
        ensure_runtime_dirs()
        tmp_wav = self.audio.normalized_temp_wav(upload)
        try:
            duration = wav_duration_seconds(tmp_wav)
            if duration < settings.min_voice_seconds:
                raise HTTPException(
                    status_code=400,
                    detail=f"Voice sample must be at least {settings.min_voice_seconds:.0f} seconds long.",
                )

            voice_id = str(uuid.uuid4())
            destination = settings.voices_dir / f"{voice_id}.wav"
            shutil.move(str(tmp_wav), destination)
            logger.info("Saved voice sample %s (%.2fs) to %s", voice_id, duration, destination)
            return voice_id
        finally:
            tmp_wav.unlink(missing_ok=True)

    def resolve_voice_path(self, voice_id: str) -> Path:
        safe_id = Path(voice_id).stem
        path = settings.voices_dir / f"{safe_id}.wav"
        if not path.exists():
            raise HTTPException(status_code=404, detail="Voice sample not found.")
        return path


@dataclass
class SttService:
    audio: AudioService
    model: object | None = None

    def load(self) -> None:
        from faster_whisper import WhisperModel

        logger.info(
            "Loading faster-whisper model '%s' on %s (%s).",
            settings.whisper_model_size,
            settings.device,
            settings.whisper_compute_type,
        )
        self.model = WhisperModel(
            settings.whisper_model_size,
            device=settings.device,
            compute_type=settings.whisper_compute_type,
            download_root=str(settings.models_dir / "faster-whisper"),
        )
        logger.info("faster-whisper loaded.")

    def transcribe(self, upload: UploadFile, src_lang: str | None = None) -> tuple[str, str, int]:
        if self.model is None:
            raise RuntimeError("STT model is not loaded.")

        started = time.perf_counter()
        wav_path = self.audio.normalized_temp_wav(upload, sample_rate=16000)
        try:
            segments, info = self.model.transcribe(
                str(wav_path),
                language=language_code(src_lang) if src_lang else None,
                vad_filter=True,
            )
            text = " ".join(segment.text.strip() for segment in segments).strip()
            detected_language = getattr(info, "language", None) or language_code(src_lang)
            latency_ms = int((time.perf_counter() - started) * 1000)
            return text, detected_language, latency_ms
        finally:
            wav_path.unlink(missing_ok=True)


@dataclass
class TranslationService:
    models: dict[str, tuple[object, object]] = field(default_factory=dict)

    def load(self) -> None:
        for pair in ("ru-en", "en-ru"):
            self._load_pair(pair)

    def _load_pair(self, pair: str) -> tuple[object, object]:
        if pair in self.models:
            return self.models[pair]

        from transformers import MarianMTModel, MarianTokenizer

        model_name = f"Helsinki-NLP/opus-mt-{pair}"
        logger.info("Loading translation model %s.", model_name)
        tokenizer = MarianTokenizer.from_pretrained(model_name, cache_dir=str(settings.models_dir / "transformers"))
        model = MarianMTModel.from_pretrained(model_name, cache_dir=str(settings.models_dir / "transformers"))
        model.to(settings.device)
        model.eval()
        self.models[pair] = (tokenizer, model)
        logger.info("Translation model %s loaded.", model_name)
        return tokenizer, model

    def translate(self, text: str, src_lang: str, tgt_lang: str) -> tuple[str, int]:
        started = time.perf_counter()
        src = language_code(src_lang)
        tgt = language_code(tgt_lang)
        if src == tgt:
            return text, int((time.perf_counter() - started) * 1000)

        pair = f"{src}-{tgt}"
        if pair not in {"ru-en", "en-ru"}:
            raise HTTPException(status_code=400, detail=f"Unsupported translation pair: {pair}")

        tokenizer, model = self._load_pair(pair)
        batch = tokenizer([text], return_tensors="pt", padding=True).to(settings.device)
        with torch.no_grad():
            generated = model.generate(**batch)
        translation = tokenizer.batch_decode(generated, skip_special_tokens=True)[0]
        return translation, int((time.perf_counter() - started) * 1000)


@dataclass
class TtsService:
    voice_clone: VoiceCloneService
    model: object | None = None
    sample_rate: int = settings.voice_sample_rate

    def load(self) -> None:
        os.environ.setdefault("TTS_HOME", str(settings.models_dir / "coqui-tts"))
        os.environ.setdefault("COQUI_TOS_AGREED", "1")

        from TTS.api import TTS

        logger.info("Loading XTTS v2 '%s' on %s. First run may download about 2GB.", settings.xtts_model_name, settings.device)
        self.model = TTS(settings.xtts_model_name, progress_bar=True).to(settings.device)
        self.sample_rate = int(
            getattr(getattr(self.model, "synthesizer", None), "output_sample_rate", settings.voice_sample_rate)
            or settings.voice_sample_rate
        )
        logger.info("XTTS v2 loaded with output sample rate %s.", self.sample_rate)

    def synthesize(self, text: str, voice_id: str, language: str) -> tuple[bytes, int]:
        if self.model is None:
            raise RuntimeError("TTS model is not loaded.")
        if not text.strip():
            raise HTTPException(status_code=400, detail="Text is required.")

        started = time.perf_counter()
        speaker_wav = self.voice_clone.resolve_voice_path(voice_id)
        waveform = self.model.tts(
            text=text,
            speaker_wav=str(speaker_wav),
            language=language_code(language),
        )
        audio = waveform_to_wav_bytes(waveform, self.sample_rate)
        return audio, int((time.perf_counter() - started) * 1000)


@dataclass
class Services:
    audio: AudioService = field(default_factory=AudioService)
    voice_clone: VoiceCloneService = field(init=False)
    stt: SttService = field(init=False)
    translation: TranslationService = field(default_factory=TranslationService)
    tts: TtsService = field(init=False)

    def __post_init__(self) -> None:
        self.voice_clone = VoiceCloneService(self.audio)
        self.stt = SttService(self.audio)
        self.tts = TtsService(self.voice_clone)

    def load_all(self) -> None:
        ensure_runtime_dirs()
        logger.info("ML runtime using device=%s, models_dir=%s, voices_dir=%s", settings.device, settings.models_dir, settings.voices_dir)
        self.stt.load()
        self.translation.load()
        self.tts.load()

    async def run_blocking(self, func, *args):
        return await asyncio.to_thread(func, *args)


services = Services()
