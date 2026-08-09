"""Central configuration: model ids, per-API language tables, paths, limits.

The language tables are the single most bug-prone thing in this project: four
Sarvam APIs support four different language sets, and Odia has a *different
BCP-47 code* in the Dubbing API (``or-IN``) than everywhere else (``od-IN``).
Everything funnels through :func:`resolve_language` and the ``to_*_code``
helpers so that mismatch is handled in exactly one place.
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

# --------------------------------------------------------------------------
# Paths
# --------------------------------------------------------------------------
ROOT = Path(__file__).resolve().parent.parent
ASSETS_DIR = ROOT / "assets"
CACHE_DIR = ROOT / "cache"
WORK_DIR = ROOT / "work"

for _d in (ASSETS_DIR, CACHE_DIR, WORK_DIR):
    _d.mkdir(parents=True, exist_ok=True)

RNNOISE_MODEL = ASSETS_DIR / "sh.rnnn"

# --------------------------------------------------------------------------
# Credentials
# --------------------------------------------------------------------------
SARVAM_API_KEY = os.getenv("SARVAM_API_KEY", "").strip()
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()

# --------------------------------------------------------------------------
# Models  (verified against sarvamai wheel 0.1.30 type enums)
# --------------------------------------------------------------------------
STT_MODEL = os.getenv("CLIPIT_STT_MODEL", "saaras:v3")  # saaras:v3 | saaras:v4
STT_MODE = "transcribe"
CHAT_MODEL = "sarvam-105b"          # the only value in SarvamModelIds
# Planning and locating are extraction tasks, not reasoning ones — "low" roughly
# halves LLM latency here with no measurable quality loss.
CHAT_REASONING_EFFORT = os.getenv("CLIPIT_REASONING_EFFORT", "low")
TRANSLATE_MODEL = "sarvam-translate:v1"
TTS_MODEL = "bulbul:v3"
TTS_SPEAKER = os.getenv("CLIPIT_TTS_SPEAKER", "shubh")

# --------------------------------------------------------------------------
# Limits
# --------------------------------------------------------------------------
STT_MAX_SECONDS = 30.0        # hard API limit per request
STT_MAX_WORKERS = 6           # stays under the 60 req/min ceiling
MAX_INPUT_SECONDS = 15 * 60   # reject longer sources up front

# Sarvam returns exactly ONE timestamp chunk per request (verified on both
# saaras:v3 and v4 — a 15s request comes back as a single 0.00->15.23 span).
# That means *our* chunk size is the timestamp resolution the locator gets, so
# chunks are sized for precision rather than for the 30s ceiling.
STT_CHUNK_MIN = 2.5           # finest granularity worth paying for
STT_CHUNK_MAX = 15.0          # coarsest we tolerate on long media
STT_CHUNK_FLOOR = 1.2         # never emit slivers shorter than this
STT_TARGET_CHUNKS = 60        # rough call budget per media file

TRANSLATE_MAX_CHARS = 1800    # sarvam-translate:v1 caps at 2000
TTS_MAX_CHARS = 2400          # bulbul:v3 caps at 2500

TELEGRAM_MAX_DOWNLOAD = 20 * 1024 * 1024
TELEGRAM_MAX_UPLOAD = 50 * 1024 * 1024

DUB_POLL_SECONDS = 3.0
DUB_TIMEOUT_SECONDS = 600.0

# "auto"   -> Sarvam Dub (voice cloning, ~2-5 min server-side job), TTS on failure
# "manual" -> Translate + Bulbul TTS locally (~20s, no voice cloning)
# "sarvam" -> Sarvam Dub only, fail loudly
DUB_ENGINE = os.getenv("CLIPIT_DUB_ENGINE", "auto")

ATEMPO_MAX = 1.6              # beyond this the manual dub sounds like a chipmunk
DEFAULT_PADDING = 0.4

# --------------------------------------------------------------------------
# ffmpeg discovery — prefer system, fall back to the pip-installed static build
# --------------------------------------------------------------------------

def _resolve_ffmpeg() -> tuple[str, str]:
    ffmpeg, ffprobe = shutil.which("ffmpeg"), shutil.which("ffprobe")
    if ffmpeg and ffprobe:
        return ffmpeg, ffprobe
    try:  # pragma: no cover - only exercised when system ffmpeg is absent
        import static_ffmpeg

        static_ffmpeg.add_paths()
        ffmpeg, ffprobe = shutil.which("ffmpeg"), shutil.which("ffprobe")
        if ffmpeg and ffprobe:
            return ffmpeg, ffprobe
    except Exception:
        pass
    raise RuntimeError(
        "ffmpeg/ffprobe not found. Install with `sudo apt install ffmpeg` "
        "or `pip install static-ffmpeg`."
    )


FFMPEG, FFPROBE = _resolve_ffmpeg()

# --------------------------------------------------------------------------
# Language tables
# --------------------------------------------------------------------------
# Canonical codes use the "od-IN" spelling for Odia (used by STT / Translate /
# TTS). Only the Dubbing API wants "or-IN" — see to_dub_code().

LANGUAGE_NAMES: dict[str, tuple[str, ...]] = {
    "en-IN": ("english", "eng", "en"),
    "hi-IN": ("hindi", "hin", "hi"),
    "bn-IN": ("bengali", "bangla", "ben", "bn"),
    "gu-IN": ("gujarati", "guj", "gu"),
    "kn-IN": ("kannada", "kan", "kn"),
    "ml-IN": ("malayalam", "mal", "ml"),
    "mr-IN": ("marathi", "mar", "mr"),
    "od-IN": ("odia", "oriya", "ori", "or", "od"),
    "pa-IN": ("punjabi", "panjabi", "pan", "pa"),
    "ta-IN": ("tamil", "tam", "ta"),
    "te-IN": ("telugu", "tel", "te"),
    "as-IN": ("assamese", "asm", "as"),
    "ur-IN": ("urdu", "urd", "ur"),
    "ne-IN": ("nepali", "nep", "ne"),
    "sa-IN": ("sanskrit", "san", "sa"),
    "sd-IN": ("sindhi", "snd", "sd"),
    "ks-IN": ("kashmiri", "kas", "ks"),
    "kok-IN": ("konkani", "kok"),
    "mai-IN": ("maithili", "mai"),
    "mni-IN": ("manipuri", "meitei", "mni"),
    "brx-IN": ("bodo", "brx"),
    "doi-IN": ("dogri", "doi"),
    "sat-IN": ("santali", "sat"),
}

# Speech-to-text (Saaras) — 23 languages + "unknown"
STT_LANGUAGES = set(LANGUAGE_NAMES)

# Text translation (sarvam-translate:v1) — 23
TRANSLATE_LANGUAGES = set(LANGUAGE_NAMES)

# Text-to-speech (bulbul:v3) — 11, no Assamese
TTS_LANGUAGES = {
    "en-IN", "hi-IN", "bn-IN", "gu-IN", "kn-IN", "ml-IN",
    "mr-IN", "od-IN", "pa-IN", "ta-IN", "te-IN",
}

# Dubbing (Sarvam Dub) — 12, includes Assamese, uses or-IN for Odia
DUB_LANGUAGES = {
    "en-IN", "hi-IN", "bn-IN", "gu-IN", "kn-IN", "ml-IN",
    "mr-IN", "od-IN", "pa-IN", "ta-IN", "te-IN", "as-IN",
}

_NAME_TO_CODE: dict[str, str] = {}
for _code, _aliases in LANGUAGE_NAMES.items():
    _NAME_TO_CODE[_code.lower()] = _code
    for _alias in _aliases:
        _NAME_TO_CODE[_alias] = _code


def resolve_language(value: str | None) -> str | None:
    """Map ``"hindi"`` / ``"hi"`` / ``"hi-IN"`` / ``"or-IN"`` to a canonical code."""
    if not value:
        return None
    key = value.strip().lower()
    if key in ("or-in", "or"):        # dubbing's Odia spelling
        return "od-IN"
    return _NAME_TO_CODE.get(key)


def to_dub_code(code: str) -> str:
    """Canonical code -> Dubbing API code (Odia is the only difference)."""
    return "or-IN" if code == "od-IN" else code


def to_tts_code(code: str) -> str:
    """Dubbing/other code -> TTS code."""
    return "od-IN" if code == "or-IN" else code


def language_label(code: str | None) -> str:
    if not code:
        return "unknown"
    aliases = LANGUAGE_NAMES.get(code)
    return aliases[0].title() if aliases else code


def supported_for(ops: set[str]) -> set[str]:
    """Intersection of language sets required by an op chain.

    ``dub`` needs the Dubbing set; the manual dub fallback additionally needs
    TTS, so we intersect both to stay honest about what we can actually deliver.
    """
    langs = set(LANGUAGE_NAMES)
    if "dub" in ops:
        langs &= DUB_LANGUAGES
    if "translate" in ops:
        langs &= TRANSLATE_LANGUAGES
    return langs
