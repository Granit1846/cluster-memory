/**
 * Inspecting the install and the graph: install diagnostics, freshness, and the
 * report itself.
 *
 * `graphify_status` and `graphify_report` answer from disk, so they stay cheap
 * and safe to call in a loop; only freshness and the install check spawn the CLI.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { assertStarted, clip, field, humanBytes, lines } from '../text.js'
import { describeSettings } from '../settings.js'
import { findBinary, missingBinaryMessage, runGraphify, succeeded } from '../runner.js'
import {
  artifacts,
  locateGraph,
  manifestFileCount,
  needsUpdateFlag,
  readGraphSummary,
  resolveTargetDir,
} from '../workspace.js'
import { PROJECT_PATH_PARAMETER, TIMEOUT_PARAMETER, textTool } from './define.js'
import { trailSummary } from '../trail.js'

/** Environment variables that let the semantic pass reach a model. */
const BACKEND_ENVIRONMENT = [
  'GRAPHIFY_BACKEND',
  'DEEPSEEK_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'MOONSHOT_API_KEY',
  'KIMI_API_KEY',
  'OLLAMA_HOST',
]

/** Report sections the reader can select. */
const REPORT_SECTIONS = {
  summary: ['summary'],
  corpus: ['corpus check'],
  hubs: ['community hubs'],
  god_nodes: ['god nodes'],
  surprises: ['surprising connections'],
  cycles: ['import cycles'],
  communities: ['communities'],
  gaps: ['knowledge gaps'],
  questions: ['suggested questions'],
}

function ignoreFileState(dir) {
  const file = path.join(dir, '.graphifyignore')
  if (!existsSync(file)) {
    return 'absent (optional; add one to exclude vendor, build and cache directories)'
  }
  try {
    const patterns = readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line.trim() !== '' && !line.startsWith('#'))
    return `present, ${patterns.length} pattern(s)`
  } catch {
    return 'present, unreadable'
  }
}

function describeSummary(summary) {
  if (summary.exists !== true) return 'graph.json: absent'
  if (summary.tooLarge === true) return `graph.json: present (${humanBytes(summary.sizeBytes)}), too large to parse here — use the CLI tools for counts`
  if (summary.error !== undefined) return `graph.json: present but unreadable — ${summary.error}`
  const confidence = Object.entries(summary.confidence ?? {})
    .map(([key, value]) => `${key} ${value}`)
    .join(' · ')
  return lines(
    `graph.json: ${summary.nodes} nodes · ${summary.links} edges · ${summary.communities} communities (${humanBytes(summary.sizeBytes)})`,
    field('graphify version at build', summary.graphifyVersion),
    field('edge confidence', confidence),
    field('graph.json modified', summary.modifiedAt?.toISOString()),
  )
}

async function freshness(dir, timeoutMs, signal) {
  const result = await runGraphify(['check-update', dir], { cwd: dir, timeoutMs: timeoutMs ?? 30_000, signal })
  const output = `${result.stdout ?? ''}`.trim()
  return {
    result,
    verdict: result.exitCode === 0 ? 'up to date' : 'stale',
    output: output === '' ? (result.stderr ?? '').trim() : output,
  }
}

/** Freshness block; the CLI stays silent while nothing is pending. */
function freshnessBlock(fresh) {
  return lines(
    'Freshness',
    `  verdict: ${fresh.verdict}`,
    fresh.output === '' ? undefined : `  check-update: ${fresh.output.replaceAll('\n', '\n  ')}`,
  )
}

/**
 * Build the diagnostics, status and report tools.
 * @returns tool definitions for the tool registry.
 */
export function inspectTools() {
  return [
    textTool({
      name: 'graphify_doctor',
      description:
        'Diagnose the Graphify setup before blaming the graph: is the CLI installed and which version, does a graph exist, is it fresh, are .graphifyignore and a model backend configured, are the git hooks installed. Start here when a build or query misbehaved.',
      parameters: {
        path: PROJECT_PATH_PARAMETER,
        bin: { type: 'string', description: 'Exact path to the graphify executable, when PATH does not have it.' },
        timeoutMs: TIMEOUT_PARAMETER,
      },
      async execute(args, exec) {
        const dir = resolveTargetDir(args.path, exec)
        const binary = findBinary(args.bin)
        if (binary === undefined) {
          return lines('Setup: graphify CLI NOT found.', missingBinaryMessage(args.bin))
        }

        const version = await runGraphify(['--version'], { cwd: dir, timeoutMs: 30_000, signal: exec.signal })
        const located = locateGraph(dir)
        const summary = located.hasGraph ? readGraphSummary(located.graphFile) : { exists: false }
        const pending = needsUpdateFlag(located.outDir)
        const detected = BACKEND_ENVIRONMENT.filter((name) => {
          const value = process.env[name]
          return typeof value === 'string' && value.trim() !== ''
        })

        const blocks = [
          lines(
            'Setup',
            `  CLI: ${binary}`,
            `  version: ${version.exitCode === 0 ? version.stdout.trim() : `could not run --version (${version.stderr.trim() || 'no output'})`}`,
            `  project: ${dir}`,
            `  output: ${located.outDir}${located.hasGraph ? '' : ' (no graph yet)'}`,
            `  .graphifyignore: ${ignoreFileState(dir)}`,
            `  model backends configured: ${detected.length > 0 ? detected.join(', ') : 'none detected — code extraction still works, docs/papers/images need a key or a local ollama'}`,
            `  settings: ${describeSettings()}`,
          ),
          lines('Graph', `  ${describeSummary(summary).split('\n').join('\n  ')}`, field('  tracked files', manifestFileCount(located.outDir)), pending !== undefined ? `  needs_update: ${pending === true ? 'yes — semantic re-extraction pending' : pending}` : undefined),
        ]

        const trail = trailSummary(located.outDir)
        blocks.push(lines(
          'Trail',
          `  entries: ${trail.entries}`,
          field('  last activity', trail.updatedAt),
          field('  hottest words', trail.hottest.length > 0 ? trail.hottest.map((entry) => `${entry.keyword} ×${entry.count}`).join(', ') : 'none yet'),
        ))

        if (located.hasGraph) {
          const fresh = await freshness(dir, 45_000, exec.signal)
          blocks.push(freshnessBlock(fresh))
        }

        if (existsSync(path.join(dir, '.git'))) {
          const hooks = await runGraphify(['hook', 'status'], { cwd: dir, timeoutMs: 30_000, signal: exec.signal })
          const text = `${hooks.stdout}${hooks.stderr}`.trim()
          blocks.push(lines('Git hooks', `  ${text === '' ? 'no status output' : text.replaceAll('\n', '\n  ')}`))
        }

        const next = []
        if (!located.hasGraph) next.push('- No graph yet: run `graphify_build` with codeOnly: true for a fast offline first pass.')
        if (pending !== undefined) next.push('- Semantic re-extraction is pending: `graphify_update`, then `graphify_status`.')
        if (detected.length === 0 && located.hasGraph) next.push('- No model backend configured: docs, PDFs and images stay unindexed until a key is set or a local backend is chosen.')
        if (next.length > 0) blocks.push(lines('Next:', next))
        return clip(lines(blocks))
      },
    }),

    textTool({
      name: 'graphify_status',
      description:
        'Cheap freshness and content check for an existing graph: node/edge/community counts, tracked file count, artifacts on disk, the needs_update marker and the CLI check-update verdict. Call it before answering from the graph so you can say whether the graph is current.',
      parameters: {
        path: PROJECT_PATH_PARAMETER,
        checkUpdate: { type: 'boolean', description: 'Also run the CLI check-update probe (default true; it is a quick local check).' },
        timeoutMs: TIMEOUT_PARAMETER,
      },
      async execute(args, exec) {
        const dir = resolveTargetDir(args.path, exec)
        const located = locateGraph(dir)
        if (!located.hasGraph) {
          return lines(
            `No graph found for ${dir}.`,
            `Looked in: ${located.outDir}`,
            'Run graphify_build (codeOnly: true first) to create one, or graphify_doctor if a build was supposed to have happened.',
          )
        }
        const summary = readGraphSummary(located.graphFile)
        const pending = needsUpdateFlag(located.outDir)
        const tracked = manifestFileCount(located.outDir)
        const present = artifacts(located.outDir)
        const blocks = [
          lines(
            'Graph',
            `  ${describeSummary(summary).split('\n').join('\n  ')}`,
            field('  tracked files', tracked),
            `  needs_update: ${pending === undefined ? 'no marker' : pending === true ? 'yes — semantic re-extraction pending' : pending}`,
            field('  report', located.hasReport ? located.reportFile : 'GRAPH_REPORT.md missing — clustering has not run'),
            field('  interactive view', located.hasHtml ? located.htmlFile : 'graph.html missing'),
          ),
          lines('Artifacts', present.length === 0 ? '  none' : present.map((artifact) => `  ${artifact.name}${artifact.sizeBytes === undefined ? '' : ` (${humanBytes(artifact.sizeBytes)})`}`)),
        ]
        const trail = trailSummary(located.outDir)
        blocks.push(lines(
          'Trail',
          `  entries: ${trail.entries}`,
          field('  last activity', trail.updatedAt),
          field('  hottest words', trail.hottest.length > 0 ? trail.hottest.map((entry) => `${entry.keyword} ×${entry.count}`).join(', ') : 'none yet — graphify_remember fills this'),
        ))
        if (args.checkUpdate !== false) {
          const fresh = await freshness(dir, args.timeoutMs, exec.signal)
          assertStarted(fresh.result)
          blocks.push(freshnessBlock(fresh))
        }
        return clip(lines(blocks))
      },
    }),

    textTool({
      name: 'graphify_report',
      description:
        'Read GRAPH_REPORT.md: god nodes (the hubs everything routes through), surprising cross-community connections with a plain-English why, community map, knowledge gaps, and questions this graph is uniquely able to answer. Read this before asking traversal questions, then pick seeds and queries from it.',
      parameters: {
        path: PROJECT_PATH_PARAMETER,
        section: {
          type: 'string',
          enum: ['all', ...Object.keys(REPORT_SECTIONS)],
          description: 'Return one section instead of the whole report. Defaults to all.',
        },
        maxChars: { type: 'number', description: 'Cap the returned text (default 20000).' },
      },
      async execute(args, exec) {
        const dir = resolveTargetDir(args.path, exec)
        const located = locateGraph(dir)
        if (!located.hasReport) {
          return lines(
            `No GRAPH_REPORT.md in ${located.outDir}.`,
            located.hasGraph
              ? 'The graph exists but clustering has not produced a report: run `graphify cluster-only` (or graphify_build without noCluster).'
              : 'Build the graph first with graphify_build.',
          )
        }
        const raw = readFileSync(located.reportFile, 'utf8')
        const wanted = args.section ?? 'all'
        if (wanted === 'all') {
          return clip(lines(field('Source', located.reportFile), field('Modified', statSync(located.reportFile).mtime.toISOString()), '', raw), args.maxChars ?? 20_000)
        }
        const headings = REPORT_SECTIONS[wanted]
        const chunks = raw.split(/^## /m)
        const selected = chunks.filter((chunk) => {
          const title = chunk.split('\n', 1)[0].toLowerCase()
          return headings.some((heading) => title.includes(heading))
        })
        if (selected.length === 0) {
          const available = chunks.map((chunk) => chunk.split('\n', 1)[0].trim()).filter((title) => title !== '')
          return lines(`Section "${wanted}" is not present in this report.`, 'Available sections:', ...available.map((title) => `  ${title}`))
        }
        return clip(lines(field('Source', located.reportFile), '', ...selected.map((chunk) => `## ${chunk.trimEnd()}`)), args.maxChars ?? 20_000)
      },
    }),
  ]
}
