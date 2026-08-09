// Pure range math for the Edit Decision List (EDL).
//
// The EDL is an ordered, non-overlapping list of KEPT ranges over the original
// timeline: `[{ start, end }, ...]` in seconds. Edit actions (trim, delete,
// split) are expressed as transformations over this list. Everything here is
// pure and side-effect free so it is trivial to reason about and test.

const EPS = 1e-4

/** Sort, clamp, drop empties, and merge touching/overlapping ranges. */
export function normalizeRanges(ranges, duration = Infinity) {
  const cleaned = (ranges || [])
    .map((r) => ({
      start: Math.max(0, Math.min(r.start, r.end)),
      end: Math.min(duration, Math.max(r.start, r.end)),
    }))
    .filter((r) => r.end - r.start > EPS)
    .sort((a, b) => a.start - b.start)

  const out = []
  for (const r of cleaned) {
    const last = out[out.length - 1]
    if (last && r.start <= last.end + EPS) {
      last.end = Math.max(last.end, r.end)
    } else {
      out.push({ ...r })
    }
  }
  return out
}

/** The single full-timeline range, i.e. an unedited EDL. */
export function fullRange(duration) {
  return duration > 0 ? [{ start: 0, end: duration }] : []
}

/** Remove [s, e] from every kept range, rippling the remainder together. */
export function subtractRange(ranges, s, e) {
  const lo = Math.min(s, e)
  const hi = Math.max(s, e)
  const out = []
  for (const r of ranges) {
    if (hi <= r.start + EPS || lo >= r.end - EPS) {
      out.push({ ...r }) // no overlap
      continue
    }
    if (lo > r.start + EPS) out.push({ start: r.start, end: Math.max(r.start, lo) })
    if (hi < r.end - EPS) out.push({ start: Math.min(r.end, hi), end: r.end })
  }
  return normalizeRanges(out)
}

/** Keep only the portion of every kept range that lies within [s, e]. */
export function intersectRange(ranges, s, e) {
  const lo = Math.min(s, e)
  const hi = Math.max(s, e)
  const out = []
  for (const r of ranges) {
    const start = Math.max(r.start, lo)
    const end = Math.min(r.end, hi)
    if (end - start > EPS) out.push({ start, end })
  }
  return normalizeRanges(out)
}

/**
 * Split the kept range containing `t` into two adjacent ranges at `t`, so each
 * side can later be selected/deleted independently. No-op if `t` is on a
 * boundary or inside a removed gap.
 */
export function splitAt(ranges, t) {
  const out = []
  for (const r of ranges) {
    if (t > r.start + EPS && t < r.end - EPS) {
      out.push({ start: r.start, end: t })
      out.push({ start: t, end: r.end })
    } else {
      out.push({ ...r })
    }
  }
  // Keep as separate ranges (do NOT merge) so the split boundary survives.
  return out
    .map((r) => ({ start: Math.max(0, r.start), end: r.end }))
    .filter((r) => r.end - r.start > EPS)
    .sort((a, b) => a.start - b.start)
}

/** Complement of the kept ranges over [0, duration] — the removed gaps. */
export function removedRanges(ranges, duration) {
  const out = []
  let cursor = 0
  for (const r of normalizeRanges(ranges, duration)) {
    if (r.start - cursor > EPS) out.push({ start: cursor, end: r.start })
    cursor = Math.max(cursor, r.end)
  }
  if (duration - cursor > EPS) out.push({ start: cursor, end: duration })
  return out
}

/** Total kept duration in seconds. */
export function totalKept(ranges) {
  return (ranges || []).reduce((sum, r) => sum + Math.max(0, r.end - r.start), 0)
}

/** True when `t` lies inside a kept range (half-open, so ends don't count). */
export function isKept(ranges, t) {
  return (ranges || []).some((r) => t >= r.start - EPS && t < r.end - EPS)
}

/**
 * Given a source time `t`, return the next kept source time to play. If `t` is
 * already kept, returns `t`. If it falls in a removed gap, returns the start of
 * the next kept range. Returns `null` when nothing remains to play.
 */
export function nextKeptTime(ranges, t) {
  const sorted = normalizeRanges(ranges)
  for (const r of sorted) {
    if (t < r.end - EPS) return Math.max(t, r.start)
  }
  return null
}

/**
 * Map a source time `t` onto the edited (kept-only) output timeline — i.e. the
 * total kept duration that plays before `t`. Time inside a removed gap collapses
 * to the gap's start. Used to reposition zoom windows after cuts.
 */
export function mapToOutputTime(ranges, t) {
  let acc = 0
  for (const r of normalizeRanges(ranges)) {
    if (t >= r.end - EPS) {
      acc += r.end - r.start
    } else if (t > r.start) {
      acc += t - r.start
      return acc
    } else {
      return acc
    }
  }
  return acc
}

/** Structural equality for two normalized range lists. */
export function rangesEqual(a, b) {
  const na = normalizeRanges(a)
  const nb = normalizeRanges(b)
  if (na.length !== nb.length) return false
  return na.every(
    (r, i) => Math.abs(r.start - nb[i].start) < EPS && Math.abs(r.end - nb[i].end) < EPS,
  )
}
