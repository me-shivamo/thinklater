#!/usr/bin/env python3
"""ClipCraft Telegram bot.

Send a link (or a file) with an instruction; get the edited media back.

    python bot.py

The pipeline is blocking, so it runs in a worker thread and pushes progress
events onto an asyncio queue. The bot keeps a single status message and edits it
as stages complete, which is both the nicest UX and the cheapest on Telegram's
edit rate limit.
"""

from __future__ import annotations

import asyncio
import html
import logging
import re
import threading
import time
from pathlib import Path

from telegram import Update
from telegram.constants import ChatAction, ParseMode
from telegram.error import BadRequest, NetworkError, RetryAfter, TelegramError, TimedOut
from telegram.ext import (
    Application,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

from clipit import config, media
from clipit.pipeline import Event, Result, run

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
)
logging.getLogger("httpx").setLevel(logging.WARNING)
log = logging.getLogger("clipit.bot")

URL_RE = re.compile(r"https?://\S+")
EDIT_INTERVAL = 1.6  # seconds between status edits

EXAMPLES = [
    "Trim the part where they talk about India",
    "Dub this in Hindi",
    "Remove the background noise",
    'After he says Amazon, insert the word "Sarvam"',
]

WELCOME = (
    "🎬 <b>ClipCraft</b> — natural-language media editor\n\n"
    "Send me a <b>link</b> (YouTube or a direct audio/video URL) or a "
    "<b>file</b>, together with what you want done.\n\n"
    "<b>Try:</b>\n"
    "• <code>https://youtu.be/… trim the part where he talks about India</code>\n"
    "• <code>dub this in Hindi</code> (with a file attached)\n"
    "• <code>remove background noise from this</code>\n"
    "• <code>after he says Amazon, insert the word \"Sarvam\"</code>\n\n"
    "I can find, trim, denoise, dub — and <b>add words that were never spoken</b>, "
    "spliced in next to whatever you anchor them to. I'll tell you <i>why</i> I "
    "picked a spot.\n\n"
    f"<b>Dubbing languages:</b> "
    f"{', '.join(sorted(config.language_label(c) for c in config.DUB_LANGUAGES))}"
)


# --------------------------------------------------------------------------
# Status message rendering
# --------------------------------------------------------------------------

class Status:
    """Accumulates pipeline events into one continuously-edited message."""

    ICONS = {"running": "⏳", "done": "✅", "error": "❌", "info": "ℹ️"}

    def __init__(self) -> None:
        self.lines: list[tuple[str, str, str]] = []  # stage, status, message
        self._last_edit = 0.0

    def apply(self, event: Event) -> None:
        for i, (stage, status, _) in enumerate(self.lines):
            if stage == event.stage and status == "running":
                self.lines[i] = (event.stage, event.status, event.message)
                return
        self.lines.append((event.stage, event.status, event.message))

    def render(self) -> str:
        out = ["🎬 <b>ClipCraft</b>"]
        for _, status, message in self.lines:
            icon = self.ICONS.get(status, "•")
            text = html.escape(message or "")
            out.append(f"{icon} {text}" if status != "running" else f"{icon} <i>{text}</i>")
        return "\n".join(out)

    def due(self, force: bool = False) -> bool:
        now = time.monotonic()
        if force or now - self._last_edit >= EDIT_INTERVAL:
            self._last_edit = now
            return True
        return False


async def _edit(message, text: str) -> None:
    try:
        await message.edit_text(text, parse_mode=ParseMode.HTML,
                                disable_web_page_preview=True)
    except RetryAfter as exc:
        await asyncio.sleep(float(exc.retry_after) + 0.5)
    except BadRequest as exc:
        if "not modified" not in str(exc).lower():
            log.debug("edit failed: %s", exc)
    except TelegramError as exc:
        # Status text is disposable; a flaky network must never kill the job.
        log.debug("edit dropped: %s", exc)


async def _safe_reply(message, text: str, **kwargs) -> bool:
    """Reply, swallowing transport errors. Returns whether it landed."""
    for attempt in range(3):
        try:
            await message.reply_text(text, **kwargs)
            return True
        except RetryAfter as exc:
            await asyncio.sleep(float(exc.retry_after) + 0.5)
        except TelegramError as exc:
            log.warning("reply attempt %d failed: %s", attempt + 1, exc)
            await asyncio.sleep(2 * (attempt + 1))
    return False


async def _upload_result(update: Update, path: Path, caption: str | None,
                         *, is_video: bool) -> bool:
    """Upload the finished media, retrying and then degrading to a document.

    Telegram uploads are the least reliable step in the whole pipeline — on a
    weak connection a few-MB video times out where every small API call
    succeeds. Retry with growing timeouts, then fall back to sending it as a
    plain document, which is far more forgiving than send_video.
    """
    timeouts = [(180, 90), (420, 180), (900, 300)]  # (write, read) seconds

    for attempt, (write_t, read_t) in enumerate(timeouts, start=1):
        try:
            with open(path, "rb") as fh:
                common = dict(caption=caption, parse_mode=ParseMode.HTML,
                              write_timeout=write_t, read_timeout=read_t,
                              connect_timeout=60, pool_timeout=60)
                if is_video:
                    await update.message.reply_video(fh, supports_streaming=True,
                                                     **common)
                else:
                    await update.message.reply_audio(fh, title="ClipCraft result",
                                                     **common)
            return True
        except RetryAfter as exc:
            await asyncio.sleep(float(exc.retry_after) + 1)
        except TelegramError as exc:
            log.warning("upload attempt %d/%d failed (%s): %s",
                        attempt, len(timeouts), type(exc).__name__, exc)
            await asyncio.sleep(3 * attempt)

    # Last resort: documents skip Telegram's media transcoding entirely.
    log.warning("falling back to document upload for %s", path.name)
    try:
        with open(path, "rb") as fh:
            await update.message.reply_document(
                fh, filename=path.name, caption=caption,
                parse_mode=ParseMode.HTML,
                write_timeout=900, read_timeout=300, connect_timeout=60)
        return True
    except TelegramError as exc:
        log.error("document fallback also failed: %s", exc)
        return False


# --------------------------------------------------------------------------
# Pipeline bridge: blocking generator -> asyncio queue
# --------------------------------------------------------------------------

async def _run_pipeline(source, instruction: str, queue: asyncio.Queue) -> None:
    loop = asyncio.get_running_loop()

    def worker() -> None:
        try:
            for event in run(source, instruction, dub_engine=config.DUB_ENGINE):
                loop.call_soon_threadsafe(queue.put_nowait, event)
        except Exception as exc:  # noqa: BLE001
            log.exception("pipeline thread crashed")
            loop.call_soon_threadsafe(
                queue.put_nowait,
                Event("error", "error", f"{type(exc).__name__}: {exc}"),
            )
        finally:
            loop.call_soon_threadsafe(queue.put_nowait, None)

    threading.Thread(target=worker, daemon=True).start()


# --------------------------------------------------------------------------
# Handlers
# --------------------------------------------------------------------------

async def cmd_start(update: Update, _ctx: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_text(WELCOME, parse_mode=ParseMode.HTML,
                                    disable_web_page_preview=True)


async def _download_attachment(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> Path | None:
    msg = update.message
    obj = msg.video or msg.audio or msg.voice or msg.video_note or msg.document
    if obj is None:
        return None

    size = getattr(obj, "file_size", None) or 0
    if size > config.TELEGRAM_MAX_DOWNLOAD:
        await msg.reply_text(
            f"That file is {size / 1e6:.0f} MB — Telegram only lets bots download "
            f"up to {config.TELEGRAM_MAX_DOWNLOAD // 1024 // 1024} MB. "
            "Send me a link instead and I'll fetch it server-side."
        )
        return None

    workdir = media.new_workdir("tg")
    name = getattr(obj, "file_name", None) or f"input_{obj.file_unique_id}"
    if "." not in name:
        mt = (getattr(obj, "mime_type", "") or "").lower()
        name += ".mp4" if "video" in mt else ".ogg" if "ogg" in mt else ".mp3"

    dest = workdir / name
    tg_file = await ctx.bot.get_file(obj.file_id)
    await tg_file.download_to_drive(custom_path=str(dest))
    return dest


async def _process(update: Update, ctx: ContextTypes.DEFAULT_TYPE,
                   source, instruction: str) -> None:
    chat = update.effective_chat
    await ctx.bot.send_chat_action(chat.id, ChatAction.TYPING)

    status = Status()
    message = await update.message.reply_text("🎬 <b>ClipCraft</b>\n⏳ <i>Starting…</i>",
                                              parse_mode=ParseMode.HTML)

    queue: asyncio.Queue = asyncio.Queue()
    await _run_pipeline(source, instruction, queue)

    result: Result | None = None
    while True:
        event = await queue.get()
        if event is None:
            break
        status.apply(event)
        if "result" in event.data:
            result = event.data["result"]
        if status.due(force=event.status in ("error", "done")):
            await _edit(message, status.render())

    await _edit(message, status.render())

    if result is None or result.output is None:
        return

    output = Path(result.output)
    size = output.stat().st_size
    if size > config.TELEGRAM_MAX_UPLOAD:
        await update.message.reply_text(
            f"The result is {size / 1e6:.0f} MB, over Telegram's "
            f"{config.TELEGRAM_MAX_UPLOAD // 1024 // 1024} MB send limit. "
            f"It's saved on the server at:\n<code>{html.escape(str(output))}</code>",
            parse_mode=ParseMode.HTML,
        )
        return

    caption_bits = []
    for point in result.points:
        anchor = f" after “{html.escape(point.anchor)}”" if point.anchor else ""
        caption_bits.append(f"➕ Added at {point.time:.1f}s{anchor}")
        if point.reason:
            caption_bits.append(f"<i>{html.escape(point.reason)}</i>")
    if result.clips:
        clip = result.clips[0]
        caption_bits.append(f"✂️ {clip.start:.1f}s – {clip.end:.1f}s")
        if clip.reason:
            caption_bits.append(f"<i>{html.escape(clip.reason)}</i>")
    if result.dub_engine:
        voice = " with voice cloning" if result.voice_cloned else ""
        caption_bits.append(f"🎙 Dubbed{voice}")
    caption = "\n".join(caption_bits)[:1000] or None

    try:
        await ctx.bot.send_chat_action(chat.id, ChatAction.UPLOAD_VIDEO
                                       if result.kind.value == "video"
                                       else ChatAction.UPLOAD_VOICE)
    except TelegramError:
        pass  # cosmetic only — never let it block the actual upload

    sent = await _upload_result(update, output, caption,
                                is_video=result.kind.value == "video")
    if not sent:
        await _safe_reply(
            update.message,
            "I finished the edit, but Telegram kept timing out on the upload "
            f"(the network here is dropping connections). The file is on the "
            f"server at:\n<code>{html.escape(str(output))}</code>",
            parse_mode=ParseMode.HTML,
        )
        return

    if result.srt and Path(result.srt).exists():
        try:
            with open(result.srt, "rb") as fh:
                await update.message.reply_document(
                    fh, filename="subtitles.srt", caption="Subtitles",
                    read_timeout=120, write_timeout=300, connect_timeout=60)
        except TelegramError as exc:
            log.warning("subtitle upload failed: %s", exc)

    for note in result.notes:
        await update.message.reply_text(note)


async def on_message(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    msg = update.message
    if msg is None:
        return

    text = (msg.text or msg.caption or "").strip()
    pending: dict = ctx.user_data.setdefault("pending", {})

    # 1. An attachment came in.
    if msg.video or msg.audio or msg.voice or msg.video_note or msg.document:
        path = await _download_attachment(update, ctx)
        if path is None:
            return
        instruction = text
        if not instruction:
            pending["path"] = str(path)
            await msg.reply_text("Got it 👍 What should I do with this?\n\n"
                                 + "\n".join(f"• {e}" for e in EXAMPLES))
            return
        pending.clear()
        await _process(update, ctx, path, instruction)
        return

    if not text:
        return

    # 2. Text following an attachment we already stashed.
    if pending.get("path"):
        path = Path(pending.pop("path"))
        if path.exists():
            await _process(update, ctx, path, text)
            return

    # 3. Text containing a URL.
    match = URL_RE.search(text)
    if match:
        url = match.group(0).rstrip(").,")
        instruction = URL_RE.sub("", text).strip(" -–—:\n\t")
        if not instruction:
            pending["url"] = url
            await msg.reply_text("Got the link 👍 What should I do with it?\n\n"
                                 + "\n".join(f"• {e}" for e in EXAMPLES))
            return
        await _process(update, ctx, url, instruction)
        return

    # 4. Text following a URL we already stashed.
    if pending.get("url"):
        url = pending.pop("url")
        await _process(update, ctx, url, text)
        return

    await msg.reply_text(
        "Send me a link or a file along with what you'd like done.\n\n"
        + "\n".join(f"• {e}" for e in EXAMPLES)
    )


async def on_error(update: object, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    log.exception("handler error", exc_info=ctx.error)
    if not (isinstance(update, Update) and update.effective_message):
        return

    error = ctx.error
    if isinstance(error, (TimedOut, NetworkError)):
        text = ("Telegram timed out while we were talking to each other — "
                "usually the network here. Your edit may still have finished; "
                "try sending the same message again.")
    else:
        text = f"Something went wrong: {type(error).__name__}. Try again?"

    # The reply itself can fail on the same bad network that caused the error.
    # Swallowing that is the whole point — an exception escaping the error
    # handler is what silently killed the previous run.
    await _safe_reply(update.effective_message, text)


def main() -> None:
    if not config.TELEGRAM_BOT_TOKEN:
        raise SystemExit("TELEGRAM_BOT_TOKEN is not set. Add it to .env.")
    if not config.SARVAM_API_KEY:
        raise SystemExit("SARVAM_API_KEY is not set. Add it to .env.")

    app = (
        Application.builder()
        .token(config.TELEGRAM_BOT_TOKEN)
        .read_timeout(120)
        .write_timeout(300)
        .build()
    )
    app.add_handler(CommandHandler(["start", "help"], cmd_start))
    app.add_handler(MessageHandler(
        (filters.TEXT | filters.VIDEO | filters.AUDIO | filters.VOICE
         | filters.VIDEO_NOTE | filters.Document.ALL) & ~filters.COMMAND,
        on_message,
    ))
    app.add_error_handler(on_error)

    log.info("ClipCraft bot is up. Talk to it on Telegram.")
    app.run_polling(drop_pending_updates=True)


if __name__ == "__main__":
    main()
