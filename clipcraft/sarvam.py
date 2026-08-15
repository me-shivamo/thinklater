"""Thin wrappers over the Sarvam SDK with retry/backoff.

Notable quirk handled here: ``chat.completions()`` in sarvamai 0.1.30 does not
expose a ``response_format`` parameter even though the API supports it (the SDK
ships a ``ResponseFormat_JsonSchema`` type but never wires it into the method).
:func:`chat_json` injects it through ``RequestOptions.additional_body_parameters``
and degrades to ``json_object``, then to plain prompting, if the server refuses.
"""

from __future__ import annotations

import base64
import json
import logging
import random
import re
import time
from pathlib import Path
from typing import Any, Callable, TypeVar

from sarvamai import SarvamAI

from . import config

log = logging.getLogger("clipcraft.sarvam")

T = TypeVar("T")

_client: SarvamAI | None = None


def client() -> SarvamAI:
    global _client
    if _client is None:
        if not config.SARVAM_API_KEY:
            raise RuntimeError(
                "SARVAM_API_KEY is not set. Put it in .env or export it."
            )
        _client = SarvamAI(api_subscription_key=config.SARVAM_API_KEY)
    return _client


def _status_of(exc: Exception) -> int | None:
    for attr in ("status_code", "code"):
        value = getattr(exc, attr, None)
        if isinstance(value, int):
            return value
    response = getattr(exc, "response", None)
    return getattr(response, "status_code", None)


def retry(fn: Callable[..., T], *args: Any, attempts: int = 4, **kwargs: Any) -> T:
    """Exponential backoff on 429 / 5xx and transport errors.

    Programming errors (TypeError/ValueError/AttributeError) are re-raised
    immediately — retrying a bad keyword argument four times just hides the bug.
    """
    delay = 1.5
    last: Exception | None = None
    for i in range(attempts):
        try:
            return fn(*args, **kwargs)
        except (TypeError, ValueError, AttributeError, KeyError):
            raise
        except Exception as exc:  # noqa: BLE001 - SDK raises many error types
            last = exc
            status = _status_of(exc)
            retryable = status is None or status == 429 or status >= 500
            if not retryable or i == attempts - 1:
                raise
            sleep = delay * (2**i) + random.uniform(0, 0.4)
            log.warning("retry %d/%d after %s (status=%s), sleeping %.1fs",
                        i + 1, attempts, type(exc).__name__, status, sleep)
            time.sleep(sleep)
    raise last  # pragma: no cover


# --------------------------------------------------------------------------
# Speech to text
# --------------------------------------------------------------------------

def transcribe_chunk(path: Path, language_code: str = "unknown",
                     model: str | None = None) -> Any:
    """Transcribe a single <=30s audio chunk with timestamps."""
    model = model or config.STT_MODEL
    kwargs: dict[str, Any] = {
        "model": model,
        "language_code": language_code,
        "with_timestamps": True,
    }
    # `mode` is documented as saaras:v3-only; send it only for v3 so v4 never
    # trips on an unsupported parameter.
    if model.startswith("saaras:v3"):
        kwargs["mode"] = config.STT_MODE

    with open(path, "rb") as fh:
        return retry(client().speech_to_text.transcribe, file=fh, **kwargs)


# --------------------------------------------------------------------------
# Chat / structured output
# --------------------------------------------------------------------------

def _extract_json(text: str) -> dict:
    """Pull the first JSON object out of a model response."""
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.S)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    depth, start = 0, None
    for i, ch in enumerate(text):
        if ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0 and start is not None:
                try:
                    return json.loads(text[start:i + 1])
                except json.JSONDecodeError:
                    start = None
    raise ValueError(f"no JSON object in model response: {text[:400]}")


def chat_json(system: str, user: str, schema: dict, *, schema_name: str = "Result",
              temperature: float = 0.1, max_tokens: int = 3000) -> dict:
    """Chat completion constrained to a JSON schema, with two fallbacks."""
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]
    base = {
        "model": config.CHAT_MODEL,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        # Planning and locating are extraction tasks, not reasoning ones.
        # Dropping to "low" roughly halves latency with no quality loss here.
        "reasoning_effort": config.CHAT_REASONING_EFFORT,
    }

    formats = [
        {"type": "json_schema",
         "json_schema": {"name": schema_name, "schema": schema, "strict": True}},
        {"type": "json_object"},
        None,
    ]

    last: Exception | None = None
    for fmt in formats:
        kwargs = dict(base)
        if fmt is not None:
            kwargs["request_options"] = {"additional_body_parameters": {"response_format": fmt}}
        try:
            resp = retry(client().chat.completions, **kwargs)
            content = resp.choices[0].message.content or ""
            return _extract_json(content)
        except Exception as exc:  # noqa: BLE001
            last = exc
            label = fmt["type"] if fmt else "plain"
            log.warning("chat_json via %s failed (%s), trying next strategy",
                        label, type(exc).__name__)
    raise RuntimeError(f"all chat_json strategies failed: {last}") from last


# --------------------------------------------------------------------------
# Translation
# --------------------------------------------------------------------------

def translate(text: str, target: str, source: str | None = None,
              mode: str | None = None) -> str:
    """Translate one span of text.

    Two server-side constraints worth remembering, both learned the hard way:
    ``sarvam-translate:v1`` rejects ``source_language_code="auto"`` (only
    ``mayura:v1`` accepts it), and it supports ``mode="formal"`` *only* —
    the colloquial registers belong to ``mayura:v1``.
    """
    if mode is None:
        mode = "formal" if config.TRANSLATE_MODEL.startswith("sarvam-translate") \
            else "modern-colloquial"
    text = text.strip()
    if not text:
        return ""
    if len(text) > config.TRANSLATE_MAX_CHARS:
        text = text[: config.TRANSLATE_MAX_CHARS]

    source_code = config.resolve_language(source) or "en-IN"
    target_code = config.resolve_language(target) or target

    resp = retry(
        client().text.translate,
        input=text,
        source_language_code=source_code,
        target_language_code=target_code,
        model=config.TRANSLATE_MODEL,
        mode=mode,
    )
    return resp.translated_text


# --------------------------------------------------------------------------
# Text to speech
# --------------------------------------------------------------------------

def tts(text: str, language_code: str, speaker: str | None = None,
        pace: float = 1.0) -> bytes:
    text = text.strip()[: config.TTS_MAX_CHARS]
    resp = retry(
        client().text_to_speech.convert,
        text=text,
        language_code=config.to_tts_code(language_code),  # NB: not target_language_code
        model=config.TTS_MODEL,
        speaker=config.resolve_speaker(speaker),
        pace=pace,
    )
    audios = getattr(resp, "audios", None) or []
    if not audios:
        raise RuntimeError("text_to_speech returned no audio")
    return base64.b64decode(audios[0])
