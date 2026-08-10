"""Dubbing: Sarvam Dub (voice cloning) with a manual TTS fallback.

The primary path is Sarvam's Dubbing API, which handles transcription,
translation, synthesis, speaker voice cloning and timeline alignment in one job
and can also hand back an SRT.

The fallback path rebuilds a dub locally from Translate + Bulbul TTS. It is
worse (no voice cloning, no speaker separation) but it is fully synchronous and
depends on nothing that might be gated on the account — worth keeping for a
live demo.
"""

from __future__ import annotations

import logging
import mimetypes
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import requests

from . import config, media, sarvam
from .transcribe import Segment

log = logging.getLogger("clipit.dubbing")

Progress = Callable[[str], None]


class DubbingError(RuntimeError):
    pass


@dataclass
class DubResult:
    audio: Path | None = None
    video: Path | None = None
    srt: Path | None = None
    engine: str = "sarvam"
    voice_cloned: bool = False

    @property
    def media_path(self) -> Path | None:
        return self.video or self.audio


# --------------------------------------------------------------------------
# Sarvam Dub
# --------------------------------------------------------------------------

def _create_job(client, source: str, target: str, want_video: bool,
                voice_cloning: bool, num_speakers: int, disable_watermark: bool):
    exports = ["audio", "srt"] + (["video"] if want_video else [])
    return client.dubbing.create(
        source_language_code=config.to_dub_code(source),
        target_language_codes=[config.to_dub_code(target)],
        export_options=exports,
        voice_cloning=voice_cloning,
        num_speakers=num_speakers,
        pace_preset="normal",
        register="auto",
        disable_watermark=disable_watermark,
        job_name=f"clipit-{int(time.time())}",
    )


def _upload(upload_url: str, path: Path) -> None:
    mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    with open(path, "rb") as fh:
        resp = requests.put(
            upload_url,
            data=fh,
            headers={
                "Content-Type": mime,
                # Azure blob storage requires this or the PUT is rejected.
                "x-ms-blob-type": "BlockBlob",
            },
            timeout=300,
        )
    if not resp.ok:
        raise DubbingError(f"upload failed ({resp.status_code}): {resp.text[:200]}")


def _download(url: str, dest: Path) -> Path:
    resp = requests.get(url, stream=True, timeout=300)
    resp.raise_for_status()
    with open(dest, "wb") as fh:
        for block in resp.iter_content(1 << 16):
            fh.write(block)
    return dest


def dub_with_sarvam(path: Path, target: str, workdir: Path, *,
                    source: str = "en-IN", is_video: bool = False,
                    voice_cloning: bool = True, num_speakers: int = 1,
                    on_progress: Progress | None = None) -> DubResult:
    client = sarvam.client()

    def say(msg: str) -> None:
        log.info(msg)
        if on_progress:
            on_progress(msg)

    say("Creating dubbing job")
    try:
        job = _create_job(client, source, target, is_video, voice_cloning,
                          num_speakers, disable_watermark=True)
    except Exception as exc:  # noqa: BLE001
        # Watermark removal is a paid feature on some plans — retry watermarked
        # rather than failing the whole request.
        if "watermark" in str(exc).lower():
            say("Watermark removal not permitted on this plan; retrying with watermark")
            job = _create_job(client, source, target, is_video, voice_cloning,
                              num_speakers, disable_watermark=False)
        else:
            raise

    data = getattr(job, "data", job)
    job_id = getattr(data, "job_id", None)
    upload_url = getattr(data, "upload_url", None)
    if not job_id or not upload_url:
        raise DubbingError(f"dubbing.create returned no job_id/upload_url: {job!r}")

    say("Uploading media")
    _upload(upload_url, path)

    say("Starting dub")
    sarvam.retry(client.dubbing.start, job_id=job_id)

    deadline = time.time() + config.DUB_TIMEOUT_SECONDS
    last_label = ""
    while True:
        if time.time() > deadline:
            raise DubbingError("dubbing job timed out")
        status_resp = sarvam.retry(client.dubbing.get_live_status, job_id=job_id)
        sdata = getattr(status_resp, "data", status_resp)
        status = (getattr(sdata, "status", "") or "").lower()
        label = getattr(sdata, "current_step_label", None) or getattr(sdata, "current_step", "") or ""
        pct = getattr(sdata, "progress", None)

        if label and label != last_label:
            last_label = label
            say(f"{label}{f' {pct}%' if isinstance(pct, int) else ''}")

        if status in ("completed", "partial_failure"):
            break
        if status == "failed":
            raise DubbingError(getattr(sdata, "error_message", None) or "dubbing job failed")
        time.sleep(config.DUB_POLL_SECONDS)

    # The job reports 100% before its exports finish rendering, so poll
    # export-status until the items actually carry download URLs.
    say("Fetching dubbed output")
    items: list = []
    export_deadline = min(time.time() + 180.0, deadline + 180.0)
    while True:
        exports_resp = sarvam.retry(client.dubbing.get_export_status, job_id=job_id)
        edata = getattr(exports_resp, "data", exports_resp)
        items = list(getattr(edata, "exports", None)
                     or getattr(edata, "items", None) or [])
        ready = [i for i in items if getattr(i, "download_url", None)]
        wanted = 2 if is_video else 1  # media (+srt); srt alone isn't enough
        media_ready = any(
            (getattr(i, "export_type", "") or "").lower() in ("video", "audio", "mp3")
            for i in ready
        )
        if media_ready or (ready and len(ready) >= wanted):
            items = ready
            break
        if time.time() > export_deadline:
            if ready:
                items = ready
                break
            raise DubbingError("dubbing exports never became downloadable")
        time.sleep(config.DUB_POLL_SECONDS)

    result = DubResult(engine="sarvam", voice_cloned=voice_cloning)
    for item in items:
        url = getattr(item, "download_url", None)
        kind = (getattr(item, "export_type", "") or "").lower()
        if not url:
            continue
        if kind == "video" and result.video is None:
            result.video = _download(url, workdir / "dub_video.mp4")
        elif kind in ("audio", "mp3") and result.audio is None:
            # Sarvam hands back a mastered WAV; keep the real extension.
            ext = ".wav" if ".wav" in url.split("?")[0].lower() else ".mp3"
            result.audio = _download(url, workdir / f"dub_audio{ext}")
        elif kind == "srt" and result.srt is None:
            result.srt = _download(url, workdir / "dub.srt")

    # Sarvam does not reliably return a video export even when one is requested
    # — often only audio + srt come back. Without this, media_path falls through
    # to the audio and a dubbed *video* silently exports as a bare .wav. Mux the
    # dubbed track onto the original picture instead, which is exactly what
    # dub_manual already does for its own output.
    if is_video and result.video is None and result.audio is not None:
        say("No video export returned; muxing the dubbed track onto the source")
        result.video = media.replace_audio(path, result.audio,
                                           workdir / "dub_video.mp4")

    if result.media_path is None:
        raise DubbingError("dubbing job completed but produced no downloadable media")
    return result


# --------------------------------------------------------------------------
# Manual fallback: Translate + Bulbul TTS, fitted to the original timing
# --------------------------------------------------------------------------

def synthesize(text: str, language: str, workdir: Path, *,
               speaker: str | None = None, pace: float = 1.0,
               tail: float = 0.12) -> Path:
    """Render a short phrase to a WAV sized for splicing into existing audio.

    Bulbul returns speech noticeably quieter than broadcast media, so a raw TTS
    clip dropped into a video sounds like it came from another room. loudnorm
    puts it on the same footing as the surrounding audio; the tail pad keeps the
    following word from landing on top of it.
    """
    raw = workdir / f"say-{uuid.uuid4().hex[:8]}.wav"
    raw.write_bytes(sarvam.tts(text, language, speaker=speaker, pace=pace))

    dest = raw.with_name(raw.stem + "-norm.wav")
    media.ffmpeg("-i", raw, "-af",
                 f"loudnorm=I=-16:TP=-1.5:LRA=11,apad=pad_dur={max(tail, 0.0):.3f}",
                 "-c:a", "pcm_s16le", "-loglevel", "error", dest)
    return dest


def _srt_time(seconds: float) -> str:
    ms = int(round(seconds * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def dub_manual(path: Path, target: str, workdir: Path, segments: list[Segment],
               *, source: str = "en-IN", is_video: bool = False,
               speaker: str | None = None,
               on_progress: Progress | None = None) -> DubResult:
    """Rebuild a dub locally: translate each segment, synthesise, time-fit, mix."""
    def say(msg: str) -> None:
        log.info(msg)
        if on_progress:
            on_progress(msg)

    total = media.duration_of(path)
    usable = [s for s in segments if s.text.strip() and s.end > s.start]
    if not usable:
        raise DubbingError("no speech segments to dub")

    say(f"Translating {len(usable)} segments to {config.language_label(target)}")
    pieces: list[tuple[float, Path]] = []
    srt_lines: list[str] = []

    for i, seg in enumerate(usable):
        translated = sarvam.translate(seg.text, target, source=source)
        if not translated.strip():
            continue

        srt_lines.append(
            f"{len(srt_lines) + 1}\n"
            f"{_srt_time(seg.start)} --> {_srt_time(seg.end)}\n{translated}\n"
        )

        raw = workdir / f"tts{i:03d}.wav"
        raw.write_bytes(sarvam.tts(translated, target, speaker=speaker))
        fitted = media.fit_duration(raw, seg.end - seg.start, workdir / f"fit{i:03d}.wav")
        pieces.append((seg.start, fitted))

        if on_progress and (i + 1) % 5 == 0:
            say(f"Synthesised {i + 1}/{len(usable)} segments")

    if not pieces:
        raise DubbingError("translation produced no usable text")

    say("Assembling dubbed track")
    inputs: list[object] = []
    for _, piece in pieces:
        inputs += ["-i", str(piece)]

    filters = []
    labels = []
    for idx, (start, _) in enumerate(pieces):
        delay_ms = int(round(start * 1000))
        filters.append(f"[{idx}:a]adelay={delay_ms}|{delay_ms}[d{idx}]")
        labels.append(f"[d{idx}]")
    # normalize=0 matters: amix otherwise divides every input's volume by N.
    filters.append(f"{''.join(labels)}amix=inputs={len(pieces)}:normalize=0[mixed]")
    filters.append(f"[mixed]apad,atrim=0:{total:.3f}[out]")

    track = workdir / "dub_track.wav"
    media.ffmpeg(*inputs, "-filter_complex", ";".join(filters), "-map", "[out]",
                 "-c:a", "pcm_s16le", "-loglevel", "error", track)

    srt = workdir / "dub.srt"
    srt.write_text("\n".join(srt_lines), encoding="utf-8")

    result = DubResult(engine="manual", voice_cloned=False, srt=srt)
    if is_video:
        result.video = media.replace_audio(path, track, workdir / "dub_video.mp4")
    else:
        out = workdir / "dub_audio.mp3"
        media.ffmpeg("-i", track, "-c:a", "libmp3lame", "-q:a", "2",
                     "-loglevel", "error", out)
        result.audio = out
    return result
