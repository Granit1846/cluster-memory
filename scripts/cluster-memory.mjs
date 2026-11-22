#!/usr/bin/env node
/**
 * Cluster Memory — a keyword trail of everything an agent already asked and found.
 *
 * A coding agent forgets between sessions, and compaction hides what it saw an hour
 * ago. This script keeps the distilled part instead of the transcript: for each
 * answered question it stores the keywords, the files, the graph nodes and a short
 * conclusion, then answers "where did we look for these words?" in one small read.
 *
 * Dependency-free, offline, one file. Data lives in .cluster-memory/ next to the
 * project. When a DSH graphify plugin trail exists in graphify-out/trail, its index is
 * merged into lookups so both surfaces share one memory.
 *
 * Commands:
 *   where <question> [--keywords a,b] [--limit N] [--json]
 *   remember --question Q --answer A [--keywords a,b] [--files a,b] [--nodes x,y]
 *            [--outcome useful|dead_end|corrected] [--correction TEXT]
 *   summary | recent [--limit N] | rebuild | record --tool NAME
 *
 * Every command accepts --cwd DIR (default: process.cwd()).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const MAX_ENTRY_KEYWORDS = 12
const MAX_INDEX_KEYWORDS = 1_200
const MAX_FILES_PER_KEYWORD = 12
const MAX_NODES_PER_KEYWORD = 6
const MAX_QUESTIONS_PER_KEYWORD = 5
const MAX_TRAIL_BYTES = 4 * 1024 * 1024
const COMPACT_KEEP_LINES = 2_000
const RESULT_SAMPLE_CHARS = 4_000

/** Words that carry no retrieval signal. Short on purpose: domain words must survive. */
const STOPWORDS = new Set((
  'the and for with that this these those from what when where which while who whom whose why how ' +
  'does did doing done are was were will would can could should shall may might must you your yours ' +
  'our ours its their them there then than into onto about above after again against all also any ' +
  'because been before being below between both but each few get got has have having here just like ' +
  'more most much need needs not now off only other out over owns same some such sure take tell ' +
  'through under until very want wants without yes use used using user uses via per let lets please ' +
  'help show find look list make made add adds added code file files line lines project folder ' +
  'directory graphify graph returns return true false null undefined const function class ' +
  'что где как это этот эта эти для или при все есть нет был была были быть чтобы если так там тут ' +
  'тоже ещё уже можно нужно надо делать сделать посмотри найди покажи скажи конечно который которые ' +
  'которая этого этой этому мне нам вас вы мы они она оно без над под про через потом сейчас просто ' +
  'только весь всё чем кто куда откуда почему зачем здесь теперь давай'
).split(/\s+/))

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

// ---------------------------------------------------------------- text mining

function clipText(value, max) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`
}

function extractKeywords(...texts) {
  const counts = new Map()
  for (const text of texts) {
    if (typeof text !== 'string' || text === '') continue
    for (const raw of text.match(IDENTIFIER) ?? []) {
      const token = raw.toLowerCase().replace(/^[._-]+|[._-]+$/g, '')
      if (token.length < 3 || token.length > 40) continue
      if (/^\d+$/.test(token) || STOPWORDS.has(token)) continue
      counts.set(token, (counts.get(token) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, MAX_ENTRY_KEYWORDS)
    .map(([term]) => term)
}

function extractFiles(text) {
  if (typeof text !== 'string' || text === '') return []
  const found = new Set()
  for (const pattern of FILE_PATTERNS) {
    pattern.lastIndex = 0
    for (const match of text.matchAll(pattern)) {
      const candidate = match[1]?.trim()
      if (candidate === undefined || candidate === '' || candidate.length > 300) continue
      found.add(candidate)
      if (found.size >= 40) return [...found]
    }
  }
  return [...found]
}

function extractNodes(text) {
  if (typeof text !== 'string' || text === '') return []
  const found = new Set()
  for (const pattern of NODE_PATTERNS) {
    pattern.lastIndex = 0
    for (const match of text.matchAll(pattern)) {
      const candidate = match[1]?.trim()
      if (candidate === undefined || candidate === '' || candidate.length > 120) continue
      found.add(candidate)
      if (found.size >= 30) return [...found]
    }
  }
  return [...found]
}

function fileStem(file) {
  const base = path.basename(String(file))
  const stem = base.includes('.') ? base.slice(0, base.lastIndexOf('.')) : base
  return stem.length >= 3 ? stem.toLowerCase() : undefined
}

function identifierParts(identifier) {
  return String(identifier)
    .split(/(?=[A-Z])|[_.\-\s/\\]+/)
    .map((part) => part.toLowerCase())
    .filter((part) => part.length >= 4)
}

// ------------------------------------------------------------------- storage

function trailRoot(cwd) {
  return path.join(cwd, '.cluster-memory')
}

function trailFiles(cwd) {
  const directory = trailRoot(cwd)
  return { directory, entries: path.join(directory, 'trail.jsonl'), index: path.join(directory, 'index.json') }
}

/** The DSH plugin keeps its own trail next to the graph; read it if it is there. */
function externalIndexFile(cwd) {
  return path.join(cwd, 'graphify-out', 'trail', 'index.json')
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

function normalizeIndex(parsed) {
  if (parsed === undefined || typeof parsed !== 'object' || parsed === null) return emptyIndex()
  if (typeof parsed.keywords !== 'object' || parsed.keywords === null) return emptyIndex()
  return { ...emptyIndex(), ...parsed }
}

function readIndex(cwd) {
  return normalizeIndex(readJson(trailFiles(cwd).index, undefined))
}

function writeJsonAtomic(file, value) {
  const temporary = `${file}.tmp`
  writeFileSync(temporary, JSON.stringify(value), 'utf8')
  renameSync(temporary, file)
}

function pushBounded(list, value, cap) {
  if (value === undefined || value === '') return list
  return [value, ...list.filter((item) => item !== value)].slice(0, cap)
}

function mergeIntoIndex(index, entry) {
  for (const keyword of entry.keywords) {
    const slot = index.keywords[keyword] ?? { count: 0, lastSeen: entry.at, files: [], nodes: [], questions: [] }
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
    // Best effort: a failed pass only means the log keeps growing.
  }
}

function recordEntry(cwd, entry) {
  const files = trailFiles(cwd)
  mkdirSync(files.directory, { recursive: true })
  const normalized = {
    at: entry.at ?? new Date().toISOString(),
    kind: entry.kind ?? 'answer',
    tool: entry.tool,
    question: clipText(entry.question, 300),
    keywords: [...new Set(entry.keywords ?? [])].slice(0, MAX_ENTRY_KEYWORDS),
    files: [...new Set(entry.files ?? [])].slice(0, 24),
    nodes: [...new Set(entry.nodes ?? [])].slice(0, 20),
    outcome: entry.outcome,
    summary: clipText(entry.summary, 400),
  }
  appendFileSync(files.entries, `${JSON.stringify(normalized)}\n`, 'utf8')
  compactTrailFile(files.entries)
  const index = readIndex(cwd)
  mergeIntoIndex(index, normalized)
  writeJsonAtomic(files.index, index)
  return normalized
}

function readLines(entriesFile) {
  try {
    if (!existsSync(entriesFile)) return []
    return readFileSync(entriesFile, 'utf8').split('\n').filter((line) => line.trim() !== '')
  } catch {
    return []
  }
}

function rebuildIndex(cwd) {
  const { entries, index } = trailFiles(cwd)
  const fresh = emptyIndex()
  let applied = 0
  for (const line of readLines(entries)) {
    try {
      const entry = JSON.parse(line)
      if (Array.isArray(entry?.keywords) && entry.keywords.length > 0) {
        mergeIntoIndex(fresh, entry)
        applied += 1
      }
    } catch {
      // A damaged line is skipped; the rest of the log still counts.
    }
  }
  writeJsonAtomic(index, fresh)
  return { applied, entries: fresh.count }
}

function recentEntries(cwd, limit) {
  return readLines(trailFiles(cwd).entries)
    .slice(-Math.max(1, limit))
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return undefined
      }
    })
    .filter(Boolean)
}

// -------------------------------------------------------------------- lookup

function lookup(cwd, options) {
  const index = readIndex(cwd)
  const external = normalizeIndex(readJson(externalIndexFile(cwd), undefined))
  const terms = [...new Set([...(options.keywords ?? []), ...extractKeywords(options.question ?? '')])]
  const limit = options.limit ?? 6
  const merged = new Map()
  for (const source of [index, external]) {
    for (const [keyword, slot] of Object.entries(source.keywords)) {
      const existing = merged.get(keyword)
      merged.set(keyword, existing === undefined
        ? { ...slot, files: [...slot.files], nodes: [...slot.nodes], questions: [...slot.questions] }
        : {
            count: existing.count + slot.count,
            lastSeen: String(slot.lastSeen) > String(existing.lastSeen) ? slot.lastSeen : existing.lastSeen,
            files: [...new Set([...existing.files, ...slot.files])].slice(0, MAX_FILES_PER_KEYWORD),
            nodes: [...new Set([...existing.nodes, ...slot.nodes])].slice(0, MAX_NODES_PER_KEYWORD),
            questions: [...new Set([...existing.questions, ...slot.questions])].slice(0, MAX_QUESTIONS_PER_KEYWORD),
          })
    }
  }

  const matches = []
  const seen = new Set()
  for (const term of terms) {
    if (merged.has(term) && !seen.has(term)) {
      seen.add(term)
      matches.push({ keyword: term, ...merged.get(term) })
      continue
    }
    for (const [keyword, slot] of merged) {
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
  const answers = []
  // The conclusion lookup tolerates the same stems the keyword index does:
  // asking about "invoices" must still surface the answer filed under "invoice".
  const related = (keyword) => {
    const value = String(keyword).toLowerCase()
    return terms.some((term) => value === term || value.startsWith(term) || term.startsWith(value))
  }
  for (const entry of recentEntries(cwd, 300).reverse()) {
    if (entry?.kind !== 'answer' || typeof entry.summary !== 'string') continue
    if (!(entry.keywords ?? []).some(related)) continue
    answers.push({ at: entry.at, question: entry.question, summary: entry.summary, outcome: entry.outcome })
    if (answers.length >= 2) break
  }
  return {
    entries: index.count + (external.count ?? 0),
    updatedAt: [index.updatedAt, external.updatedAt].filter(Boolean).sort().pop(),
    terms,
    matches: top,
    files: files.slice(0, 12),
    nodes: nodes.slice(0, 12),
    answers,
  }
}

// ---------------------------------------------------------------------- output

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`
const iso = (value) => {
  if (typeof value !== 'string') return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? value : new Date(parsed).toISOString().replace('.000Z', 'Z')
}

function renderWhere(result, cwd) {
  const lines = [
    `Project: ${cwd}`,
    `Trail: ${plural(result.entries, 'entry', 'entries')}, last ${iso(result.updatedAt) ?? 'never'}`,
    `Searched for: ${result.terms.length > 0 ? result.terms.join(', ') : '(no usable keywords)'}`,
  ]
  if (result.matches.length === 0) {
    lines.push(
      '',
      'Nothing in the trail matches these words yet.',
      'Next layers, in this order:',
      '1. graphify query "<question>"  (or grep) — ask the code, not the memory.',
      '2. Read the files that answer it.',
      '3. Earlier sessions, only if 1-2 found nothing.',
      'Then record the answer: cluster-memory remember --question ... --answer ... --keywords ...',
    )
    return lines.join('\n')
  }
  for (const match of result.matches) {
    lines.push('', `${match.keyword} · ${plural(match.count, 'mention', 'mentions')} · last ${iso(match.lastSeen) ?? 'unknown'}`)
    if (match.files.length > 0) lines.push(`  files: ${match.files.join(', ')}`)
    if (match.nodes.length > 0) lines.push(`  nodes: ${match.nodes.join(', ')}`)
    if (match.questions.length > 0) lines.push(`  asked: ${match.questions.map((question) => JSON.stringify(question)).join(' · ')}`)
  }
  if (result.answers.length > 0) {
    lines.push('', 'What was concluded before:')
    for (const answer of result.answers) {
      lines.push(`- ${JSON.stringify(answer.question ?? 'question not recorded')} → ${answer.outcome ?? 'unmarked'}`)
      lines.push(`  ${answer.summary}`)
    }
  }
  lines.push('', 'Next:')
  if (result.answers.length > 0) lines.push('- If that conclusion still holds, answer from it and name the source.')
  if (result.files.length > 0) lines.push(`- Otherwise read these first: ${result.files.slice(0, 6).join(', ')}`)
  if (result.nodes.length > 0) lines.push(`- Or traverse from the graph: graphify query with seeds ${JSON.stringify(result.nodes.slice(0, 4))}`)
  return lines.join('\n')
}

function renderSummary(cwd) {
  const index = readIndex(cwd)
  const hottest = Object.entries(index.keywords)
    .sort((left, right) => right[1].count - left[1].count)
    .slice(0, 10)
    .map(([keyword, slot]) => `${keyword} ×${slot.count}`)
  return [
    `Project: ${cwd}`,
    `Store: ${trailRoot(cwd)}`,
    `Entries: ${index.count}`,
    `Last activity: ${iso(index.updatedAt) ?? 'never'}`,
    `Hottest words: ${hottest.length > 0 ? hottest.join(', ') : 'none yet'}`,
  ].join('\n')
}

function renderRecent(cwd, limit) {
  const entries = recentEntries(cwd, limit)
  if (entries.length === 0) return `The trail in ${trailRoot(cwd)} is empty.`
  const lines = [`Store: ${trailRoot(cwd)}`, `Entries shown: ${entries.length}`]
  for (const entry of entries) {
    lines.push('', `${iso(entry.at) ?? 'unknown'} · ${entry.tool ?? entry.kind}`)
    if (entry.question !== undefined) lines.push(`  asked: ${entry.question}`)
    if ((entry.keywords ?? []).length > 0) lines.push(`  keywords: ${entry.keywords.join(', ')}`)
    if ((entry.files ?? []).length > 0) lines.push(`  files: ${entry.files.slice(0, 6).join(', ')}`)
    if (entry.outcome !== undefined) lines.push(`  outcome: ${entry.outcome}`)
  }
  return lines.join('\n')
}

// ----------------------------------------------------------------------- CLI

function parseArgs(argv) {
  const flags = {}
  const positional = []
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token.startsWith('--')) {
      const key = token.slice(2)
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true
        continue
      }
      flags[key] = next
      index += 1
      continue
    }
    positional.push(token)
  }
  return { flags, positional }
}

const list = (value) => (typeof value === 'string' ? value.split(',').map((item) => item.trim()).filter(Boolean) : [])

/**
 * Read hook payloads from stdin — only when asked.
 *
 * Agent hooks (Claude Code's `PostToolUse`, git hooks) hand their event over on
 * stdin. Reading it unconditionally would block an interactive run with no pipe,
 * so it happens only for `--stdin`.
 */
function readStdin() {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

/** Every string inside a hook payload, bounded in depth and size. */
function flattenStrings(value, depth = 0, out = []) {
  if (depth > 4 || out.length > 60) return out
  if (typeof value === 'string') {
    out.push(value)
    return out
  }
  if (Array.isArray(value)) {
    for (const item of value) flattenStrings(item, depth + 1, out)
    return out
  }
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) flattenStrings(item, depth + 1, out)
  }
  return out
}

function usage() {
  return [
    'cluster-memory — keyword trail of what was already asked and found',
    '',
    '  where <question> [--keywords a,b] [--limit N] [--json]',
    '  remember --question Q --answer A [--keywords a,b] [--files a,b] [--nodes x,y]',
    '           [--outcome useful|dead_end|corrected] [--correction TEXT]',
    '  summary',
    '  recent [--limit N]',
    '  rebuild',
    '  record --tool NAME [--text TEXT] [--keywords a,b] [--stdin]',
    '',
    'Every command accepts --cwd DIR (default: current directory).',
  ].join('\n')
}

function main(argv) {
  const [command, ...rest] = argv
  const { flags, positional } = parseArgs(rest)
  const cwd = path.resolve(flags.cwd ?? process.cwd())

  switch (command) {
    case 'where': {
      const question = flags.question ?? positional.join(' ')
      const result = lookup(cwd, { question, keywords: list(flags.keywords), limit: flags.limit === undefined ? 6 : Number(flags.limit) })
      return flags.json === true ? JSON.stringify(result, null, 2) : renderWhere(result, cwd)
    }
    case 'remember': {
      const question = flags.question
      const answer = flags.answer
      if (typeof question !== 'string' || typeof answer !== 'string') {
        throw new Error('remember needs --question and --answer')
      }
      const given = list(flags.keywords)
      const keywords = given.length > 0 ? given.map((keyword) => keyword.toLowerCase()) : extractKeywords(question, answer)
      const files = [...new Set([...list(flags.files), ...extractFiles(answer)])]
      const nodes = [...new Set([...list(flags.nodes), ...extractNodes(answer)])]
      const recorded = recordEntry(cwd, {
        kind: 'answer',
        tool: 'remember',
        question,
        summary: answer,
        keywords,
        files,
        nodes,
        outcome: typeof flags.outcome === 'string' ? flags.outcome : 'useful',
      })
      return [
        `Remembered: ${question}`,
        `Outcome: ${recorded.outcome}`,
        `Keywords: ${recorded.keywords.join(', ') || '(none)'}`,
        `Files: ${recorded.files.join(', ') || '(none)'}`,
        `Store: ${trailRoot(cwd)}`,
      ].join('\n')
    }
    case 'record': {
      let tool = typeof flags.tool === 'string' ? flags.tool : 'hook'
      let text = [flags.text, flags.question, flags.command, flags.path].filter((value) => typeof value === 'string').join(' ')
      if (flags.stdin === true) {
        const raw = readStdin()
        if (raw.trim() !== '') {
          let parsed
          try {
            parsed = JSON.parse(raw)
          } catch {
            parsed = undefined
          }
          const mined = parsed === undefined
            ? raw.slice(0, RESULT_SAMPLE_CHARS)
            : flattenStrings(parsed).join(' ').slice(0, RESULT_SAMPLE_CHARS)
          text = `${text} ${mined}`.trim()
          if (typeof parsed?.tool_name === 'string' && parsed.tool_name !== '') tool = parsed.tool_name
        }
      }
      const keywords = [...new Set([...list(flags.keywords), ...extractKeywords(text)])]
      const files = extractFiles(text)
      const nodes = extractNodes(text)
      if (keywords.length === 0 && files.length === 0) return `Nothing worth recording from ${tool}.`
      const recorded = recordEntry(cwd, {
        kind: 'tool',
        tool,
        question: clipText(text, 200),
        keywords,
        files,
        nodes,
      })
      return `Recorded ${tool}: ${recorded.keywords.slice(0, 8).join(', ') || '(no keywords)'}`
    }
    case 'summary':
      return renderSummary(cwd)
    case 'recent':
      return renderRecent(cwd, flags.limit === undefined ? 10 : Number(flags.limit))
    case 'rebuild': {
      const result = rebuildIndex(cwd)
      return `Rebuilt the index from ${plural(result.applied, 'entry', 'entries')}.`
    }
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      return usage()
    default:
      throw new Error(`unknown command "${command}"\n\n${usage()}`)
  }
}

const invokedDirectly = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (invokedDirectly) {
  try {
    const output = main(process.argv.slice(2))
    if (output !== undefined && output !== '') process.stdout.write(`${output}\n`)
  } catch (error) {
    process.stderr.write(`${error?.message ?? error}\n`)
    process.exitCode = 1
  }
}

export { extractFiles, extractKeywords, extractNodes, lookup, main, recentEntries, recordEntry, rebuildIndex, RESULT_SAMPLE_CHARS }
