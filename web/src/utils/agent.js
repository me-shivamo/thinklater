// Offline, transcript-aware agent used in fixtures mode.
//
// Real find/trim/dub runs on Person A's Python engine. When the backend is not
// available (USE_FIXTURES), this module lets a natural-language instruction
// still do something honest: parse it, search the LOADED transcript, and build
// the same { clips, plan } shape the live engine returns — plus a progress
// event stream so the AgentPanel ticks off exactly like a real run.
//
// Everything here is pure so it is trivial to reason about and test.

// Languages the engine supports, with the aliases a user might type. Codes match
// the Sarvam language codes the backend expects.
export const SUPPORTED_LANGUAGES = [
  { code: 'en-IN', name: 'English', aliases: ['english'] },
  { code: 'hi-IN', name: 'Hindi', aliases: ['hindi'] },
  { code: 'bn-IN', name: 'Bengali', aliases: ['bengali', 'bangla'] },
  { code: 'gu-IN', name: 'Gujarati', aliases: ['gujarati'] },
  { code: 'kn-IN', name: 'Kannada', aliases: ['kannada'] },
  { code: 'ml-IN', name: 'Malayalam', aliases: ['malayalam'] },
  { code: 'mr-IN', name: 'Marathi', aliases: ['marathi'] },
  { code: 'od-IN', name: 'Odia', aliases: ['odia', 'oriya'] },
  { code: 'pa-IN', name: 'Punjabi', aliases: ['punjabi'] },
  { code: 'ta-IN', name: 'Tamil', aliases: ['tamil'] },
  { code: 'te-IN', name: 'Telugu', aliases: ['telugu'] },
  { code: 'as-IN', name: 'Assamese', aliases: ['assamese'] },
]

const CLIP_PADDING = 0.15

const truncate = (s, n = 80) =>
  s && s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s || ''

const clean = (s) =>
  String(s || '')
    .trim()
    .replace(/^(?:the|a|an|part|parts|section|bit|word|phrase)\s+/i, '')
    .replace(/[.,;!?]+$/, '')
    .replace(/\s+(?:is\s+(?:spoken|said|mentioned))$/i, '')
    .trim()

// Pick the dub target language, preferring one introduced by a target
// preposition ("dub in Tamil", "to Hindi", "into Bengali") so the search term
// (which may itself be a language name, e.g. the word "hindi") isn't mistaken
// for the target.
function detectTargetLanguage(lower) {
  const re =
    /\b(?:dubbed|dub|translate[d]?|voiceover|voice|in|to|into)\b\s+(?:it\s+|this\s+|in\s+|to\s+|into\s+)?([a-z]+)/g
  let m
  while ((m = re.exec(lower))) {
    const hit = SUPPORTED_LANGUAGES.find((l) => l.aliases.includes(m[1]))
    if (hit) return hit
  }
  return null
}

// Pull the thing to look for out of the sentence. Ordered from most explicit
// (quoted / "word X") to least (a bare "find/trim <X>").
function extractTerm(text) {
  const quoted = text.match(/['"“”‘’]([^'"“”‘’]{1,60})['"“”‘’]/)
  if (quoted) return clean(quoted[1])

  const word = text.match(/\b(?:word|phrase)\s+([\p{L}\p{N}'-]+)/iu)
  if (word) return clean(word[1])

  const about = text.match(
    /\babout\s+(.+?)(?:\s+and\b|\s+then\b|\s+in\b|\s+to\b|\s+into\b|[.,;!?]|$)/i,
  )
  if (about) return clean(about[1])

  const where = text.match(
    /\bwhere\s+(?:he|she|they|it|the\s+word|the\s+phrase|the\s+speaker)?\s*(.+?)(?:\s+is\s+(?:spoken|said|mentioned)|\s+and\b|\s+then\b|[.,;!?]|$)/i,
  )
  if (where) return clean(where[1])

  const verb = text.match(
    /\b(?:find|trim|cut|remove|delete|clip|locate|keep)\s+(?:the\s+part\s+)?(?:where\s+)?(.+?)(?:\s+and\b|[.,;!?]|$)/i,
  )
  if (verb) return clean(verb[1])

  return ''
}

/**
 * Parse a natural-language instruction into structured intent.
 * @returns {{ term:string, wantsDub:boolean, language:object|null }}
 */
export function parseInstruction(raw) {
  const text = String(raw || '').trim()
  const lower = text.toLowerCase()
  const language = detectTargetLanguage(lower)
  const wantsDub = /\bdub|voice[-\s]?over/.test(lower) || language != null
  return { term: extractTerm(text), wantsDub, language }
}

function buildEvents({ term, matchCount, keptSeconds, dubName }) {
  const many = matchCount === 1 ? '' : 'es'
  const clipWord = matchCount === 1 ? 'clip' : 'clips'
  const events = [
    {
      stage: 'plan',
      status: 'running',
      message: `Planning: find → trim${dubName ? ' → dub' : ''} → export`,
      pct: 10,
    },
    { stage: 'plan', status: 'done', message: 'Plan ready', pct: 20 },
    {
      stage: 'find',
      status: 'running',
      message: `Searching transcript for “${term}”…`,
      pct: 35,
    },
    {
      stage: 'find',
      status: 'done',
      message: `Found ${matchCount} match${many}`,
      pct: 50,
    },
    { stage: 'trim', status: 'running', message: 'Building trim regions…', pct: 60 },
    {
      stage: 'trim',
      status: 'done',
      message: `Trimmed to ${matchCount} ${clipWord} (${keptSeconds.toFixed(1)}s)`,
      pct: dubName ? 68 : 88,
    },
  ]
  if (dubName) {
    events.push(
      {
        stage: 'dub',
        status: 'running',
        message: `Dubbing to ${dubName}… translating`,
        pct: 76,
      },
      {
        stage: 'dub',
        status: 'running',
        message: `Dubbing to ${dubName}… synthesizing`,
        pct: 86,
      },
      {
        stage: 'dub',
        status: 'done',
        message: `Dubbed into ${dubName} (planned — backend voices it)`,
        pct: 92,
      },
    )
  }
  events.push(
    { stage: 'export', status: 'running', message: 'Preparing plan + clips…', pct: 96 },
    { stage: 'export', status: 'done', message: 'Ready', pct: 100 },
    { stage: 'result', status: 'done', message: 'Done', pct: 100 },
  )
  return events
}

/**
 * Run the offline agent against a loaded transcript.
 *
 * @param {{ instruction:string, segments:Array, duration:number }} input
 * @returns {{ ok:false, error:string } | { ok:true, clips, plan, events, note }}
 */
export function planInstruction({ instruction, segments = [], duration = 0 }) {
  const { term, wantsDub, language } = parseInstruction(instruction)

  if (!segments.length) {
    return { ok: false, error: 'Load a transcript first — there are no segments to search.' }
  }
  if (!term) {
    return {
      ok: false,
      error: 'Tell me what to find, e.g. "trim where he talks about India".',
    }
  }

  const needle = term.toLowerCase()
  const matches = segments.filter((s) => (s.text || '').toLowerCase().includes(needle))
  if (!matches.length) {
    return { ok: false, error: `Couldn't find "${term}" in the transcript.` }
  }

  const clips = matches.map((s) => {
    const start = Math.max(0, s.start - CLIP_PADDING)
    const end = duration ? Math.min(duration, s.end + CLIP_PADDING) : s.end + CLIP_PADDING
    return {
      start,
      end,
      reason: `Matched “${term}” in: “${truncate(s.text)}”`,
      confidence: 0.9,
      segment_ids: [s.id],
    }
  })

  const keptSeconds = clips.reduce((sum, c) => sum + Math.max(0, c.end - c.start), 0)
  const dubUnsupported = wantsDub && !language
  const dubName = language?.name ?? null

  const ops = [
    { op: 'find', args: { query: term, matches: matches.length } },
    { op: 'trim', args: { padding_seconds: CLIP_PADDING } },
  ]
  if (dubName) ops.push({ op: 'dub', args: { target_language_code: language.code } })
  ops.push({ op: 'export', args: {} })

  const reasoning =
    `Searched the loaded transcript for “${term}”, found ${matches.length} matching ` +
    `segment${matches.length === 1 ? '' : 's'}, and built trim ` +
    `region${matches.length === 1 ? '' : 's'} around ` +
    `${matches.length === 1 ? 'it' : 'them'}` +
    (dubName ? `, then planned a ${dubName} dub.` : '.')

  let note = null
  if (dubName) {
    note = `Dubbing to ${dubName} requires the backend engine — showing the plan and clips only.`
  } else if (dubUnsupported) {
    note = `Couldn't recognize the requested dub language — showing find/trim only.`
  }

  return {
    ok: true,
    clips,
    plan: { reasoning, ops, note, unsupported_language: dubUnsupported ? true : null },
    events: buildEvents({ term, matchCount: matches.length, keptSeconds, dubName }),
    note,
  }
}
