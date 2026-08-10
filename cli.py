#!/usr/bin/env python3
"""ClipCraft CLI — the development loop and the demo fallback.

    python cli.py -i <url|path> -q "trim the part about India and dub it in Hindi"
    python cli.py -i sample.mp3 --probe
"""

from __future__ import annotations

import argparse
import logging
import sys

from clipit import config
from clipit.media import MediaError, new_workdir
from clipit.pipeline import run

BOLD, DIM, GREEN, RED, YELLOW, RESET = (
    "\033[1m", "\033[2m", "\033[32m", "\033[31m", "\033[33m", "\033[0m"
)


def main() -> int:
    parser = argparse.ArgumentParser(prog="clipit", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("-i", "--input", required=True, help="file path or URL")
    parser.add_argument("-q", "--query", "--instruction", dest="query",
                        help="natural-language instruction")
    parser.add_argument("-o", "--output", help="copy the result here")
    parser.add_argument("--probe", action="store_true", help="just report kind/duration")
    parser.add_argument("--dub-engine", choices=("auto", "sarvam", "manual"),
                        default="auto")
    parser.add_argument("--speaker", default=None, help="Bulbul speaker for manual dub")
    parser.add_argument("--max-clips", type=int, default=3)
    parser.add_argument("--no-cache", action="store_true")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO if args.verbose else logging.WARNING,
        format=f"{DIM}%(name)s: %(message)s{RESET}",
    )

    if args.probe:
        from clipit import media

        try:
            info = media.ingest(args.input, new_workdir("probe"))
        except MediaError as exc:
            print(f"{RED}{exc}{RESET}")
            return 1
        print(f"{BOLD}{info.kind.value.upper()}{RESET}  "
              f"{info.duration:.2f}s  {info.path}")
        return 0

    if not args.query:
        parser.error("-q/--query is required unless --probe is given")

    if not config.SARVAM_API_KEY:
        print(f"{RED}SARVAM_API_KEY is not set. Add it to .env.{RESET}")
        return 1

    print(f"{BOLD}🎬 ClipCraft{RESET}")
    print(f"{DIM}   {args.query}{RESET}\n")

    import time

    result = None
    failed = False
    t0 = time.monotonic()
    stage_start: dict[str, float] = {}
    timings: list[tuple[str, float]] = []

    for event in run(args.input, args.query,
                     dub_engine=args.dub_engine,
                     max_clips=args.max_clips,
                     speaker=args.speaker,
                     use_cache=not args.no_cache):
        now = time.monotonic()
        icon = {"running": "⏳", "done": "✅", "error": "❌", "info": "ℹ️ "}.get(event.status, "  ")
        colour = {"error": RED, "info": YELLOW, "done": GREEN}.get(event.status, "")

        if event.status == "running":
            stage_start.setdefault(event.stage, now)
            print(f"  {icon} {DIM}{event.message}{RESET}")
        else:
            elapsed = now - stage_start.pop(event.stage, now)
            if event.status == "done" and event.stage != "done" and elapsed > 0.05:
                timings.append((event.stage, elapsed))
                print(f"  {icon} {colour}{event.message}{RESET} {DIM}({elapsed:.1f}s){RESET}")
            else:
                print(f"  {icon} {colour}{event.message}{RESET}")

        if "result" in event.data:
            result = event.data["result"]
        if event.status == "error" and event.stage in ("error", "find"):
            failed = True

    if result is None or result.output is None:
        if not failed:
            print(f"\n{RED}No output produced.{RESET}")
        return 1

    if result.points:
        print(f"\n{BOLD}Insertions{RESET}")
        for p in result.points:
            print(f"  {p.time:7.2f}s  after {p.anchor!r}  "
                  f"{DIM}conf {p.confidence:.2f}{RESET}  {p.reason}")

    if result.clips:
        print(f"\n{BOLD}Matches{RESET}")
        for c in result.clips:
            print(f"  {c.start:7.2f}s → {c.end:7.2f}s  "
                  f"{DIM}conf {c.confidence:.2f}{RESET}  {c.reason}")

    for note in result.notes:
        print(f"\n{YELLOW}{note}{RESET}")

    out = result.output
    if args.output:
        import shutil
        from pathlib import Path

        dest = Path(args.output)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(out, dest)
        out = dest

    if timings:
        total = time.monotonic() - t0
        print(f"\n{BOLD}Where the time went{RESET}  {DIM}(total {total:.1f}s){RESET}")
        for stage, secs in sorted(timings, key=lambda t: -t[1]):
            bar = "█" * max(1, int(secs / max(total, 0.1) * 30))
            print(f"  {stage:<11} {secs:6.1f}s  {DIM}{bar}{RESET}")

    print(f"\n{GREEN}{BOLD}OUTPUT_FILE: {out}{RESET}")
    if result.srt:
        print(f"{GREEN}SRT_FILE:    {result.srt}{RESET}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
