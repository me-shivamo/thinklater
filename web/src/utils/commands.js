// Parse a "timestamp + instruction" command into a concrete edit action.
//
// Supported phrasing (case-insensitive), examples:
//   "cut 0:30 - 0:45"            -> remove that range from the timeline
//   "zoom in at 1:20"            -> punch-in centered at 1:20 for the default window
//   "zoom out 2:00 to 2:10"      -> reveal (starts zoomed, returns to 1x) over the range
//   "zoom in 1:05-1:12 1.8x"     -> explicit zoom factor
//   "cut this part"              -> uses the current selection / playhead context
//
// Everything here is pure so it is trivial to reason about and unit-test.

export const DEFAULT_ZOOM_SECONDS = 3
export const DEFAULT_ZOOM_SCALE = 1.5
export const MIN_RANGE = 0.05

// Matches H:MM:SS(.ms) | M:SS(.ms) | bare seconds (12 or 12.5 or 12s).
const TIMECODE_RE =
  /(?:\d+:){0,2}\d+(?:\.\d+)?s?/g

/** Parse a single timecode token ("1:23.5", "01:02:03", "90", "90s") -> seconds. */
export function parseTimecode(token) {
  if (token == null) return null
  const t = String(token).trim().replace(/s$/i, '')
  if (!t) return null
  const parts = t.split(':')
  if (parts.some((p) => p === '' || Number.isNaN(Number(p)))) return null
  let seconds = 0
  for (const p of parts) seconds = seconds * 60 + Number(p)
  return Number.isFinite(seconds) ? seconds : null
}

/** Pull every timecode out of a string, in order, as seconds. */
function extractTimecodes(text) {
  const matches = text.match(TIMECODE_RE) || []
  return matches
    .map(parseTimecode)
    .filter((n) => n != null)
}

/** Detect an explicit zoom factor like "1.8x" or "x2". */
function extractScale(text) {
  const m = text.match(/(\d+(?:\.\d+)?)\s*x\b/i) || text.match(/\bx\s*(\d+(?:\.\d+)?)/i)
  if (!m) return null
  const s = Number(m[1])
  return Number.isFinite(s) && s > 1 && s <= 6 ? s : null
}

function detectAction(lower) {
  if (/\bzoom[\s-]*out\b/.test(lower)) return 'zoom-out'
  if (/\bzoom[\s-]*in\b/.test(lower) || /\bzoom\b/.test(lower) || /\bpunch[\s-]*in\b/.test(lower))
    return 'zoom-in'
  if (/\b(cut|remove|delete|trim\s*out|drop|snip)\b/.test(lower)) return 'cut'
  return null
}

/**
 * Parse `text` into an action.
 *
 * @param {string} text        raw user input
 * @param {object} [ctx]       { currentTime, duration } context for defaults
 * @returns {{ok:true, action, start, end, scale, label} | {ok:false, error:string}}
 */
export function parseCommand(text, ctx = {}) {
  const raw = String(text || '').trim()
  if (!raw) return { ok: false, error: 'Type a command, e.g. "zoom in at 1:20".' }

  const lower = raw.toLowerCase()
  const action = detectAction(lower)
  if (!action) {
    return {
      ok: false,
      error: 'Say what to do: "zoom in", "zoom out", or "cut" — with a time or range.',
    }
  }

  const times = extractTimecodes(lower)
  const { currentTime = 0, duration = 0 } = ctx

  let start
  let end
  if (times.length >= 2) {
    start = Math.min(times[0], times[1])
    end = Math.max(times[0], times[1])
  } else if (times.length === 1) {
    if (action === 'cut') {
      return {
        ok: false,
        error: 'Cutting needs a range, e.g. "cut 0:30 - 0:45".',
      }
    }
    // A single time zooms for a default window centered nearby.
    start = times[0]
    end = times[0] + DEFAULT_ZOOM_SECONDS
  } else {
    // No timecode at all — fall back to the playhead for zooms.
    if (action === 'cut') {
      return {
        ok: false,
        error: 'Cutting needs a range, e.g. "cut 0:30 - 0:45".',
      }
    }
    start = currentTime
    end = currentTime + DEFAULT_ZOOM_SECONDS
  }

  if (duration > 0) {
    start = Math.max(0, Math.min(start, duration))
    end = Math.max(0, Math.min(end, duration))
  } else {
    start = Math.max(0, start)
    end = Math.max(0, end)
  }

  if (end - start < MIN_RANGE) {
    return { ok: false, error: 'That range is too short — give a start and end.' }
  }

  if (action === 'cut') {
    return { ok: true, action: 'cut', start, end, label: 'Cut' }
  }

  const scale = extractScale(lower) ?? DEFAULT_ZOOM_SCALE
  const type = action === 'zoom-out' ? 'out' : 'in'
  return {
    ok: true,
    action: 'zoom',
    type,
    start,
    end,
    scale,
    label: type === 'in' ? 'Zoom in' : 'Zoom out',
  }
}

/**
 * Effective zoom scale for a single effect at source time `t`.
 * Zoom-in ramps 1 -> scale; zoom-out ramps scale -> 1. Returns 1 outside range.
 */
export function scaleAt(effect, t) {
  const { start, end, scale, type } = effect
  if (t < start || t > end || end <= start) return 1
  const p = Math.max(0, Math.min(1, (t - start) / (end - start)))
  return type === 'out' ? 1 + (scale - 1) * (1 - p) : 1 + (scale - 1) * p
}

/** Largest active zoom scale across all effects at time `t` (1 if none). */
export function zoomScaleAt(effects, t) {
  let best = 1
  for (const e of effects || []) {
    const s = scaleAt(e, t)
    if (s > best) best = s
  }
  return best
}
