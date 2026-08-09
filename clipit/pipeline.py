"""Orchestrator: instruction + media in, edited file out.

``run()`` is a generator of :class:`Event` so any surface (Telegram, HTTP/SSE,
CLI) can stream the same progress without the engine knowing who is watching.

Three scheduling rules live in :func:`_schedule` and matter a lot:

1. ``denoise`` is hoisted *before* transcription when the plan also needs
   ``find`` — cleaner audio transcribes better, and one filter pass then serves
   both the transcript and the output.
2. Transcription is skipped entirely when nothing needs it (a whole-file dub),
   because Sarvam Dub transcribes internally.
3. ``concat`` is inserted automatically when more than one clip is found.
"""

from __future__ import annotations

import logging
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator

from . import config, dubbing, media
from .agent import Clip, Plan, Point, locate_clips, locate_insert_point, make_plan
from .media import MediaError, MediaInfo, MediaKind
from .transcribe import Segment, Transcript, transcribe

log = logging.getLogger("clipit.pipeline")


@dataclass
class Event:
    stage: str
    status: str = "running"          # running | done | error | info
    message: str = ""
    data: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {"stage": self.stage, "status": self.status,
                "message": self.message, **({"data": self.data} if self.data else {})}


@dataclass
class Result:
    output: Path | None = None
    srt: Path | None = None
    clips: list[Clip] = field(default_factory=list)
    points: list[Point] = field(default_factory=list)
    plan: Plan | None = None
    transcript: Transcript | None = None
    kind: MediaKind = MediaKind.AUDIO
    notes: list[str] = field(default_factory=list)
    dub_engine: str | None = None
    voice_cloned: bool = False

    def to_dict(self) -> dict:
        return {
            "output": str(self.output) if self.output else None,
            "srt": str(self.srt) if self.srt else None,
            "clips": [c.to_dict() for c in self.clips],
            "points": [p.to_dict() for p in self.points],
            "plan": self.plan.to_dict() if self.plan else None,
            "kind": self.kind.value,
            "notes": self.notes,
            "dub_engine": self.dub_engine,
            "voice_cloned": self.voice_cloned,
        }


def _schedule(plan: Plan) -> tuple[list[dict], bool, bool]:
    """Return (ordered ops, denoise_before_stt, needs_transcript)."""
    ops = [dict(o) for o in plan.ops]
    names = [o["op"] for o in ops]

    needs_transcript = "find" in names or "insert" in names
    denoise_first = "denoise" in names and needs_transcript

    if denoise_first:
        ops = [o for o in ops if o["op"] != "denoise"]

    # `insert` is hoisted ahead of everything else so it always runs against the
    # media the transcript describes. Both `insert` and `find` resolve their
    # timestamps from that one transcript; letting a trim land first would leave
    # the insert pointing into footage that no longer exists.
    if "insert" in names:
        inserts = [o for o in ops if o["op"] == "insert"]
        ops = inserts + [o for o in ops if o["op"] != "insert"]

    return ops, denoise_first, needs_transcript


def _shift_for_inserts(when: float, inserts: list[tuple[float, float, str]],
                       *, inclusive: bool = False) -> float:
    """Map an original-timeline instant onto the post-insert timeline.

    ``inclusive`` decides which side of an insertion an instant sitting exactly
    on it belongs to — a segment *starting* there comes after the new words, a
    segment *ending* there comes before them.
    """
    shifted = when
    for at, added, _ in inserts:
        if when > at or (inclusive and when >= at):
            shifted += added
    return shifted


def _split_segment(segment: Segment, at: float) -> tuple[Segment, Segment] | None:
    """Cut a segment in two at ``at``, using its word timings."""
    before = [w for w in segment.words if w.end <= at]
    after = [w for w in segment.words if w.end > at]
    if not before or not after:
        return None
    return (
        Segment(segment.id, segment.start, before[-1].end,
                " ".join(w.text for w in before), before),
        Segment(segment.id, at, segment.end,
                " ".join(w.text for w in after), after),
    )


def _segments_after_inserts(transcript: Transcript,
                            inserts: list[tuple[float, float, str]]) -> list[Segment]:
    """Transcript segments re-timed onto the post-insert timeline.

    The spliced words become segments of their own, so a dub that follows an
    insert speaks them too instead of leaving a silent hole. Segments that the
    insertion lands inside are split at that point first — otherwise the dub
    stretches the original line across the new words and the two overlap.
    """
    if not inserts:
        return list(transcript.segments)

    pieces = list(transcript.segments)
    for at, _, _ in inserts:
        rebuilt: list[Segment] = []
        for segment in pieces:
            halves = _split_segment(segment, at) if segment.start < at < segment.end else None
            rebuilt.extend(halves if halves else [segment])
        pieces = rebuilt

    segments = [Segment(s.id, _shift_for_inserts(s.start, inserts, inclusive=True),
                        _shift_for_inserts(s.end, inserts), s.text)
                for s in pieces]
    for at, added, text in inserts:
        start = _shift_for_inserts(at, inserts)
        segments.append(Segment(-1, start, start + added, text))

    segments.sort(key=lambda s: (s.start, s.end))
    for i, segment in enumerate(segments):
        segment.id = i
    return segments


def run(source: str | Path, instruction: str, *,
        dub_engine: str = "auto",
        max_clips: int = 3,
        speaker: str | None = None,
        use_cache: bool = True,
        workdir: Path | None = None) -> Iterator[Event]:
    """Execute an instruction against a media source, yielding progress events.

    The final event carries ``data["result"]`` with a :class:`Result` object.
    """
    workdir = workdir or media.new_workdir("job")
    result = Result()

    try:
        # ---------------------------------------------------------------- plan
        yield Event("plan", "running", "Understanding the instruction")
        plan = make_plan(instruction)
        result.plan = plan
        yield Event("plan", "done", " -> ".join(plan.op_names()),
                    {"plan": plan.to_dict()})

        if plan.unsupported_language:
            supported = ", ".join(
                sorted(config.language_label(c) for c in config.DUB_LANGUAGES)
            )
            result.notes.append(
                f"I can't dub into {plan.unsupported_language}. "
                f"Sarvam supports: {supported}."
            )
            yield Event("plan", "info", result.notes[-1])

        # -------------------------------------------------------------- ingest
        yield Event("ingest", "running", "Fetching the media")
        info: MediaInfo = media.ingest(source, workdir)
        result.kind = info.kind
        yield Event("ingest", "done",
                    f"{info.kind.value} · {info.duration:.0f}s",
                    {"duration": info.duration, "kind": info.kind.value})

        ops, denoise_first, needs_transcript = _schedule(plan)
        current = info.path
        is_video = info.is_video

        # ------------------------------------------------- denoise (hoisted)
        if denoise_first:
            yield Event("denoise", "running", "Removing background noise")
            cleaned = workdir / f"clean{current.suffix if is_video else '.mp3'}"
            current = media.denoise(current, cleaned, is_video=is_video)
            yield Event("denoise", "done", "Noise removed (before transcription)")

        # ---------------------------------------------------------- transcribe
        transcript: Transcript | None = None
        if needs_transcript:
            yield Event("transcribe", "running", "Transcribing")
            messages: list[str] = []
            transcript = transcribe(current, use_cache=use_cache,
                                    on_progress=messages.append)
            result.transcript = transcript
            yield Event("transcribe", "done",
                        messages[-1] if messages else f"{len(transcript.segments)} segments",
                        {"language": transcript.language,
                         "segments": len(transcript.segments)})

        source_lang = transcript.language if transcript and transcript.language != "unknown" else "en-IN"

        # ------------------------------------------------------ execute ops
        clips: list[Clip] = []
        pieces: list[Path] = []
        inserts: list[tuple[float, float, str]] = []   # (original time, seconds added, text)

        for op in ops:
            name, args = op["op"], op.get("args") or {}

            if name == "insert":
                text = str(args.get("text") or "").strip()
                if not text:
                    continue
                anchor = str(args.get("anchor") or "").strip()
                position = str(args.get("position") or "after").lower()

                where = f'{position} "{anchor}"' if anchor else "in"
                yield Event("insert", "running", f'Placing "{text}" {where}')

                point = locate_insert_point(transcript, anchor or instruction,
                                            position=position) if transcript else None
                if point is None:
                    result.notes.append(
                        f"I couldn't find \"{anchor or text}\" in this media, "
                        f"so there was nowhere to add \"{text}\"."
                    )
                    yield Event("insert", "error", result.notes[-1])
                    yield Event("done", "error", result.notes[-1], {"result": result})
                    return

                # Bulbul covers fewer languages than STT; English is the safe
                # default for a source language it cannot speak.
                voice_lang = source_lang if source_lang in config.TTS_LANGUAGES else "en-IN"
                spoken = dubbing.synthesize(text, voice_lang, workdir, speaker=speaker)
                added = media.duration_of(spoken)

                dest = workdir / f"spliced{len(inserts):02d}{'.mp4' if is_video else '.mp3'}"
                current = media.splice(current,
                                       _shift_for_inserts(point.time, inserts),
                                       spoken, dest, is_video=is_video)
                inserts.append((point.time, added, text))
                pieces = []
                result.points.append(point)

                yield Event("insert", "done",
                            f'Added "{text}" at {point.time:.2f}s (+{added:.2f}s)',
                            {"point": point.to_dict(), "seconds_added": round(added, 3)})

            if name == "find":
                query = str(args.get("query") or instruction)
                limit = int(args.get("max_clips") or max_clips)
                yield Event("find", "running", f"Searching for: {query}")
                clips = locate_clips(transcript, query, max_clips=limit,
                                     padding=float(args.get("padding_seconds")
                                                   or config.DEFAULT_PADDING)) if transcript else []
                result.clips = clips
                if not clips:
                    result.notes.append(
                        f"I couldn't find anything matching \"{query}\" in this media."
                    )
                    yield Event("find", "error", result.notes[-1])
                    yield Event("done", "error", result.notes[-1], {"result": result})
                    return
                yield Event("find", "done",
                            f"{len(clips)} match(es): " + ", ".join(
                                f"{c.start:.1f}-{c.end:.1f}s" for c in clips),
                            {"clips": [c.to_dict() for c in clips]})

            elif name == "trim":
                if not clips:
                    continue
                yield Event("trim", "running", f"Cutting {len(clips)} clip(s)")
                pieces = []
                for i, clip in enumerate(clips):
                    dest = workdir / f"clip{i:02d}{'.mp4' if is_video else '.mp3'}"
                    # Clips were located on the original transcript; if words
                    # were spliced in since, the media is longer than it was.
                    pieces.append(media.cut(current,
                                            _shift_for_inserts(clip.start, inserts),
                                            _shift_for_inserts(clip.end, inserts),
                                            dest, is_video=is_video))
                current = pieces[0]
                yield Event("trim", "done", f"Cut {len(pieces)} clip(s)")

            elif name == "denoise":
                yield Event("denoise", "running", "Removing background noise")
                targets = pieces or [current]
                cleaned_paths = []
                for i, p in enumerate(targets):
                    dest = workdir / f"clean{i:02d}{'.mp4' if is_video else '.mp3'}"
                    cleaned_paths.append(media.denoise(p, dest, is_video=is_video))
                pieces = cleaned_paths if pieces else []
                current = cleaned_paths[0]
                yield Event("denoise", "done", "Noise removed")

            elif name == "concat":
                if len(pieces) > 1:
                    yield Event("concat", "running", f"Joining {len(pieces)} clips")
                    dest = workdir / f"joined{'.mp4' if is_video else '.mp3'}"
                    current = media.concat(pieces, dest, is_video=is_video)
                    pieces = [current]
                    yield Event("concat", "done", "Supercut assembled")

            elif name == "dub":
                target = config.resolve_language(args.get("target_language_code")) \
                    or plan.target_language
                if not target:
                    continue

                # Join first so we dub one file, not N.
                if len(pieces) > 1:
                    dest = workdir / f"joined{'.mp4' if is_video else '.mp3'}"
                    current = media.concat(pieces, dest, is_video=is_video)
                    pieces = [current]

                label = config.language_label(target)
                yield Event("dub", "running", f"Dubbing into {label}")

                messages: list[str] = []

                def note(msg: str) -> None:
                    messages.append(msg)

                dubbed = None
                if dub_engine in ("auto", "sarvam"):
                    try:
                        dubbed = dubbing.dub_with_sarvam(
                            current, target, workdir,
                            source=source_lang, is_video=is_video,
                            on_progress=note)
                    except Exception as exc:  # noqa: BLE001
                        log.warning("Sarvam Dub failed: %s", exc)
                        if dub_engine == "sarvam":
                            raise
                        result.notes.append(f"Sarvam Dub unavailable ({exc}); used local TTS.")
                        yield Event("dub", "info", "Sarvam Dub unavailable, falling back to TTS")

                if dubbed is None:
                    if transcript is None:
                        yield Event("transcribe", "running", "Transcribing for dub")
                        transcript = transcribe(current, use_cache=use_cache)
                        result.transcript = transcript
                        source_lang = transcript.language if transcript.language != "unknown" else "en-IN"
                    segs = _segments_after_inserts(transcript, inserts)
                    if clips:
                        lo = _shift_for_inserts(clips[0].start, inserts)
                        hi = _shift_for_inserts(clips[0].end, inserts)
                        segs = [Segment(s.id, max(0.0, s.start - lo),
                                        max(0.0, s.end - lo), s.text)
                                for s in segs if s.end > lo and s.start < hi]
                    dubbed = dubbing.dub_manual(
                        current, target, workdir, segs,
                        source=source_lang, is_video=is_video,
                        speaker=speaker, on_progress=note)

                current = dubbed.media_path
                pieces = [current]
                result.srt = dubbed.srt
                result.dub_engine = dubbed.engine
                result.voice_cloned = dubbed.voice_cloned
                yield Event("dub", "done",
                            f"Dubbed into {label}"
                            + (" with voice cloning" if dubbed.voice_cloned else ""),
                            {"engine": dubbed.engine})

            elif name == "export":
                yield Event("export", "running", "Finalising")
                if len(pieces) > 1:
                    dest = workdir / f"joined{'.mp4' if is_video else '.mp3'}"
                    current = media.concat(pieces, dest, is_video=is_video)

                suffix = current.suffix or (".mp4" if is_video else ".mp3")
                final = workdir / f"clipit_output{suffix}"
                if current.resolve() != final.resolve():
                    shutil.copy(current, final)
                result.output = final
                yield Event("export", "done", f"OUTPUT_FILE: {final}",
                            {"output": str(final)})

        yield Event("done", "done", "Finished", {"result": result})

    except MediaError as exc:
        yield Event("error", "error", str(exc), {"result": result})
    except Exception as exc:  # noqa: BLE001
        log.exception("pipeline failed")
        yield Event("error", "error", f"{type(exc).__name__}: {exc}", {"result": result})


def run_to_completion(source: str | Path, instruction: str, **kwargs) -> Result:
    """Convenience wrapper for callers that don't want the event stream."""
    result = Result()
    for event in run(source, instruction, **kwargs):
        if "result" in event.data:
            result = event.data["result"]
        if event.status == "error" and event.stage == "error":
            raise RuntimeError(event.message)
    return result
