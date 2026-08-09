"""The agent: turns an instruction into a plan, and a query into timestamps.

Two separate LLM calls, both schema-constrained:

* :func:`make_plan`   — instruction -> ordered list of ops
* :func:`locate_clips` — transcript + query -> concrete time ranges

Keeping them apart means a planning mistake never corrupts a search, and the
plan can be shown to the user before anything expensive runs.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

from . import config, sarvam
from .transcribe import Transcript

log = logging.getLogger("clipit.agent")

KNOWN_OPS = ("find", "trim", "denoise", "translate", "dub", "concat", "export")

PLAN_SCHEMA = {
    "type": "object",
    "properties": {
        "reasoning": {"type": "string"},
        "ops": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "op": {"type": "string", "enum": list(KNOWN_OPS)},
                    "args": {"type": "object"},
                },
                "required": ["op"],
            },
        },
        "target_language": {"type": ["string", "null"]},
        "unsupported_language": {"type": ["string", "null"]},
    },
    "required": ["reasoning", "ops"],
}

LOCATE_SCHEMA = {
    "type": "object",
    "properties": {
        "clips": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "start_id": {"type": "integer"},
                    "end_id": {"type": "integer"},
                    "reason": {"type": "string"},
                    "confidence": {"type": "number"},
                },
                "required": ["start_id", "end_id", "reason", "confidence"],
            },
        }
    },
    "required": ["clips"],
}

PLANNER_SYSTEM = f"""You are the planner for ClipIt, an audio/video editing agent.
Turn the user's instruction into an ordered list of operations.

Available operations:
- find      args: {{"query": str, "max_clips": int}}   locate the part(s) the user described
- trim      args: {{"padding_seconds": float}}          cut the located part(s) out
- denoise   args: {{}}                                   remove background noise
- dub       args: {{"target_language_code": str}}        translate + revoice into another language
- concat    args: {{}}                                   join multiple clips into one
- export    args: {{}}                                   finalise the output file

Rules:
1. Emit `find` ONLY when the user describes a specific part ("the part where...",
   "where he says X", "the section about Y"). If they mean the whole file, omit it.
2. `trim` must follow `find`. Never emit `trim` without `find`.
3. Emit `dub` only when the user names a target language.
4. Always end with `export`.
5. Keep the order the user implied. `denoise` may appear before or after `find`;
   the executor will place it optimally.
6. Supported dubbing languages: {', '.join(sorted(config.DUB_LANGUAGES))}.
   If the user asks for a language outside that list (e.g. Spanish, French),
   do NOT emit `dub` — set "unsupported_language" to what they asked for.
7. `query` should describe the content semantically. If the user quoted words,
   keep the quote in the query even if it is misspelled.

Return JSON only."""

LOCATOR_SYSTEM = """You are an expert video editor locating a segment in a transcript.

You get a numbered transcript. Each line is: [id] MM:SS.ss->MM:SS.ss text

Find the segment(s) matching the user's query and return the id range(s).

Rules:
1. START AT A SENTENCE BOUNDARY. If the match begins mid-sentence, backtrack to
   the id where that sentence starts. Never cut into the middle of a thought.
2. Include the complete thought — extend end_id to where the point finishes.
3. Quotes in the query may be misspelled or approximate; match on meaning and
   sound, not exact characters.
4. Return at most max_clips ranges, best first, each with a short reason and a
   confidence between 0 and 1.
5. If genuinely nothing matches, return an empty clips array.

Return JSON only."""


@dataclass
class Clip:
    start: float
    end: float
    reason: str = ""
    confidence: float = 0.0
    segment_ids: list[int] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "start": round(self.start, 3),
            "end": round(self.end, 3),
            "reason": self.reason,
            "confidence": round(self.confidence, 3),
            "segment_ids": self.segment_ids,
        }


@dataclass
class Plan:
    reasoning: str
    ops: list[dict]
    target_language: str | None = None
    unsupported_language: str | None = None

    def op_names(self) -> list[str]:
        return [o["op"] for o in self.ops]

    def has(self, name: str) -> bool:
        return any(o["op"] == name for o in self.ops)

    def to_dict(self) -> dict:
        return {
            "reasoning": self.reasoning,
            "ops": self.ops,
            "target_language": self.target_language,
            "unsupported_language": self.unsupported_language,
        }


def _normalise(raw: dict, instruction: str) -> Plan:
    """Validate the model's plan and repair the common failure modes."""
    ops: list[dict] = []
    for entry in raw.get("ops") or []:
        if not isinstance(entry, dict):
            continue
        name = str(entry.get("op", "")).strip().lower()
        if name not in KNOWN_OPS:
            log.warning("dropping unknown op %r", name)
            continue
        args = entry.get("args")
        ops.append({"op": name, "args": args if isinstance(args, dict) else {}})

    target = config.resolve_language(raw.get("target_language"))
    unsupported = raw.get("unsupported_language") or None

    # Pull the language off the dub op if the model only put it there.
    for op in ops:
        if op["op"] == "dub":
            code = config.resolve_language(op["args"].get("target_language_code"))
            target = target or code

    # Repairs -------------------------------------------------------------
    names = [o["op"] for o in ops]

    if "trim" in names and "find" not in names:
        ops = [o for o in ops if o["op"] != "trim"]
        names = [o["op"] for o in ops]

    if "find" in names and "trim" not in names:
        idx = names.index("find")
        ops.insert(idx + 1, {"op": "trim", "args": {}})
        names = [o["op"] for o in ops]

    if target and "dub" not in names:
        insert_at = len(ops)
        for i, o in enumerate(ops):
            if o["op"] in ("concat", "export"):
                insert_at = i
                break
        ops.insert(insert_at, {"op": "dub", "args": {"target_language_code": target}})
        names = [o["op"] for o in ops]

    if target and target not in config.DUB_LANGUAGES:
        unsupported = unsupported or config.language_label(target)
        ops = [o for o in ops if o["op"] != "dub"]
        target = None
        names = [o["op"] for o in ops]

    ops = [o for o in ops if o["op"] != "export"]
    ops.append({"op": "export", "args": {}})

    # An instruction that produced no real work at all is a planning failure;
    # fall back to something sensible rather than returning an empty pipeline.
    if not any(o["op"] in ("find", "denoise", "dub") for o in ops):
        log.warning("plan had no substantive op; falling back to find+trim")
        ops = [
            {"op": "find", "args": {"query": instruction, "max_clips": 1}},
            {"op": "trim", "args": {}},
            {"op": "export", "args": {}},
        ]

    for op in ops:
        if op["op"] == "dub" and target:
            op["args"]["target_language_code"] = target

    return Plan(
        reasoning=str(raw.get("reasoning") or "").strip(),
        ops=ops,
        target_language=target,
        unsupported_language=unsupported,
    )


def make_plan(instruction: str) -> Plan:
    raw = sarvam.chat_json(
        PLANNER_SYSTEM,
        f"Instruction: {instruction}",
        PLAN_SCHEMA,
        schema_name="EditPlan",
    )
    plan = _normalise(raw, instruction)
    log.info("plan: %s", " -> ".join(plan.op_names()))
    return plan


def locate_clips(transcript: Transcript, query: str, *, max_clips: int = 3,
                 padding: float | None = None) -> list[Clip]:
    if not transcript.segments:
        return []

    padding = config.DEFAULT_PADDING if padding is None else padding
    raw = sarvam.chat_json(
        LOCATOR_SYSTEM,
        f"Query: {query}\nmax_clips: {max_clips}\n\nTranscript:\n{transcript.numbered()}",
        LOCATE_SCHEMA,
        schema_name="ClipMatches",
    )

    last = transcript.segments[-1].id
    clips: list[Clip] = []
    for entry in (raw.get("clips") or [])[:max_clips]:
        try:
            a = max(0, min(int(entry["start_id"]), last))
            b = max(0, min(int(entry["end_id"]), last))
        except (KeyError, TypeError, ValueError):
            continue
        if a > b:
            a, b = b, a
        start = max(0.0, transcript.segments[a].start - padding)
        end = min(transcript.duration, transcript.segments[b].end + padding)
        if end - start < 0.25:
            continue
        clips.append(Clip(
            start=start,
            end=end,
            reason=str(entry.get("reason") or "").strip(),
            confidence=float(entry.get("confidence") or 0.0),
            segment_ids=list(range(a, b + 1)),
        ))

    clips.sort(key=lambda c: c.start)

    # Merge overlaps so a supercut never repeats the same footage.
    merged: list[Clip] = []
    for clip in clips:
        if merged and clip.start <= merged[-1].end + 0.05:
            prev = merged[-1]
            prev.end = max(prev.end, clip.end)
            prev.confidence = max(prev.confidence, clip.confidence)
            prev.segment_ids = sorted(set(prev.segment_ids) | set(clip.segment_ids))
        else:
            merged.append(clip)

    log.info("located %d clip(s) for %r", len(merged), query)
    return merged
