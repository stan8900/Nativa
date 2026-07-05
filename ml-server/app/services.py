from __future__ import annotations

import hashlib
import io
import math
import struct
import wave
from dataclasses import dataclass


@dataclass
class SttService:
    mode: str

    async def transcribe(self, audio: bytes, source_lang: str) -> str:
        if self.mode == "mock":
            return mock_transcript(source_lang)

        raise NotImplementedError(
            "Connect faster-whisper or whisper.cpp here. Keep the return value as plain text."
        )


@dataclass
class TranslationService:
    mode: str

    async def translate(self, source_lang: str, target_lang: str, text: str, history: list[dict]) -> str:
        if self.mode == "mock":
            return mock_translation(source_lang, target_lang, text, history)

        raise NotImplementedError(
            "Connect NLLB-200, M2M100, or a local LLM here. Keep context handling inside this service."
        )


@dataclass
class TtsService:
    mode: str

    async def synthesize_stream(self, text: str, voice_id: str):
        if self.mode == "mock":
            audio = make_mock_wav(text)
            chunk_size = 4096
            for index in range(0, len(audio), chunk_size):
                yield audio[index:index + chunk_size]
            return

        raise NotImplementedError(
            "Connect XTTS, StyleTTS2, Coqui, or Piper here and yield audio chunks immediately."
        )


@dataclass
class VoiceCloneService:
    mode: str

    async def clone(self, sample: bytes) -> str:
        digest = hashlib.sha1(sample).hexdigest()[:12]
        if self.mode == "mock":
            return f"mock-speaker-{digest}"

        raise NotImplementedError(
            "Extract speaker embeddings with SpeechBrain or resemblyzer here and return a voice id."
        )


def mock_transcript(source_lang: str) -> str:
    language = source_lang.lower()
    if "russian" in language:
        return "Привет, я хочу заказать столик на двоих на пятницу"
    if "uzbek" in language:
        return "Salom, men uchrashuv belgilamoqchiman"
    return "Hello, my name is John and I want to schedule a meeting"


def mock_translation(source_lang: str, target_lang: str, text: str, history: list[dict]) -> str:
    target = target_lang.lower()
    normalized = text.lower().strip()

    if normalized == "yes":
        if "russian" in target:
            return "Да."
        if "uzbek" in target:
            return "Ha."
        return "Yes."

    if "russian" in target:
        if "stressful" in normalized and history:
            return "В последнее время работа в банке была напряжённой."
        return "Здравствуйте, меня зовут Джон, и я хочу назначить встречу."

    if "uzbek" in target:
        return "Salom, mening ismim Jon va men uchrashuv belgilamoqchiman."

    if "столик" in normalized:
        return "Hi, I'd like to book a table for two this Friday."

    return "Hello, my name is John and I want to schedule a meeting."


def make_mock_wav(text: str) -> bytes:
    sample_rate = 16000
    duration_seconds = min(1.2, max(0.35, 0.035 * len(text)))
    total_samples = int(sample_rate * duration_seconds)
    frequency = 440
    amplitude = 0.18

    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)

        for i in range(total_samples):
            sample = amplitude * math.sin(2 * math.pi * frequency * (i / sample_rate))
            wav.writeframes(struct.pack("<h", int(sample * 32767)))

    return buffer.getvalue()
