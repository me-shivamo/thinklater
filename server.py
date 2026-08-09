"""FastAPI HTTP/SSE adapter over the ClipCraft engine.

This is the *only* backend surface the React web editor (``web/``) talks to. It
implements the frozen §5 contract from ``Plan.md`` and does nothing more than
adapt :mod:`clipcraft` <-> that contract:

    POST /api/ingest             {url} | multipart file  -> {job_id, media_id}
    GET  /api/media/{media_id}   bytes (HTTP Range / 206) -> <video> source
    GET  /api/transcript/{id}    -> {language, duration, segments:[...]}
    POST /api/instruct           {media_id, instruction}  -> {job_id}
    GET  /api/events/{job_id}    -> SSE stream of ProgressEvent
    GET  /api/result/{job_id}    -> {clips, output_url, srt_url, plan}
    GET  /api/download/{job_id}  -> final file (HTTP Range / 206)
    GET  /api/jobs/{job_id}      -> polling fallback {status, event}

The engine is *not* reimplemented here; every endpoint calls into
``clipcraft.pipeline`` / ``clipcraft.media`` / ``clipcraft.transcribe``. The
pipeline is a blocking generator, so ``/api/instruct`` runs it on a worker
thread and buffers its events for the SSE and polling endpoints.
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse

from clipcraft import media, pipeline
from clipcraft.media import MediaError, MediaInfo
from clipcraft.transcribe import transcribe

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("clipcraft.server")

app = FastAPI(title="ClipCraft backend", version="1.0")

# The Vite dev server proxies /api so requests are same-origin, but keep CORS
# permissive so the UI also works if pointed straight at :8000 during dev.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_origin_regex=r"https?://(localhost|127\.0\.0\.1)(:\d+)?",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
)


# ---------------------------------------------------------------------------
# In-memory registries (one process, one video at a time is fine for the demo)
# ---------------------------------------------------------------------------
@dataclass
class MediaEntry:
    media_id: str
    path: Path
    workdir: Path
    info: MediaInfo


@dataclass
class Job:
    id: str
    media_id: str | None = None
    instruction: str = ""
    events: list[dict] = field(default_factory=list)   # serialized SSE payloads
    status: str = "running"                             # running | done | error
    result: Any = None                                  # clipcraft.pipeline.Result
    done: bool = False
    lock: threading.Lock = field(default_factory=threading.Lock)


@dataclass
class EditResult:
    """Result of a manual EDL edit — shaped like a pipeline Result so it flows
    through the existing ``/api/download`` (and ``/api/result``) plumbing."""

    output: Path
    srt: Path | None = None
    clips: list = field(default_factory=list)
    plan: Any = None
    notes: list = field(default_factory=list)


MEDIA: dict[str, MediaEntry] = {}
JOBS: dict[str, Job] = {}


# ---------------------------------------------------------------------------
# Progress → percent. Synthesized because the engine emits stages, not a pct.
# Values are the "in-flight" percent for a stage; status=="done" bumps toward
# the next stage. A monotonic guard on the job keeps pct from ever regressing.
# ---------------------------------------------------------------------------
STAGE_PCT: dict[str, int] = {
    "plan": 10,
    "ingest": 20,
    "denoise": 30,
    "transcribe": 45,
    "find": 60,
    "trim": 72,
    "concat": 80,
    "dub": 92,
    "export": 97,
    "done": 100,
    "result": 100,
    "error": 100,
}


def _pct_for(stage: str, status: str, prev: int) -> int:
    base = STAGE_PCT.get(stage, prev)
    if status == "done" and stage not in ("done", "result", "error"):
        base = min(99, base + 6)
    return max(prev, base)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _media_type(path: Path, info: MediaInfo | None = None) -> str:
    suffix = path.suffix.lower()
    if suffix in {".mp4", ".mov", ".mkv", ".webm", ".m4v"}:
        return "video/mp4" if suffix != ".webm" else "video/webm"
    if suffix == ".srt":
        return "application/x-subrip"
    if suffix in {".mp3", ".m4a", ".aac"}:
        return "audio/mpeg"
    if suffix == ".wav":
        return "audio/wav"
    if info is not None:
        return "video/mp4" if info.is_video else "audio/mpeg"
    return "application/octet-stream"


def _file_response(path: Path, *, media_type: str, download_name: str | None = None) -> FileResponse:
    # Starlette's FileResponse implements HTTP Range (206) and sets
    # Accept-Ranges automatically — verified with `curl -r 0-100 -D -`.
    headers = {"Accept-Ranges": "bytes"}
    return FileResponse(
        str(path),
        media_type=media_type,
        headers=headers,
        filename=download_name,
    )


def _run_pipeline(job: Job, source: str, instruction: str) -> None:
    """Worker thread: drive the blocking pipeline and buffer its events."""
    prev_pct = 0
    try:
        for event in pipeline.run(source=source, instruction=instruction):
            prev_pct = _pct_for(event.stage, event.status, prev_pct)
            payload = {
                "stage": event.stage,
                "status": event.status,
                "message": event.message,
                "pct": prev_pct,
            }

            terminal = event.stage in ("done", "error") or "result" in event.data
            if terminal:
                result = event.data.get("result")
                with job.lock:
                    if result is not None:
                        job.result = result
                    job.events.append(payload)
                    # Emit the synthetic terminal the frontend waits for.
                    job.events.append(
                        {"stage": "result", "status": "done", "message": "Done", "pct": 100}
                    )
                    job.status = "error" if event.status == "error" else "done"
                    job.done = True
                return

            with job.lock:
                job.events.append(payload)
    except Exception as exc:  # noqa: BLE001 - never let a worker thread die silently
        log.exception("pipeline worker crashed")
        with job.lock:
            job.events.append(
                {"stage": "error", "status": "error",
                 "message": f"{type(exc).__name__}: {exc}", "pct": 100}
            )
            job.events.append(
                {"stage": "result", "status": "error", "message": "Failed", "pct": 100}
            )
            job.status = "error"
            job.done = True


def _apply_edit(
    entry: MediaEntry,
    ranges: list[tuple[float, float]],
    effects: list[tuple[float, float, float]] | None = None,
) -> Path:
    """Cut each kept range, concat them, then bake any zoom windows.

    Pure ffmpeg (``clipcraft.media.cut`` / ``concat`` / ``zoom``) — needs no
    Sarvam key. ``effects`` are ``(start, end, scale)`` windows already expressed
    over the trimmed output timeline; they only apply to video.
    """
    workdir = media.new_workdir("edit")
    is_video = entry.info.is_video
    ext = ".mp4" if is_video else ".mp3"
    parts: list[Path] = []
    for i, (start, end) in enumerate(ranges):
        dest = workdir / f"part{i:03d}{ext}"
        media.cut(entry.path, start, end, dest, is_video=is_video)
        parts.append(dest)
    out = workdir / f"edit{ext}"
    media.concat(parts, out, is_video=is_video)  # concat() copies when len==1

    if effects and is_video:
        zoomed = workdir / f"edit-zoom{ext}"
        media.zoom(out, effects, zoomed)
        out = zoomed
    return out


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------
@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "media": len(MEDIA), "jobs": len(JOBS)}


@app.post("/api/ingest")
async def ingest(request: Request, file: UploadFile | None = File(default=None)) -> dict:
    """Accept a JSON ``{url}`` or a multipart ``file`` and ingest it."""
    workdir = media.new_workdir("ingest")

    try:
        if file is not None:
            dest = workdir / f"upload{Path(file.filename or 'source').suffix or '.bin'}"
            data = await file.read()
            dest.write_bytes(data)
            info = await asyncio.to_thread(media.ingest, dest, workdir)
        else:
            body = {}
            try:
                body = await request.json()
            except Exception:  # noqa: BLE001 - empty / non-JSON body
                body = {}
            url = (body or {}).get("url")
            if not url:
                raise HTTPException(status_code=400, detail="Provide a 'url' or a 'file'.")
            info = await asyncio.to_thread(media.ingest, url, workdir)
    except MediaError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        log.exception("ingest failed")
        raise HTTPException(status_code=502, detail=f"Ingest failed: {exc}") from exc

    media_id = uuid.uuid4().hex[:12]
    MEDIA[media_id] = MediaEntry(media_id=media_id, path=info.path, workdir=workdir, info=info)

    job_id = uuid.uuid4().hex[:12]
    JOBS[job_id] = Job(id=job_id, media_id=media_id)
    return {"job_id": job_id, "media_id": media_id}


@app.get("/api/media/{media_id}")
def get_media(media_id: str):
    entry = MEDIA.get(media_id)
    if entry is None or not entry.path.exists():
        raise HTTPException(status_code=404, detail="Unknown media_id")
    return _file_response(entry.path, media_type=_media_type(entry.path, entry.info))


@app.get("/api/transcript/{media_id}")
async def get_transcript(media_id: str):
    entry = MEDIA.get(media_id)
    if entry is None or not entry.path.exists():
        raise HTTPException(status_code=404, detail="Unknown media_id")

    try:
        transcript = await asyncio.to_thread(transcribe, entry.path, use_cache=True)
    except Exception as exc:  # noqa: BLE001 - surface a clean JSON error, not a 500 trace
        log.warning("transcription failed for %s: %s", media_id, exc)
        return JSONResponse(
            status_code=502,
            content={"error": "transcription_failed", "detail": str(exc)},
        )

    return {
        "language": transcript.language,
        "duration": entry.info.duration,  # authoritative duration from ingest probe
        "segments": [
            {"id": s.id, "start": s.start, "end": s.end, "text": s.text}
            for s in transcript.segments
        ],
    }


@app.post("/api/instruct")
async def instruct(request: Request) -> dict:
    try:
        body = await request.json()
    except Exception as exc:  # noqa: BLE001 - malformed body -> 400, not 500
        raise HTTPException(status_code=400, detail=f"Invalid JSON body: {exc}") from exc
    media_id = body.get("media_id")
    instruction = (body.get("instruction") or "").strip()
    if not media_id or not instruction:
        raise HTTPException(status_code=400, detail="media_id and instruction are required.")

    entry = MEDIA.get(media_id)
    if entry is None or not entry.path.exists():
        raise HTTPException(status_code=404, detail="Unknown media_id")

    job_id = uuid.uuid4().hex[:12]
    job = Job(id=job_id, media_id=media_id, instruction=instruction)
    JOBS[job_id] = job

    thread = threading.Thread(
        target=_run_pipeline,
        args=(job, str(entry.path), instruction),
        daemon=True,
    )
    thread.start()
    return {"job_id": job_id}


@app.get("/api/events/{job_id}")
async def events(job_id: str):
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Unknown job_id")

    async def stream():
        index = 0
        while True:
            with job.lock:
                pending = job.events[index:]
                index = len(job.events)
                finished = job.done
            for payload in pending:
                yield f"data: {json.dumps(payload)}\n\n"
            if finished and not pending:
                break
            await asyncio.sleep(0.25)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",  # disable proxy buffering
        },
    )


@app.get("/api/jobs/{job_id}")
def poll_job(job_id: str) -> dict:
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Unknown job_id")
    with job.lock:
        latest = job.events[-1] if job.events else None
        status = job.status
    return {"status": status, "event": latest}


@app.get("/api/result/{job_id}")
def result(job_id: str) -> dict:
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Unknown job_id")
    if job.result is None:
        if job.done:
            raise HTTPException(status_code=409, detail="Job finished without a result.")
        raise HTTPException(status_code=425, detail="Job still running.")

    res = job.result

    clips = [
        {
            "start": c.start,
            "end": c.end,
            "reason": c.reason,
            "confidence": c.confidence,
            "segment_ids": c.segment_ids,
        }
        for c in (res.clips or [])
    ]

    plan_payload = None
    if res.plan is not None:
        plan_payload = {
            "reasoning": res.plan.reasoning,
            "ops": res.plan.ops,
            "unsupported_language": res.plan.unsupported_language,
        }

    has_srt = bool(res.srt) and Path(res.srt).exists()
    return {
        "clips": clips,
        "output_url": f"/api/download/{job_id}" if res.output else None,
        "srt_url": f"/api/download/{job_id}?type=srt" if has_srt else None,
        "plan": plan_payload,
        "notes": list(getattr(res, "notes", []) or []),
    }


@app.get("/api/download/{job_id}")
def download(job_id: str, type: str | None = None):
    job = JOBS.get(job_id)
    if job is None or job.result is None:
        raise HTTPException(status_code=404, detail="No result for this job_id")

    res = job.result
    if type == "srt":
        if not res.srt or not Path(res.srt).exists():
            raise HTTPException(status_code=404, detail="No SRT for this job")
        path = Path(res.srt)
    else:
        if not res.output or not Path(res.output).exists():
            raise HTTPException(status_code=404, detail="No output for this job")
        path = Path(res.output)

    return _file_response(path, media_type=_media_type(path), download_name=path.name)


@app.post("/api/edit")
async def edit(request: Request) -> dict:
    """Apply a manual edit (EDL) with pure ffmpeg.

    Body: ``{media_id, keep_ranges: [[start, end], ...]}`` — kept ranges over
    the original timeline (seconds). Cuts each range and concatenates them, then
    stores the output on a fresh job so ``GET /api/download/{job_id}`` serves it.
    """
    try:
        body = await request.json()
    except Exception as exc:  # noqa: BLE001 - malformed body -> 400, not 500
        raise HTTPException(status_code=400, detail=f"Invalid JSON body: {exc}") from exc

    media_id = body.get("media_id")
    raw_ranges = body.get("keep_ranges") or []
    raw_effects = body.get("effects") or []

    entry = MEDIA.get(media_id)
    if entry is None or not entry.path.exists():
        raise HTTPException(status_code=404, detail="Unknown media_id")

    dur = entry.info.duration
    ranges: list[tuple[float, float]] = []
    for pair in raw_ranges:
        try:
            start = max(0.0, min(float(pair[0]), dur))
            end = max(0.0, min(float(pair[1]), dur))
        except (TypeError, ValueError, IndexError):
            continue
        if end - start > 0.02:  # ignore slivers
            ranges.append((start, end))

    if not ranges:
        raise HTTPException(
            status_code=400,
            detail="keep_ranges must contain at least one non-empty [start, end] pair.",
        )

    # Zoom windows (output-timeline seconds). Clamped and validated; scale > 1.
    effects: list[tuple[float, float, float]] = []
    for fx in raw_effects:
        try:
            start = max(0.0, float(fx["start"]))
            end = max(0.0, float(fx["end"]))
            scale = float(fx.get("scale", 1.0))
        except (TypeError, ValueError, KeyError):
            continue
        if end - start > 0.05 and scale > 1.001:
            effects.append((start, end, round(scale, 4)))

    try:
        out = await asyncio.to_thread(_apply_edit, entry, ranges, effects)
    except MediaError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        log.exception("edit failed")
        raise HTTPException(status_code=500, detail=f"Edit failed: {exc}") from exc

    job_id = uuid.uuid4().hex[:12]
    job = Job(id=job_id, media_id=media_id)
    job.result = EditResult(output=out)
    job.status = "done"
    job.done = True
    JOBS[job_id] = job
    return {"job_id": job_id}
