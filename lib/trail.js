/**
 * The "trail": a keyword index of everything the agent already did in a project.
 *
 * Every tool call leaves an entry — which question was asked, which files and
 * graph nodes came back, which keywords describe it. The derived index answers
 * one question cheaply: "for these words, where did we look last time?", so a
 * later session can jump straight to the right files and nodes instead of
 * re-reading history or grepping the tree.
 *
 * Storage lives next to the graph, in `graphify-out/trail/`:
 *   trail.jsonl  append-only entries, one JSON object per line
 *   index.json   derived keyword → files / nodes / questions aggregate
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** Keywords kept in one entry. */
const MAX_ENTRY_KEYWORDS = 12
/** Keywords kept in the index; the coldest are dropped first. */
const MAX_INDEX_KEYWORDS = 1_200
/** Files, nodes and questions remembered per keyword. */
const MAX_FILES_PER_KEYWORD = 12
const MAX_NODES_PER_KEYWORD = 6
const MAX_QUESTIONS_PER_KEYWORD = 5
/** Entry log cap before it is compacted down to the newest entries. */
const MAX_TRAIL_BYTES = 4 * 1024 * 1024
const COMPACT_KEEP_LINES = 2_000

/**
 * Words that carry no retrieval signal. Deliberately short: a domain word like
 * "invoice" must always survive, and an over-eager list is worse than a noisy one.
 */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'these', 'those', 'from', 'what', 'when', 'where',
  'which', 'while', 'who', 'whom', 'whose', 'why', 'how', 'does', 'did', 'doing', 'done', 'are',
  'was', 'were', 'will', 'would', 'can', 'could', 'should', 'shall', 'may', 'might', 'must', 'you',
  'your', 'yours', 'our', 'ours', 'its', 'their', 'them', 'there', 'then', 'than', 'into', 'onto',
  'about', 'above', 'after', 'again', 'against', 'all', 'also', 'any', 'because', 'been', 'before',
  'being', 'below', 'between', 'both', 'but', 'each', 'few', 'get', 'got', 'has', 'have', 'having',
  'here', 'how', 'its', 'just', 'like', 'more', 'most', 'much', 'need', 'needs', 'not', 'now',
  'off', 'only', 'other', 'out', 'over', 'owns', 'same', 'some', 'such', 'sure', 'take', 'tell',
  'that', 'them', 'then', 'there', 'they', 'this', 'through', 'under', 'until', 'very', 'want',
  'wants', 'was', 'were', 'what', 'when', 'where', 'which', 'while', 'who', 'will', 'with',
  'without', 'would', 'yes', 'use', 'used', 'using', 'user', 'uses', 'via', 'per', 'let', 'lets',
  'please', 'help', 'show', 'find', 'look', 'list', 'make', 'made', 'add', 'adds', 'added', 'code',
  'file', 'files', 'line', 'lines', 'project', 'folder', 'directory', 'graphify', 'graph',
  'returns', 'return', 'true', 'false', 'null', 'undefined', 'const', 'function', 'class',
  'что', 'где', 'как', 'это', 'этот', 'эта', 'эти', 'для', 'или', 'при', 'все', 'есть', 'нет',
  'был', 'была', 'были', 'быть', 'чтобы', 'если', 'так', 'там', 'тут', 'тоже', 'ещё', 'уже',
  'можно', 'нужно', 'надо', 'делать', 'сделать', 'посмотри', 'найди', 'покажи', 'скажи', 'конечно',
  'который', 'которые', 'которая', 'этого', 'этой', 'этому', 'мне', 'нам', 'вас', 'вы', 'мы',
  'они', 'она', 'оно', 'без', 'над', 'под', 'про', 'через', 'потом', 'сейчас', 'просто', 'только',
  'весь', 'всё', 'чем', 'кто', 'куда', 'откуда', 'почему', 'зачем', 'здесь', 'теперь', 'давай',
])

const IDENTIFIER = /[A-Za-zА-Яа-яЁё0-9_.-]{3,40}/g
const FILE_PATTERNS = [
  /src=([^\s\]]+)/g,
  /at=([^\s\]]+):L\d+/g,
  /Source:\s+([^\s]+)\s+L\d+/g,
  /\b((?:[A-Za-z]:)?[\\/][^\s"':*?<>|]+\.[A-Za-z0-9]{1,8})\b/g,
  /\b([\w.-]+[\\/][\w./\\-]+\.[A-Za-z0-9]{1,8})\b/g,
]
const NODE_PATTERNS = [
  /^NODE\s+(.+?)\s+\[/gm,
  /^Node:\s+(.+?)\s*$/gm,
  /^\s*ID:\s+(\S+)\s*$/gm,
  /^-\s+(\S+?)\s+\[[a-z_]+\]/gm,
  /\b([A-Za-z_][\w]*\(\))/g,
]

function clipText(value, max) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`
}

/**
 * Pull retrieval keywords out of any text.
 * @param texts - question, arguments, result text; non-strings are ignored.
 * @returns lowercased terms, most frequent first, capped.
 */
export function extractKeywords(...texts) {
  const counts = new Map()
  for (const text of texts) {
    if (typeof text !== 'string' || text === '') continue
    for (const raw of text.match(IDENTIFIER) ?? []) {
      const token = raw.toLowerCase().replace(/^[._-]+|[._-]+$/g, '')
      if (token.length < 3 || token.length > 40) continue
      if (/^\d+$/.test(token)) continue
      if (STOPWORDS.has(token)) continue
      counts.set(token, (counts.get(token) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, MAX_ENTRY_KEYWORDS)
    .map(([term]) => term)
}

/** File paths mentioned by the CLI's own output formats. */
export function extractFiles(text) {
  if (typeof text !== 'string' || text === '') return []
  const found = new Set()
  for (const pattern of FILE_PATTERNS) {
    pattern.lastIndex = 0
    for (const match of text.matchAll(pattern)) {
      const candidate = match[1]?.trim()
      if (candidate === undefined || candidate === '') continue
      if (candidate.length > 300) continue
      found.add(candidate)
      if (found.size >= 40) return [...found]
    }
  }
  return [...found]
}

/** Node labels and ids mentioned by the traversal and report output. */
export function extractNodes(text) {
  if (typeof text !== 'string' || text === '') return []
  const found = new Set()
  for (const pattern of NODE_PATTERNS) {
    pattern.lastIndex = 0
    for (const match of text.matchAll(pattern)) {
      const candidate = match[1]?.trim()
      if (candidate === undefined || candidate === '') continue
      if (candidate.length > 120) continue
      found.add(candidate)
      if (found.size >= 30) return [...found]
    }
  }
  return [...found]
}

/** Resolve the trail files for an output directory. */
export function trailFiles(outDir) {
  const directory = path.join(outDir, 'trail')
  return {
    directory,
    entries: path.join(directory, 'trail.jsonl'),
    index: path.join(directory, 'index.json'),
  }
}

function emptyIndex() {
  return { version: 1, count: 0, updatedAt: undefined, keywords: {} }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/** Read the derived index, tolerating a missing or damaged file. */
export function readIndex(outDir) {
  const { index } = trailFiles(outDir)
  const parsed = readJson(index, undefined)
  if (parsed === undefined || typeof parsed !== 'object' || parsed === null) return emptyIndex()
  if (typeof parsed.keywords !== 'object' || parsed.keywords === null) return emptyIndex()
  return { ...emptyIndex(), ...parsed }
}

function writeJsonAtomic(file, value) {
  const temporary = `${file}.tmp`
  writeFileSync(temporary, JSON.stringify(value), 'utf8')
  renameSync(temporary, file)
}

function pushBounded(list, value, cap) {
  if (value === undefined || value === '') return list
  const filtered = list.filter((item) => item !== value)
  filtered.unshift(value)
  return filtered.slice(0, cap)
}

function mergeIntoIndex(index, entry) {
  for (const keyword of entry.keywords) {
    const slot = index.keywords[keyword] ?? {
      count: 0,
      lastSeen: entry.at,
      files: [],
      nodes: [],
      questions: [],
    }
    slot.count += 1
    slot.lastSeen = entry.at
    for (const file of entry.files.slice(0, 6)) slot.files = pushBounded(slot.files, file, MAX_FILES_PER_KEYWORD)
    for (const node of entry.nodes.slice(0, 4)) slot.nodes = pushBounded(slot.nodes, node, MAX_NODES_PER_KEYWORD)
    if (entry.question !== undefined) slot.questions = pushBounded(slot.questions, entry.question, MAX_QUESTIONS_PER_KEYWORD)
    index.keywords[keyword] = slot
  }
  const keywords = Object.entries(index.keywords)
  if (keywords.length > MAX_INDEX_KEYWORDS) {
    keywords.sort((left, right) => String(right[1].lastSeen).localeCompare(String(left[1].lastSeen)))
    index.keywords = Object.fromEntries(keywords.slice(0, MAX_INDEX_KEYWORDS))
  }
  index.count += 1
  index.updatedAt = entry.at
}

function compactTrailFile(entriesFile) {
  try {
    if (statSync(entriesFile).size <= MAX_TRAIL_BYTES) return
    const lines = readFileSync(entriesFile, 'utf8').split('\n').filter((line) => line.trim() !== '')
    writeFileSync(entriesFile, `${lines.slice(-COMPACT_KEEP_LINES).join('\n')}\n`, 'utf8')
  } catch {
    // Compaction is best-effort; a failed pass only means the log keeps growing.
  }
}

/**
 * Append one trail entry and fold it into the index.
 *
 * Best-effort by contract: recording must never fail a tool call or surface an
 * error to the model, so every failure returns undefined.
 * @param outDir - the project's graphify-out directory.
 * @param entry - the observation to remember.
 * @returns the normalized entry, or undefined when it could not be recorded.
 */
export function recordEntry(outDir, entry) {
  try {
    const files = trailFiles(outDir)
    mkdirSync(files.directory, { recursive: true })
    const normalized = {
      at: entry.at ?? new Date().toISOString(),
      kind: entry.kind ?? 'tool',
      tool: entry.tool,
      session: entry.session,
      question: clipText(entry.question, 300),
      keywords: [...new Set(entry.keywords ?? [])].slice(0, MAX_ENTRY_KEYWORDS),
      files: [...new Set(entry.files ?? [])].slice(0, 24),
      nodes: [...new Set(entry.nodes ?? [])].slice(0, 20),
      outcome: entry.outcome,
      failed: entry.failed === true ? true : undefined,
      summary: clipText(entry.summary, 400),
    }
    appendFileSync(files.entries, `${JSON.stringify(normalized)}\n`, 'utf8')
    compactTrailFile(files.entries)
    const index = readIndex(outDir)
    mergeIntoIndex(index, normalized)
    writeJsonAtomic(files.index, index)
    return normalized
  } catch {
    return undefined
  }
}

/**
 * Find where earlier work on these words lives.
 * @param outDir - the project's graphify-out directory.
 * @param options - a question, explicit keywords, and a match limit.
 */
export function lookupWhere(outDir, options = {}) {
  const index = readIndex(outDir)
  const terms = [...new Set([
    ...(options.keywords ?? []),
    ...extractKeywords(options.question ?? ''),
  ])]
  const limit = options.limit ?? 6
  const matches = []
  const seen = new Set()
  for (const term of terms) {
    const exact = index.keywords[term]
    if (exact !== undefined) {
      if (!seen.has(term)) {
        seen.add(term)
        matches.push({ keyword: term, ...exact })
      }
      continue
    }
    for (const [keyword, slot] of Object.entries(index.keywords)) {
      if (seen.has(keyword)) continue
      if (!keyword.startsWith(term) && !term.startsWith(keyword)) continue
      seen.add(keyword)
      matches.push({ keyword, ...slot })
      if (matches.length >= limit * 3) break
    }
  }
  matches.sort((left, right) => right.count - left.count || String(right.lastSeen).localeCompare(String(left.lastSeen)))
  const top = matches.slice(0, limit)
  const files = []
  const nodes = []
  for (const match of top) {
    for (const file of match.files) if (!files.includes(file)) files.push(file)
    for (const node of match.nodes) if (!nodes.includes(node)) nodes.push(node)
  }
  return {
    entries: index.count,
    updatedAt: index.updatedAt,
    terms,
    matches: top,
    files: files.slice(0, 12),
    nodes: nodes.slice(0, 12),
  }
}

/** Newest trail entries, for an explicit audit of what the agent did. */
export function recentEntries(outDir, limit = 10) {
  try {
    const { entries } = trailFiles(outDir)
    if (!existsSync(entries)) return []
    const lines = readFileSync(entries, 'utf8').split('\n').filter((line) => line.trim() !== '')
    return lines.slice(-Math.max(1, limit)).map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return undefined
      }
    }).filter(Boolean)
  } catch {
    return []
  }
}

/** Compact trail statistics for `graphify_status` and `graphify_doctor`. */
export function trailSummary(outDir) {
  const index = readIndex(outDir)
  const hottest = Object.entries(index.keywords)
    .sort((left, right) => right[1].count - left[1].count)
    .slice(0, 8)
    .map(([keyword, slot]) => ({ keyword, count: slot.count }))
  return { entries: index.count, updatedAt: index.updatedAt, hottest }
}

/**
 * The most recent remembered conclusions that touch these words.
 *
 * A pointer alone still costs a file read; one short sentence of "what we
 * concluded last time" often removes it. Bounded to the newest entries so the
 * lookup stays cheap.
 * @param outDir - the project's graphify-out directory.
 * @param keywords - terms to match against an entry's own keywords.
 * @param limit - how many conclusions to return.
 */
export function latestAnswers(outDir, keywords, limit = 2) {
  const wanted = new Set((keywords ?? []).map((keyword) => keyword.toLowerCase()))
  if (wanted.size === 0) return []
  const found = []
  for (const entry of recentEntries(outDir, 300).reverse()) {
    if (entry?.kind !== 'answer' || typeof entry.summary !== 'string') continue
    const matches = (entry.keywords ?? []).some((keyword) => wanted.has(String(keyword).toLowerCase()))
    if (!matches) continue
    found.push({
      at: entry.at,
      question: entry.question,
      summary: entry.summary,
      outcome: entry.outcome,
      files: entry.files ?? [],
    })
    if (found.length >= limit) break
  }
  return found
}
