// Small pure helpers shared across components. No backend knowledge here.

/** Seconds -> "M:SS" (or "H:MM:SS" for long media). */
export function formatTime(seconds) {
  if (seconds == null || Number.isNaN(seconds)) return '0:00'
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  return `${h > 0 ? h + ':' : ''}${mm}:${String(sec).padStart(2, '0')}`
}

/**
 * Index of the segment that contains `t`, via binary search.
 * Segments are assumed sorted by `start`. Returns -1 if none active.
 */
export function activeSegmentIndex(segments, t) {
  let lo = 0
  let hi = segments.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const seg = segments[mid]
    if (t < seg.start) {
      hi = mid - 1
    } else if (t > seg.end) {
      lo = mid + 1
    } else {
      ans = mid
      break
    }
    // When t falls in a gap, prefer the last segment that started before t.
    if (t >= seg.start) ans = ans === -1 ? mid : ans
  }
  return ans
}

/**
 * Deterministic synthetic waveform for fixtures / when the backend does not
 * supply real peaks. Louder inside spoken segments, quieter in the gaps, so the
 * timeline reads like a real editor even without decoding audio.
 */
export function synthPeaks(duration, segments = [], samples = 800) {
  const peaks = new Array(samples)
  const isSpeech = (t) =>
    segments.some((s) => t >= s.start && t <= s.end)
  for (let i = 0; i < samples; i++) {
    const t = (i / samples) * duration
    const base = isSpeech(t) ? 0.55 : 0.12
    // Layered sines + hashed jitter -> organic, stable across renders.
    const wobble =
      0.28 * Math.abs(Math.sin(i * 0.21)) +
      0.18 * Math.abs(Math.sin(i * 0.07 + 1.3))
    const jitter = ((Math.sin(i * 12.9898) * 43758.5453) % 1 + 1) % 1
    peaks[i] = Math.min(1, base + wobble * (isSpeech(t) ? 1 : 0.4) + jitter * 0.12)
  }
  return peaks
}

/** Total kept duration across clips, in seconds. */
export function clipsDuration(clips = []) {
  return clips.reduce((sum, c) => sum + Math.max(0, c.end - c.start), 0)
}
