/**
 * Project memory: where to look, and what to leave behind.
 *
 * `graphify_where` answers "which files and nodes did earlier work on these words
 * touch?" from the keyword index, before any file is opened. `graphify_remember`
 * is the write side the model calls after answering: it stores the question, the
 * keywords a person would actually type, the files and nodes involved, and the
 * outcome, both in the trail and in the CLI's own memory directory so `reflect`
 * can aggregate it. `graphify_lessons` reads that aggregate back.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { clip, field, formatRun, lines, plural } from '../text.js'
import { runGraphify, succeeded } from '../runner.js'
import {
  assertWritable,
  locateGraph,
  resolveTargetDir,
} from '../workspace.js'
import {
  extractFiles,
  extractKeywords,
  extractNodes,
  latestAnswers,
  lookupWhere,
  recentEntries,
  recordEntry,
  trailSummary,
} from '../trail.js'
import {
  ALLOW_OUTSIDE_PARAMETER,
  PROJECT_PATH_PARAMETER,
  TIMEOUT_PARAMETER,
  hasHistorySearch,
  historyFallback,
  textTool,
} from './define.js'

const OUTCOMES = ['useful', 'dead_end', 'corrected']

function formatTimestamp(value) {
  if (typeof value !== 'string') return undefined
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) return value
  return new Date(parsed).toISOString().replace('.000Z', 'Z')
}

/** Render the "where to look" answer. */
function describeWhere(result, dir, outDir, ctx) {
  const header = lines(
    field('Project', dir),
    field('Trail', `${plural(result.entries, 'entry', 'entries')}, last ${formatTimestamp(result.updatedAt) ?? 'never'}`),
    field('Searched for', result.terms.length > 0 ? result.terms.join(', ') : '(no usable keywords)'),
  )
  if (result.matches.length === 0) {
    return lines(
      header,
      '',
      'Nothing in the trail matches these words yet.',
      'Next layers, in this order:',
      '1. graphify_query — ask the graph; it derives seeds from the question.',
      '2. Read the source files the graph or a grep points at.',
      `3. ${historyFallback(ctx)}`,
      'Then call graphify_remember so this question lands in the trail.',
    )
  }
  const blocks = result.matches.map((match) => lines(
    `${match.keyword} · ${plural(match.count, 'mention', 'mentions')} · last ${formatTimestamp(match.lastSeen) ?? 'unknown'}`,
    match.files.length > 0 ? `  files: ${match.files.join(', ')}` : undefined,
    match.nodes.length > 0 ? `  nodes: ${match.nodes.join(', ')}` : undefined,
    match.questions.length > 0 ? `  asked: ${match.questions.map((question) => JSON.stringify(question)).join(' · ')}` : undefined,
  ))
  const conclusions = latestAnswers(outDir, result.terms)
  const conclusionBlock = conclusions.length === 0 ? undefined : lines(
    'What was concluded before:',
    ...conclusions.map((conclusion) => lines(
      `- ${JSON.stringify(conclusion.question ?? 'question not recorded')} → ${conclusion.outcome ?? 'unmarked'}`,
      `  ${conclusion.summary}`,
    )),
  )
  const seeds = result.nodes.slice(0, 4)
  const next = lines(
    'Next:',
    conclusionBlock === undefined ? undefined : '- If that conclusion still holds, answer from it and name the source.',
    result.files.length > 0 ? `- Otherwise read these first, newest first: ${result.files.slice(0, 6).join(', ')}` : undefined,
    seeds.length > 0 ? `- Or traverse from the graph: graphify_query with seeds ${JSON.stringify(seeds)}` : undefined,
    `- Trail files live in ${outDir}`,
  )
  return lines(header, '', ...blocks, '', conclusionBlock, next)
}

/** Render the newest trail entries. */
function describeRecent(outDir, limit) {
  const entries = recentEntries(outDir, limit)
  if (entries.length === 0) return `The trail in ${outDir} is empty: no tool call has been recorded for this project yet.`
  const rows = entries.map((entry) => lines(
    `${formatTimestamp(entry.at) ?? 'unknown'} · ${entry.tool ?? entry.kind}${entry.failed === true ? ' (failed)' : ''}`,
    entry.question === undefined ? undefined : `  asked: ${entry.question}`,
    entry.keywords.length > 0 ? `  keywords: ${entry.keywords.join(', ')}` : undefined,
    entry.files.length > 0 ? `  files: ${entry.files.slice(0, 6).join(', ')}` : undefined,
    entry.outcome === undefined ? undefined : `  outcome: ${entry.outcome}`,
  ))
  return lines(field('Trail', outDir), field('Entries shown', String(entries.length)), '', ...rows)
}

/**
 * Build the three memory tools.
 * @param ctx - plugin context, used to notice whether session history is searchable.
 * @returns tool definitions for the tool registry.
 */
export function memoryTools(ctx) {
  return [
    textTool({
      name: 'graphify_where',
      description:
        'Layer one of project search, and the cheapest: search the keyword trail of everything already done here and return the files and graph nodes earlier answers actually used, plus the questions that were asked. Local, needs no graph, and usually replaces a file read. The returned hint names the next layers when it finds nothing: the graph, then source files, then session history as a last resort. Use mode=recent to audit the last calls instead of searching.',
      parameters: {
        query: { type: 'string', description: 'The user\'s question or the words they used, in their phrasing.' },
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description: 'Explicit terms to look up, when they are more precise than the question text.',
        },
        mode: {
          type: 'string',
          enum: ['where', 'recent'],
          description: 'where searches the index (default); recent lists the newest trail entries.',
        },
        limit: { type: 'number', description: 'How many matching keywords to return (default 6).' },
        path: PROJECT_PATH_PARAMETER,
      },
      async execute(args, exec) {
        const dir = resolveTargetDir(args.path, exec)
        const outDir = locateGraph(dir).outDir
        if (args.mode === 'recent') return clip(describeRecent(outDir, Math.max(1, Math.round(args.limit ?? 10))))
        const result = lookupWhere(outDir, {
          question: args.query,
          keywords: args.keywords,
          limit: Math.max(1, Math.round(args.limit ?? 6)),
        })
        return clip(describeWhere(result, dir, outDir, ctx))
      },
    }),

    textTool({
      name: 'graphify_remember',
      description:
        'Leave the trail after answering a project question: what was asked, the keywords a person would type next time, the files and graph nodes that answered it, and whether the answer was useful. This is what makes the next lookup cheap — it is the memory that graphify_where reads. Call it once per answered question, including dead ends (outcome dead_end) and corrections (outcome corrected with the correction text).',
      parameters: {
        question: { type: 'string', required: true, description: 'The question that was asked, in the user\'s words.' },
        answer: { type: 'string', required: true, description: 'What the answer was, in two or three sentences. This is what a later session sees first.' },
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description: 'Three to eight domain words a later question would contain, such as invoice, retry, refresh token. Derived from the question and answer when omitted.',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Files that actually answered it. Extracted from the answer when omitted.',
        },
        nodes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Graph nodes involved. Extracted from the answer when omitted.',
        },
        outcome: {
          type: 'string',
          enum: OUTCOMES,
          description: 'useful (default) for an answer that held up, dead_end for a path that went nowhere, corrected when the first answer was wrong.',
        },
        correction: { type: 'string', description: 'With outcome corrected: what the right answer turned out to be.' },
        path: PROJECT_PATH_PARAMETER,
        allowOutsideWorkspace: ALLOW_OUTSIDE_PARAMETER,
        timeoutMs: TIMEOUT_PARAMETER,
      },
      async execute(args, exec) {
        const dir = resolveTargetDir(args.path, exec)
        assertWritable(dir, exec, args.allowOutsideWorkspace)
        const located = locateGraph(dir)
        const outcome = args.outcome ?? 'useful'
        // Keywords chosen by the model are authoritative: auto-derivation is a
        // safety net, not a competitor, because verbatim question words are the
        // noisiest possible index terms.
        const givenKeywords = [...new Set((args.keywords ?? []).map((keyword) => String(keyword).trim().toLowerCase()).filter((keyword) => keyword !== ''))]
        const keywords = givenKeywords.length > 0
          ? givenKeywords.slice(0, 12)
          : extractKeywords(args.question, args.answer)
        const files = [...new Set([...(args.files ?? []), ...extractFiles(args.answer)])].slice(0, 24)
        const nodes = [...new Set([...(args.nodes ?? []), ...extractNodes(args.answer)])].slice(0, 20)

        const recorded = recordEntry(located.outDir, {
          kind: 'answer',
          tool: 'graphify_remember',
          session: exec?.agent?.session?.id,
          question: args.question,
          summary: args.answer,
          keywords,
          files,
          nodes,
          outcome,
        })

        const argv = [
          'save-result',
          '--question', args.question,
          '--answer', args.answer,
          '--type', 'query',
          '--outcome', outcome,
          '--memory-dir', path.join(located.outDir, 'memory'),
        ]
        if (typeof args.correction === 'string' && args.correction.trim() !== '') argv.push('--correction', args.correction.trim())
        if (nodes.length > 0) argv.push('--nodes', ...nodes.slice(0, 8))
        const result = await runGraphify(argv, { cwd: dir, timeoutMs: args.timeoutMs ?? 60_000, signal: exec.signal })

        const trailNote = recorded === undefined
          ? 'The trail entry could not be written; only the CLI memory was attempted.'
          : `Recorded in the trail (${located.outDir}/trail) under: ${recorded.keywords.join(', ') || '(no keywords)'}. Later queries for these words will point at ${files.length > 0 ? files.slice(0, 4).join(', ') : 'nothing yet — pass files next time'}.`
        const cliBlock = result.spawnError === undefined
          ? formatRun(result, { note: 'The trail entry above is already written; this CLI step only feeds graphify_lessons.' })
          : 'The graphify CLI is unavailable, so the lesson file was not updated. The trail entry is enough for graphify_where.'
        return lines(
          `Remembered: ${args.question}`,
          field('Outcome', outcome),
          trailNote,
          '',
          cliBlock,
        )
      },
    }),

    textTool({
      name: 'graphify_lessons',
      description:
        'Read the aggregated lessons of this project: what earlier questions were asked, which answers held up, which were dead ends or corrections, and which keywords are the hottest areas. Regenerates the file with graphify reflect first unless refresh is false. Use it at the start of a session on an unfamiliar area, and after a wrong answer was corrected.',
      parameters: {
        path: PROJECT_PATH_PARAMETER,
        refresh: { type: 'boolean', description: 'Run graphify reflect before reading (default true).' },
        maxChars: { type: 'number', description: 'Cap the returned text (default 12000).' },
        timeoutMs: TIMEOUT_PARAMETER,
      },
      async execute(args, exec) {
        const dir = resolveTargetDir(args.path, exec)
        const located = locateGraph(dir)
        const lessonsFile = path.join(located.outDir, 'reflections', 'LESSONS.md')
        const memoryDir = path.join(located.outDir, 'memory')
        const blocks = []
        let reflectNote

        if (args.refresh !== false) {
          const argv = ['reflect', '--memory-dir', memoryDir, '--out', lessonsFile]
          if (located.hasGraph) argv.push('--graph', located.graphFile)
          const result = await runGraphify(argv, { cwd: dir, timeoutMs: args.timeoutMs ?? 120_000, signal: exec.signal })
          if (result.spawnError !== undefined) return 'The graphify CLI is unavailable, so lessons cannot be regenerated. graphify_where still works from the trail.'
          reflectNote = succeeded(result) ? 'Lessons regenerated from stored results.' : 'reflect reported a problem; the existing lessons file (if any) is shown as-is.'
        }

        const summary = trailSummary(located.outDir)
        blocks.push(lines(
          field('Project', dir),
          field('Lessons file', existsSync(lessonsFile) ? lessonsFile : 'none yet'),
          field('Stored results', existsSync(memoryDir) ? memoryDir : 'none yet'),
          field('Trail', `${summary.entries} entries, last ${formatTimestamp(summary.updatedAt) ?? 'never'}`),
          field('Hottest areas', summary.hottest.length > 0 ? summary.hottest.map((entry) => `${entry.keyword} ×${entry.count}`).join(', ') : 'none yet'),
          reflectNote,
        ))

        if (existsSync(lessonsFile)) {
          blocks.push('', clip(readFileSync(lessonsFile, 'utf8'), args.maxChars ?? 12_000))
        } else {
          blocks.push(
            '',
            'No lessons file yet. It appears after the first graphify_remember call: each remembered answer is stored under the memory directory and reflect aggregates them.',
          )
        }
        return clip(lines(blocks), args.maxChars ?? 12_000 + 800)
      },
    }),
  ]
}
