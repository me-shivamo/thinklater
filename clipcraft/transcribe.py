"""Chunked parallel transcription with a global timeline and a disk cache.

Sarvam's STT REST endpoint accepts at most 30 seconds per request, so anything
longer is split locally, transcribed in parallel, and stitched back together.
Each chunk's timestamps come back *relative to that chunk*, so the offset
addition in :func:`_stitch` is the single most important line in this file — if
final timestamps ever look like they reset to zero, that is where to look.
"""

from __future__ import annotations

import json
import logging
import os
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, asdict, field
from pathlib import Path
from typing import Callable
from uuid import uuid4

from . import config, media, sarvam

log = logging.getLogger("clipcraft.transcribe")


@dataclass
class Word:
    text: str
    start: float
    end: float

    def to_dict(self) -> dict:
        return {"text": self.text, "start": round(self.start, 3), "end": round(self.end, 3)}


@dataclass
class Segment:
    id: int
    start: float
    end: float
    text: str
    words: list[Word] = field(default_factory=list)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["words"] = [w.to_dict() for w in self.words]
        return d


# Punctuation earns extra "time weight" because speakers pause there.
_PAUSE_WEIGHT = {",": 1.6, ";": 2.0, ":": 2.0, "।": 3.0, ".": 3.0,
                 "?": 3.0, "!": 3.0, "—": 2.0, "…": 3.0}


def estimate_words(text: str, start: float, end: float) -> list[Word]:
    """Distribute a chunk's words across its span.

    Sarvam returns one timestamp per request, not per word, so word timings are
    interpolated: each token's share of the span is proportional to its length,
    plus a bonus for trailing punctuation where speakers naturally pause. Within
    a short chunk this lands close enough for word highlighting in a UI; it is
    an estimate, not ground truth, and is labelled as such in the API.
    """
    tokens = text.split()
    span = max(end - start, 0.0)
    if not tokens or span <= 0:
        return []

    weights: list[float] = []
    for tok in tokens:
        weight = float(max(len(tok), 1))
        for ch, bonus in _PAUSE_WEIGHT.items():
            if tok.endswith(ch):
                weight += bonus
                break
        weights.append(weight)

    total = sum(weights)
    words: list[Word] = []
    cursor = start
    for tok, weight in zip(tokens, weights):
        width = span * (weight / total)
        words.append(Word(tok, round(cursor, 3), round(min(cursor + width, end), 3)))
        cursor += width
    return words


@dataclass
class Transcript:
    language: str
    duration: float
    segments: list[Segment]

    @property
    def text(self) -> str:
        return " ".join(s.text for s in self.segments).strip()

    def to_dict(self) -> dict:
        return {
            "language": self.language,
            "duration": self.duration,
            "segments": [s.to_dict() for s in self.segments],
        }

    @classmethod
    def from_dict(cls, d: dict) -> "Transcript":
        segments = []
        for s in d.get("segments", []):
            words = [Word(**w) for w in (s.get("words") or [])]
            segments.append(Segment(id=s["id"], start=s["start"], end=s["end"],
                                    text=s["text"], words=words))
        return cls(
            language=d.get("language") or "unknown",
            duration=float(d.get("duration") or 0.0),
            segments=segments,
        )

    def numbered(self, max_chars: int = 60000) -> str:
        """Indexed view handed to the locator LLM."""
        lines = []
        for s in self.segments:
            lines.append(f"[{s.id}] {_ts(s.start)}->{_ts(s.end)} {s.text}")
        out = "\n".join(lines)
        return out if len(out) <= max_chars else out[:max_chars] + "\n…(truncated)"


def _ts(seconds: float) -> str:
    m, s = divmod(max(seconds, 0.0), 60)
    return f"{int(m):02d}:{s:05.2f}"


def _stitch(results: list[tuple[float, object]]) -> tuple[list[Segment], str]:
    """Fold per-chunk responses into one monotonic timeline."""
    segments: list[Segment] = []
    languages: list[str] = []

    for offset, resp in results:
        lang = getattr(resp, "language_code", None)
        if lang and lang != "unknown":
            languages.append(lang)

        stamps = getattr(resp, "timestamps", None)
        chunks = list(getattr(stamps, "words", []) or []) if stamps else []
        starts = list(getattr(stamps, "start_time_seconds", []) or []) if stamps else []
        ends = list(getattr(stamps, "end_time_seconds", []) or []) if stamps else []

        if chunks and starts and ends:
            for text, st, en in zip(chunks, starts, ends):
                text = (text or "").strip()
                if not text:
                    continue
                # >>> the offset addition that puts chunks on a global timeline
                segments.append(Segment(0, offset + float(st), offset + float(en), text))
        else:
            # Timestamps missing (or with_timestamps unsupported) — keep the
            # transcript rather than losing the chunk entirely.
            text = (getattr(resp, "transcript", "") or "").strip()
            if text:
                segments.append(Segment(0, offset, offset, text))

    segments.sort(key=lambda s: (s.start, s.end))
    for i, seg in enumerate(segments):
        seg.id = i
        seg.words = estimate_words(seg.text, seg.start, seg.end)

    language = max(set(languages), key=languages.count) if languages else "unknown"
    return segments, language


def transcribe(
    path: Path,
    *,
    language_code: str = "unknown",
    use_cache: bool = True,
    on_progress: Callable[[str], None] | None = None,
) -> Transcript:
    """Transcribe a media file, returning segments on a global timeline."""
    digest = media.file_hash(path)
    cache_file = config.CACHE_DIR / f"{digest}-{config.STT_MODEL.replace(':', '_')}.json"

    if use_cache and cache_file.exists():
        # A torn or truncated entry is not worth failing the job over — the bot
        # and the web server share this directory, so a reader can arrive while
        # a writer is mid-flight. Fall through and transcribe again instead.
        try:
            cached = Transcript.from_dict(json.loads(cache_file.read_text()))
        except (json.JSONDecodeError, OSError, KeyError, TypeError) as exc:
            log.warning("ignoring unreadable transcript cache %s: %s", cache_file.name, exc)
        else:
            log.info("transcript cache hit: %s", cache_file.name)
            if on_progress:
                on_progress("Using cached transcript")
            return cached

    workdir = media.new_workdir("stt")
    wav = media.extract_audio(path, workdir / "audio.wav")
    duration = media.duration_of(wav)

    spans = media.plan_chunks(wav, duration)
    log.info("chunked %.1fs into %d spans", duration, len(spans))
    if on_progress:
        on_progress(f"Transcribing {duration:.0f}s in {len(spans)} chunks")

    pieces: list[tuple[float, Path]] = []
    for i, (start, end) in enumerate(spans):
        piece = workdir / f"chunk{i:03d}.wav"
        media.slice_audio(wav, start, end, piece)
        pieces.append((start, piece))

    def work(item: tuple[float, Path]):
        offset, chunk_path = item
        return offset, sarvam.transcribe_chunk(chunk_path, language_code=language_code)

    workers = min(config.STT_MAX_WORKERS, max(1, len(pieces)))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        results = list(pool.map(work, pieces))

    segments, language = _stitch(results)
    transcript = Transcript(language=language, duration=duration, segments=segments)

    # Write-then-rename: os.replace is atomic on POSIX, so a concurrent reader
    # sees either the previous entry or the complete new one, never a partial.
    tmp = cache_file.with_name(f"{cache_file.name}.{os.getpid()}-{uuid4().hex[:8]}.tmp")
    try:
        tmp.write_text(json.dumps(transcript.to_dict(), ensure_ascii=False, indent=2))
        os.replace(tmp, cache_file)
    except OSError as exc:
        log.warning("could not write transcript cache %s: %s", cache_file.name, exc)
        tmp.unlink(missing_ok=True)
    log.info("transcribed: %d segments, language=%s", len(segments), language)
    if on_progress:
        on_progress(f"{len(segments)} segments, detected {config.language_label(language)}")
    return transcript
