"""Media ingest + all ffmpeg/ffprobe work.

The important function here is :func:`plan_chunks`: Sarvam's STT REST endpoint
caps at 30s per request, so long media must be split locally. Splitting on
silence rather than on a fixed grid keeps phrases intact, which matters for both
transcription accuracy and for the timestamps we later cut on.
"""

from __future__ import annotations

import hashlib
import logging
import mimetypes
import re
import subprocess
import uuid
from dataclasses import dataclass
from enum import Enum
from pathlib import Path

import requests

from . import config

log = logging.getLogger("clipit.media")

VIDEO_EXTS = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".flv", ".wmv", ".m4v", ".mpeg", ".mpg"}
AUDIO_EXTS = {".mp3", ".wav", ".m4a", ".aac", ".ogg", ".opus", ".flac", ".aiff", ".amr", ".wma"}
YOUTUBE_RE = re.compile(r"(youtube\.com|youtu\.be)", re.I)
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36"


class MediaKind(str, Enum):
    AUDIO = "audio"
    VIDEO = "video"


@dataclass
class MediaInfo:
    path: Path
    kind: MediaKind
    duration: float
    has_audio: bool

    @property
    def is_video(self) -> bool:
        return self.kind is MediaKind.VIDEO


class MediaError(RuntimeError):
    """User-facing media problem (bad URL, too long, no audio track…)."""


# --------------------------------------------------------------------------
# ffmpeg plumbing
# --------------------------------------------------------------------------

def run(cmd: list[str], *, capture_stderr: bool = False) -> str:
    log.debug("run: %s", " ".join(map(str, cmd)))
    proc = subprocess.run(
        [str(c) for c in cmd],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if proc.returncode != 0:
        tail = "\n".join(proc.stderr.strip().splitlines()[-6:])
        raise MediaError(f"{Path(cmd[0]).name} failed:\n{tail}")
    return proc.stderr if capture_stderr else proc.stdout


def ffmpeg(*args: object, capture_stderr: bool = False) -> str:
    return run([config.FFMPEG, "-hide_banner", "-y", *args], capture_stderr=capture_stderr)


def new_workdir(prefix: str = "job") -> Path:
    d = config.WORK_DIR / f"{prefix}-{uuid.uuid4().hex[:10]}"
    d.mkdir(parents=True, exist_ok=True)
    return d


def file_hash(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()[:24]


# --------------------------------------------------------------------------
# Probing
# --------------------------------------------------------------------------

def probe(path: Path) -> MediaInfo:
    out = run([
        config.FFPROBE, "-v", "error",
        "-show_entries", "format=duration:stream=codec_type",
        "-of", "default=noprint_wrappers=1", str(path),
    ])
    codec_types = re.findall(r"codec_type=(\w+)", out)
    durations = [float(d) for d in re.findall(r"duration=([\d.]+)", out)]
    duration = max(durations) if durations else 0.0

    has_audio = "audio" in codec_types
    # A "video" stream that is really just cover art shouldn't promote an mp3.
    has_real_video = "video" in codec_types and path.suffix.lower() not in AUDIO_EXTS

    if not has_audio:
        raise MediaError("That file has no audio track — there's nothing to transcribe.")
    if duration <= 0:
        raise MediaError("Could not read the duration of that file.")

    return MediaInfo(
        path=path,
        kind=MediaKind.VIDEO if has_real_video else MediaKind.AUDIO,
        duration=duration,
        has_audio=has_audio,
    )


def duration_of(path: Path) -> float:
    out = run([config.FFPROBE, "-v", "error", "-show_entries", "format=duration",
               "-of", "csv=p=0", str(path)])
    try:
        return float(out.strip())
    except ValueError:
        return 0.0


# --------------------------------------------------------------------------
# Ingest
# --------------------------------------------------------------------------

def _download_direct(url: str, dest_dir: Path) -> Path:
    resp = requests.get(url, stream=True, timeout=60, headers={"User-Agent": UA})
    resp.raise_for_status()

    ext = Path(url.split("?")[0]).suffix.lower()
    if ext not in VIDEO_EXTS | AUDIO_EXTS:
        ctype = (resp.headers.get("Content-Type") or "").split(";")[0].strip()
        ext = mimetypes.guess_extension(ctype) or ""
        if ext == ".mpga":
            ext = ".mp3"
    if not ext:
        ext = ".mp4" if "video" in (resp.headers.get("Content-Type") or "") else ".mp3"

    dest = dest_dir / f"source{ext}"
    with open(dest, "wb") as fh:
        for block in resp.iter_content(chunk_size=1 << 16):
            fh.write(block)
    return dest


def _download_ytdlp(url: str, dest_dir: Path) -> Path:
    import yt_dlp

    opts = {
        "format": "bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720]/b",
        "merge_output_format": "mp4",
        "outtmpl": str(dest_dir / "source.%(ext)s"),
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "extractor_args": {"youtube": {"player_client": ["android", "web"]}},
    }
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=True)
            return Path(ydl.prepare_filename(info))
    except Exception as exc:  # noqa: BLE001
        raise MediaError(
            "Could not download that video — YouTube may be blocking automated "
            "downloads right now. Send me the file directly, or a direct media link."
        ) from exc


def _looks_like_direct_media(url: str) -> bool:
    if Path(url.split("?")[0]).suffix.lower() in VIDEO_EXTS | AUDIO_EXTS:
        return True
    try:
        head = requests.head(url, timeout=15, allow_redirects=True,
                             headers={"User-Agent": UA})
        ctype = (head.headers.get("Content-Type") or "").lower()
        return head.ok and (ctype.startswith("audio/") or ctype.startswith("video/"))
    except requests.RequestException:
        return False


def ingest(source: str | Path, workdir: Path) -> MediaInfo:
    """Resolve a local path, a direct media URL, or a YouTube link to a file."""
    if isinstance(source, Path) or not str(source).startswith(("http://", "https://")):
        path = Path(source)
        if not path.exists():
            raise MediaError(f"File not found: {path}")
    else:
        url = str(source)
        if YOUTUBE_RE.search(url):
            path = _download_ytdlp(url, workdir)
        elif _looks_like_direct_media(url):
            try:
                path = _download_direct(url, workdir)
            except requests.RequestException as exc:
                raise MediaError(f"Could not download that link ({exc}).") from exc
        else:
            path = _download_ytdlp(url, workdir)

    info = probe(path)
    if info.duration > config.MAX_INPUT_SECONDS:
        raise MediaError(
            f"That's {info.duration / 60:.1f} minutes long. "
            f"Keep it under {config.MAX_INPUT_SECONDS // 60} minutes for now."
        )
    return info


# --------------------------------------------------------------------------
# Audio extraction + chunking
# --------------------------------------------------------------------------

def extract_audio(path: Path, dest: Path) -> Path:
    """16 kHz mono PCM — what Sarvam's ASR performs best on."""
    ffmpeg("-i", path, "-vn", "-ac", "1", "-ar", "16000",
           "-c:a", "pcm_s16le", "-loglevel", "error", dest)
    return dest


def detect_silences(wav: Path, noise_db: int = -30,
                    min_silence: float = 0.4) -> list[tuple[float, float]]:
    stderr = ffmpeg("-i", wav, "-af",
                    f"silencedetect=noise={noise_db}dB:d={min_silence}",
                    "-f", "null", "-", capture_stderr=True)
    starts = [float(m) for m in re.findall(r"silence_start:\s*([\d.]+)", stderr)]
    ends = [float(m) for m in re.findall(r"silence_end:\s*([\d.]+)", stderr)]
    return list(zip(starts, ends))


def adaptive_target(duration: float) -> float:
    """Pick a chunk length trading timestamp precision against call count.

    Sarvam gives one timestamp span per request, so the chunk length *is* the
    resolution the locator can cut on. Short media gets fine chunks; long media
    is coarsened so we don't fire hundreds of requests.
    """
    ideal = duration / config.STT_TARGET_CHUNKS
    return max(config.STT_CHUNK_MIN, min(config.STT_CHUNK_MAX, ideal))


def plan_chunks(wav: Path, duration: float | None = None,
                target: float | None = None) -> list[tuple[float, float]]:
    """Split into <=``target``-second spans, preferring silence boundaries.

    Returns contiguous ``(start, end)`` pairs covering the whole file. Splitting
    on silence keeps phrases whole; a fixed grid would slice words in half and
    corrupt both the transcript and the timestamps we later cut on.
    """
    duration = duration if duration is not None else duration_of(wav)
    target = target or adaptive_target(duration)
    target = min(target, config.STT_MAX_SECONDS - 2.0)

    if duration <= target:
        return [(0.0, duration)]

    # Candidate split points: the midpoint of each detected silence. Try a
    # sensitive pass first so short, densely-spoken media still gets splits.
    silences = detect_silences(wav, noise_db=-30, min_silence=0.35)
    if len(silences) < duration / target / 2:
        silences = detect_silences(wav, noise_db=-25, min_silence=0.18)

    candidates = sorted(
        (s + e) / 2.0 for s, e in silences if 0.0 < (s + e) / 2.0 < duration
    )

    chunks: list[tuple[float, float]] = []
    cursor = 0.0
    while cursor < duration - 0.05:
        limit = cursor + target
        if limit >= duration - config.STT_CHUNK_FLOOR:
            chunks.append((cursor, duration))
            break
        usable = [c for c in candidates
                  if cursor + config.STT_CHUNK_FLOOR < c <= limit]
        cut = usable[-1] if usable else limit
        chunks.append((cursor, cut))
        cursor = cut
    return chunks


def slice_audio(wav: Path, start: float, end: float, dest: Path) -> Path:
    ffmpeg("-ss", f"{start:.3f}", "-to", f"{end:.3f}", "-i", wav,
           "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
           "-loglevel", "error", dest)
    return dest


# --------------------------------------------------------------------------
# Editing operations
# --------------------------------------------------------------------------

def cut(path: Path, start: float, end: float, dest: Path, *, is_video: bool) -> Path:
    args: list[object] = ["-ss", f"{start:.3f}", "-to", f"{end:.3f}", "-i", path]
    if is_video:
        args += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "24",
                 "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k",
                 "-movflags", "+faststart"]
    else:
        args += ["-vn", "-c:a", "libmp3lame", "-q:a", "2"]
    ffmpeg(*args, "-loglevel", "error", dest)
    return dest


def denoise(path: Path, dest: Path, *, is_video: bool) -> Path:
    """Neural denoise via rnnoise, falling back to the FFT denoiser."""
    if config.RNNOISE_MODEL.exists():
        chain = f"arnndn=m={config.RNNOISE_MODEL}"
    else:
        chain = "afftdn=nr=20:nf=-25,highpass=f=80"

    args: list[object] = ["-i", path, "-af", chain]
    if is_video:
        args += ["-c:v", "copy", "-c:a", "aac", "-b:a", "128k"]
    else:
        args += ["-vn", "-c:a", "libmp3lame", "-q:a", "2"]
    try:
        ffmpeg(*args, "-loglevel", "error", dest)
    except MediaError:
        log.warning("arnndn failed, falling back to afftdn")
        args = ["-i", path, "-af", "afftdn=nr=20:nf=-25,highpass=f=80"]
        if is_video:
            args += ["-c:v", "copy", "-c:a", "aac", "-b:a", "128k"]
        else:
            args += ["-vn", "-c:a", "libmp3lame", "-q:a", "2"]
        ffmpeg(*args, "-loglevel", "error", dest)
    return dest


def concat(paths: list[Path], dest: Path, *, is_video: bool) -> Path:
    if len(paths) == 1:
        import shutil as _sh

        _sh.copy(paths[0], dest)
        return dest

    listing = dest.parent / f"{dest.stem}-concat.txt"
    listing.write_text("".join(f"file '{p.resolve()}'\n" for p in paths))
    try:
        ffmpeg("-f", "concat", "-safe", "0", "-i", listing,
               "-c", "copy", "-loglevel", "error", dest)
    except MediaError:
        # Stream copy is fussy about mismatched parameters; re-encode instead.
        log.warning("concat demuxer copy failed, re-encoding")
        inputs: list[object] = []
        for p in paths:
            inputs += ["-i", str(p)]
        n = len(paths)
        if is_video:
            filt = "".join(f"[{i}:v:0][{i}:a:0]" for i in range(n)) + f"concat=n={n}:v=1:a=1[v][a]"
            maps = ["-map", "[v]", "-map", "[a]", "-c:v", "libx264",
                    "-preset", "veryfast", "-crf", "24", "-pix_fmt", "yuv420p",
                    "-c:a", "aac"]
        else:
            filt = "".join(f"[{i}:a:0]" for i in range(n)) + f"concat=n={n}:v=0:a=1[a]"
            maps = ["-map", "[a]", "-c:a", "libmp3lame", "-q:a", "2"]
        ffmpeg(*inputs, "-filter_complex", filt, *maps, "-loglevel", "error", dest)
    return dest


def replace_audio(video: Path, audio: Path, dest: Path) -> Path:
    ffmpeg("-i", video, "-i", audio, "-map", "0:v:0", "-map", "1:a:0",
           "-c:v", "copy", "-c:a", "aac", "-b:a", "128k", "-shortest",
           "-movflags", "+faststart", "-loglevel", "error", dest)
    return dest


def silence(duration: float, dest: Path) -> Path:
    ffmpeg("-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono",
           "-t", f"{max(duration, 0.01):.3f}", "-c:a", "pcm_s16le",
           "-loglevel", "error", dest)
    return dest


def fit_duration(path: Path, target: float, dest: Path) -> Path:
    """Speed up or pad a TTS clip so it lands in its allotted slot."""
    actual = duration_of(path)
    if actual <= 0:
        return silence(target, dest)

    if actual > target + 0.05:
        factor = min(actual / target, config.ATEMPO_MAX)
        filters = []
        remaining = factor
        while remaining > 2.0:  # atempo only accepts 0.5-2.0 per instance
            filters.append("atempo=2.0")
            remaining /= 2.0
        filters.append(f"atempo={remaining:.4f}")
        chain = ",".join(filters) + f",apad,atrim=0:{target:.3f}"
    else:
        chain = f"apad,atrim=0:{target:.3f}"

    ffmpeg("-i", path, "-af", chain, "-c:a", "pcm_s16le",
           "-loglevel", "error", dest)
    return dest
