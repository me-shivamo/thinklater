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

log = logging.getLogger("clipcraft.media")

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


def _stream_codec(path: Path, kind: str) -> str:
    """codec_name of the first ``kind`` (``v``/``a``) stream, or ``""`` if none."""
    out = run([config.FFPROBE, "-v", "error", "-select_streams", f"{kind}:0",
               "-show_entries", "stream=codec_name", "-of", "csv=p=0", str(path)])
    return out.strip()


BROWSER_VIDEO = {"h264"}
BROWSER_AUDIO = {"aac", "mp3"}


def _make_browser_playable(path: Path) -> Path:
    """Guarantee a downloaded link resolves to an H.264/AAC MP4 with faststart.

    A browser <video> can only preview what it can decode. Link ingestion can
    otherwise yield AV1/VP9 (in mp4 or webm) — which most browsers refuse,
    silently: the network request succeeds so no error placeholder shows, but
    ``loadedmetadata`` never fires, leaving a black frame, a 0:00 duration and
    an empty filmstrip. We also relocate the moov atom to the front so the file
    plays progressively over HTTP Range. Cheap remux when codecs already match;
    transcode only when they don't.
    """
    try:
        vcodec = _stream_codec(path, "v")
        acodec = _stream_codec(path, "a")
    except MediaError:
        return path  # let probe() surface a clean error downstream

    is_mp4 = path.suffix.lower() in {".mp4", ".m4v", ".mov"}
    already_ok = is_mp4 and (not vcodec or vcodec in BROWSER_VIDEO) \
        and (not acodec or acodec in BROWSER_AUDIO)

    safe = path.with_name("playback.mp4")
    args: list[object] = ["-i", path]
    if already_ok:
        # Codecs are fine; only the container layout might need fixing.
        args += ["-c", "copy", "-movflags", "+faststart"]
    else:
        args += ["-c:v", "copy"] if vcodec in BROWSER_VIDEO else [
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
            "-pix_fmt", "yuv420p",
        ]
        if acodec:
            args += ["-c:a", "copy"] if acodec in BROWSER_AUDIO else [
                "-c:a", "aac", "-b:a", "128k",
            ]
        args += ["-movflags", "+faststart"]

    try:
        ffmpeg(*args, "-loglevel", "error", safe)
    except MediaError:
        if already_ok:
            return path  # remux failed but the original is already playable
        raise
    return safe


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

    # Pin the video stream to H.264 (avc1) + AAC (m4a) in an mp4 container.
    # ``[ext=mp4]`` alone is NOT enough: YouTube also serves AV1 (av01) *inside*
    # mp4, and yt-dlp ranks av01 above avc1 by default — so the old string would
    # merge an AV1 video that browsers can't decode (<video> then never fires
    # loadedmetadata: black preview, 0:00 duration, empty filmstrip). The
    # ``vcodec^=avc1`` filter forces the browser-friendly codec.
    opts = {
        "format": (
            "bv*[ext=mp4][vcodec^=avc1]+ba[ext=m4a]/"
            "b[ext=mp4][vcodec^=avc1]/b[ext=mp4]/b"
        ),
        "merge_output_format": "mp4",
        # Put the moov atom at the front so the file is progressively playable
        # over HTTP Range (a merged mp4 otherwise keeps moov at the end).
        "postprocessor_args": {"merger+ffmpeg": ["-movflags", "+faststart"]},
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
        # Remote sources can be AV1/VP9/webm; normalize to a browser-playable
        # H.264/AAC mp4 (faststart) so the <video> preview + filmstrip work.
        # Local files / uploads are trusted as-is and skip this step.
        path = _make_browser_playable(path)

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


def zoom(path: Path, windows: list[tuple[float, float, float]], dest: Path) -> Path:
    """Bake a centered punch-in (zoom) over one or more time windows.

    ``windows`` is a list of ``(start, end, scale)`` in the file's own timeline.
    Each window scales the frame up by ``scale`` and crops the centre back to the
    original size, overlaid only between ``start`` and ``end`` so the rest of the
    clip is untouched. Audio is passed through. Video only.
    """
    clean: list[tuple[float, float, float]] = []
    for start, end, scale in windows:
        s = max(0.0, float(start))
        e = max(0.0, float(end))
        z = float(scale)
        if e - s > 0.05 and z > 1.001:
            clean.append((s, e, round(z, 4)))
    if not clean:
        import shutil as _sh

        _sh.copy(path, dest)
        return dest

    steps: list[str] = []
    cur = "0:v"
    for i, (s, e, z) in enumerate(clean):
        b, zlab, zc, out = f"b{i}", f"z{i}", f"zc{i}", f"v{i}"
        steps.append(f"[{cur}]split=2[{b}][{zlab}]")
        steps.append(f"[{zlab}]scale=iw*{z}:ih*{z},crop=iw/{z}:ih/{z}[{zc}]")
        # Commas inside between() must be escaped so ffmpeg doesn't read them as
        # filtergraph separators.
        steps.append(
            f"[{b}][{zc}]overlay=enable='between(t\\,{s:.3f}\\,{e:.3f})'[{out}]"
        )
        cur = out

    graph = ";".join(steps)
    ffmpeg(
        "-i", path,
        "-filter_complex", graph,
        "-map", f"[{cur}]", "-map", "0:a?",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "24",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart", "-loglevel", "error", dest,
    )
    return dest


# RNNoise is trained on 48 kHz *mono* speech — feeding it stereo makes it
# suppress far too aggressively. It also lowers overall level as a side effect
# (measured: -17.0 dB RMS in, -30.0 dB out), so the output sounds thin and
# distant unless loudness is restored afterwards. loudnorm puts it back to
# broadcast level with 1.5 dB of true-peak headroom.
_LOUDNORM = "loudnorm=I=-16:TP=-1.5:LRA=11"
_RNNOISE_CHAIN = "aresample=48000,aformat=channel_layouts=mono,arnndn=m={model}," + _LOUDNORM
_FFT_CHAIN = "highpass=f=80,afftdn=nr=12:nf=-30," + _LOUDNORM


def denoise(path: Path, dest: Path, *, is_video: bool) -> Path:
    """Neural denoise via rnnoise, falling back to the FFT denoiser.

    Both chains end in loudness normalisation — without it the denoised audio
    comes back around 13 dB quieter than it went in, which reads as "the filter
    broke my audio" rather than "the noise is gone".
    """
    chains = []
    if config.RNNOISE_MODEL.exists():
        chains.append(_RNNOISE_CHAIN.format(model=config.RNNOISE_MODEL))
    chains.append(_FFT_CHAIN)

    def encode(chain: str) -> None:
        args: list[object] = ["-i", path, "-af", chain]
        if is_video:
            args += ["-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-ar", "48000"]
        else:
            args += ["-vn", "-c:a", "libmp3lame", "-q:a", "2", "-ar", "48000"]
        ffmpeg(*args, "-loglevel", "error", dest)

    last: MediaError | None = None
    for chain in chains:
        try:
            encode(chain)
            return dest
        except MediaError as exc:
            last = exc
            log.warning("denoise chain failed (%s), trying next", chain.split(",")[0])
    raise last or MediaError("denoise failed")


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


def video_params(path: Path) -> tuple[int, int, float]:
    """(width, height, fps) of the first video stream."""
    out = run([config.FFPROBE, "-v", "error", "-select_streams", "v:0",
               "-show_entries", "stream=width,height,r_frame_rate",
               "-of", "default=nw=1", str(path)])
    width = int(re.search(r"width=(\d+)", out).group(1))
    height = int(re.search(r"height=(\d+)", out).group(1))
    rate = re.search(r"r_frame_rate=(\d+)/(\d+)", out)
    fps = float(rate.group(1)) / float(rate.group(2) or 1) if rate else 30.0
    return width, height, (fps if fps > 0 else 30.0)


def audio_params(path: Path) -> tuple[int, int]:
    """(sample_rate, channels) of the first audio stream."""
    out = run([config.FFPROBE, "-v", "error", "-select_streams", "a:0",
               "-show_entries", "stream=sample_rate,channels",
               "-of", "default=nw=1", str(path)])
    rate = re.search(r"sample_rate=(\d+)", out)
    channels = re.search(r"channels=(\d+)", out)
    return (int(rate.group(1)) if rate else 44100,
            int(channels.group(1)) if channels else 2)


def frame_at(path: Path, when: float, dest: Path) -> Path:
    ffmpeg("-ss", f"{max(when, 0.0):.3f}", "-i", path, "-frames:v", "1",
           "-loglevel", "error", dest)
    return dest


def _held_frame_clip(source: Path, when: float, audio: Path, dest: Path) -> Path:
    """A still of ``source`` at ``when``, held for the length of ``audio``.

    Encoded to match the source's geometry, frame rate and audio layout so the
    concat demuxer can stream-copy the join instead of re-encoding everything.
    """
    width, height, fps = video_params(source)
    rate, channels = audio_params(source)
    still = dest.parent / f"{dest.stem}-still.png"
    frame_at(source, when, still)

    ffmpeg("-loop", "1", "-framerate", f"{fps:.5f}", "-i", still, "-i", audio,
           "-t", f"{duration_of(audio):.3f}",
           "-c:v", "libx264", "-preset", "veryfast", "-crf", "24",
           "-pix_fmt", "yuv420p", "-r", f"{fps:.5f}", "-s", f"{width}x{height}",
           "-c:a", "aac", "-b:a", "128k", "-ar", str(rate), "-ac", str(channels),
           "-shortest", "-movflags", "+faststart", "-loglevel", "error", dest)
    return dest


def splice(path: Path, at: float, clip: Path, dest: Path, *, is_video: bool) -> Path:
    """Insert ``clip``'s audio into ``path`` at ``at`` seconds.

    Video gains time rather than losing sync: the frame at the insertion point
    is held for exactly the length of the inserted audio, so everything after it
    stays aligned with the picture. Shifting the audio instead would desync the
    entire remainder of the video.
    """
    total = duration_of(path)
    at = max(0.0, min(at, total))
    stem = dest.stem

    if not is_video:
        return _splice_audio(path, at, clip, dest, total=total)

    # Never ask for a frame at (or past) the final timestamp.
    _, _, fps = video_params(path)
    middle = _held_frame_clip(path, min(at, max(total - 1.0 / fps, 0.0)),
                              clip, dest.parent / f"{stem}-mid.mp4")

    parts: list[Path] = []
    if at > 0.05:
        parts.append(cut(path, 0.0, at, dest.parent / f"{stem}-a.mp4", is_video=True))
    parts.append(middle)
    if total - at > 0.05:
        parts.append(cut(path, at, total, dest.parent / f"{stem}-b.mp4", is_video=True))

    return concat(parts, dest, is_video=True)


def _splice_audio(path: Path, at: float, clip: Path, dest: Path, *, total: float) -> Path:
    """Audio splice that stays in PCM until the final encode.

    Joining MP3s carries each part's encoder delay and padding into the result,
    so every boundary gains a sliver of silence and the output drifts longer
    than source + insert. Cutting to WAV and concatenating in one filter pass
    keeps the join sample-accurate.
    """
    rate, channels = audio_params(path)
    stem = dest.stem

    def piece(start: float, end: float, name: str) -> Path:
        out = dest.parent / f"{stem}-{name}.wav"
        ffmpeg("-ss", f"{start:.3f}", "-to", f"{end:.3f}", "-i", path, "-vn",
               "-ar", str(rate), "-ac", str(channels), "-c:a", "pcm_s16le",
               "-loglevel", "error", out)
        return out

    spoken = dest.parent / f"{stem}-mid.wav"
    ffmpeg("-i", clip, "-ar", str(rate), "-ac", str(channels), "-c:a", "pcm_s16le",
           "-loglevel", "error", spoken)

    parts: list[Path] = []
    if at > 0.05:
        parts.append(piece(0.0, at, "a"))
    parts.append(spoken)
    if total - at > 0.05:
        parts.append(piece(at, total, "b"))

    inputs: list[object] = []
    for part in parts:
        inputs += ["-i", str(part)]
    chain = ("".join(f"[{i}:a:0]" for i in range(len(parts)))
             + f"concat=n={len(parts)}:v=0:a=1[out]")
    ffmpeg(*inputs, "-filter_complex", chain, "-map", "[out]",
           "-c:a", "libmp3lame", "-q:a", "2", "-loglevel", "error", dest)
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
