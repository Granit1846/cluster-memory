/**
 * Graph construction: the full extraction and the cheap incremental refresh.
 */
import { assertStarted, formatRun, humanBytes, lines } from '../text.js'
import { runGraphify, succeeded } from '../runner.js'
import {
  artifacts,
  assertWritable,
  locateGraph,
  needsUpdateFlag,
  readGraphSummary,
  resolveTargetDir,
} from '../workspace.js'
import {
  ALLOW_OUTSIDE_PARAMETER,
  PROJECT_PATH_PARAMETER,
  TIMEOUT_PARAMETER,
  textTool,
} from './define.js'

/** Backends the CLI accepts for semantic extraction. */
const BACKENDS = ['gemini', 'kimi', 'claude', 'openai', 'deepseek', 'ollama']

/**
 * Describe what a run left on disk.
 *
 * The CLI can exit nonzero while still writing a usable graph (community naming
 * without an API key is the common case), so the artifact inventory — not the
 * exit code alone — decides what the model is told.
 */
function describeArtifacts(dir, options) {
  const located = locateGraph(dir, options)
  const present = artifacts(located.outDir)
  if (present.length === 0) {
    return lines(`Artifacts: none found in ${located.outDir}.`, 'The run produced no graph; check the CLI output above for the reason.')
  }
  const summary = located.hasGraph ? readGraphSummary(located.graphFile) : { exists: false }
  const counts = summary.exists && summary.tooLarge !== true && summary.error === undefined
    ? ` — ${summary.nodes} nodes · ${summary.links} edges · ${summary.communities} communities`
    : ''
  const header = `Artifacts in ${located.outDir}:`
  const rows = present.map((artifact) => {
    const size = artifact.sizeBytes === undefined ? '' : ` (${humanBytes(artifact.sizeBytes)})`
    return `  ${artifact.name}${artifact.name === 'graph.json' ? counts : ''}${size}`
  })
  const missing = []
  if (!located.hasReport) missing.push('GRAPH_REPORT.md (god nodes, surprising connections, suggested questions) is missing — the clustering step did not run; call `graphify_update` with clusterOnly: true.')
  if (!located.hasHtml) missing.push('graph.html is missing — run the export tool for the interactive view.')
  return lines(header, rows, ...missing)
}

function nextSteps(dir, options) {
  const located = locateGraph(dir, options)
  const hints = []
  if (located.hasGraph) {
    hints.push(`- \`graphify_report\` (path: "${dir}") for the report, or \`graphify_status\` for freshness.`)
    hints.push(`- \`graphify_query\` with a real architecture question before reading raw files.`)
  } else {
    hints.push('- Re-run with codeOnly to prove the toolchain works without an LLM backend.')
  }
  const pending = needsUpdateFlag(located.outDir)
  if (pending !== undefined) {
    hints.push('- Docs/images changed since the last semantic pass: run `graphify_update`, then re-check `graphify_status`.')
  }
  return lines('Next:', hints)
}

/** Build one CLI invocation from the shared option vocabulary. */
function extractionArguments(dir, args) {
  const argv = ['extract', dir]
  if (args.mode === 'deep') argv.push('--mode', 'deep')
  if (args.codeOnly === true) argv.push('--code-only')
  if (typeof args.backend === 'string' && args.backend !== '') argv.push('--backend', args.backend)
  if (typeof args.model === 'string' && args.model !== '') argv.push('--model', args.model)
  if (args.force === true) argv.push('--force')
  if (args.noCluster === true) argv.push('--no-cluster')
  if (args.googleWorkspace === true) argv.push('--google-workspace')
  if (typeof args.postgres === 'string' && args.postgres !== '') argv.push('--postgres', args.postgres)
  if (typeof args.maxWorkers === 'number') argv.push('--max-workers', String(Math.max(1, Math.round(args.maxWorkers))))
  if (typeof args.maxConcurrency === 'number') argv.push('--max-concurrency', String(Math.max(1, Math.round(args.maxConcurrency))))
  if (typeof args.tokenBudget === 'number') argv.push('--token-budget', String(Math.max(1000, Math.round(args.tokenBudget))))
  if (typeof args.out === 'string' && args.out.trim() !== '') argv.push('--out', args.out.trim())
  return argv
}

/**
 * Build the full-extraction tool and the incremental refresh tool.
 * @returns tool definitions for the tool registry.
 */
export function buildTools() {
  return [
    textTool({
      name: 'graphify_build',
      description:
        'Build or rebuild a Graphify knowledge graph for a project folder: local AST extraction for code, plus optional LLM extraction for docs, papers and images. Writes <project>/graphify-out/{graph.json, GRAPH_REPORT.md, graph.html, ...} and prints a token benchmark. Prefer graphify_update after ordinary code edits — it re-extracts only changed files and needs no API key. Prefer graphify_query/graphify_path/graphify_explain over raw file reads once the graph exists.',
      parameters: {
        path: PROJECT_PATH_PARAMETER,
        codeOnly: {
          type: 'boolean',
          description: 'Index code only, with the local AST pass: no LLM, no API key, fully offline. The right first run to prove the toolchain works.',
        },
        mode: {
          type: 'string',
          enum: ['default', 'deep'],
          description: 'deep extracts more aggressive INFERRED edges from docs and papers; it costs more tokens.',
        },
        backend: {
          type: 'string',
          enum: BACKENDS,
          description: 'LLM backend for doc/paper/image extraction. Defaults to whichever API key is present in the environment.',
        },
        model: { type: 'string', description: 'Override the backend default model.' },
        force: { type: 'boolean', description: 'Ignore the incremental manifest and semantic cache and re-scan everything.' },
        noCluster: { type: 'boolean', description: 'Skip clustering, community naming and the report; write raw extraction only.' },
        googleWorkspace: { type: 'boolean', description: 'Export .gdoc/.gsheet/.gslides pointer files through gws before extraction.' },
        postgres: { type: 'string', description: 'DSN of a live PostgreSQL database to add: tables, views, functions and foreign keys.' },
        maxWorkers: { type: 'number', description: 'AST extraction subprocess count. Defaults to the CPU count.' },
        maxConcurrency: { type: 'number', description: 'Parallel semantic chunks. Use 1 for local LLMs.' },
        tokenBudget: { type: 'number', description: 'Per-chunk token cap for semantic extraction (default 60000).' },
        out: { type: 'string', description: 'Output root; artifacts land in <out>/graphify-out. Defaults to the project folder.' },
        allowOutsideWorkspace: ALLOW_OUTSIDE_PARAMETER,
        timeoutMs: TIMEOUT_PARAMETER,
      },
      async execute(args, exec) {
        const dir = resolveTargetDir(args.path, exec)
        assertWritable(dir, exec, args.allowOutsideWorkspace)
        const result = await runGraphify(extractionArguments(dir, args), {
          cwd: dir,
          timeoutMs: args.timeoutMs,
          signal: exec.signal,
        })
        assertStarted(result)
        const note = succeeded(result)
          ? undefined
          : 'The CLI exited nonzero: the artifact inventory below shows how far it actually got, and the advice names the usual cause.'
        return lines(
          formatRun(result, { note }),
          describeArtifacts(dir, { out: args.out }),
          nextSteps(dir, { out: args.out }),
        )
      },
    }),

    textTool({
      name: 'graphify_update',
      description:
        'Refresh an existing graph without re-reading the whole corpus. Default mode re-extracts only changed code files with the local AST pass and rewrites graph.json — no LLM, no API key. clusterOnly mode instead re-runs clustering, community naming and the report on the graph.json that is already there, which is how you get GRAPH_REPORT.md after a code-only build. Use force after refactors that delete code, when the rebuild would otherwise look smaller and be refused.',
      parameters: {
        path: PROJECT_PATH_PARAMETER,
        clusterOnly: {
          type: 'boolean',
          description: 'Only re-cluster the existing graph.json and regenerate the report and graph.html; no file re-extraction.',
        },
        force: {
          type: 'boolean',
          description: 'Overwrite graph.json even when the rebuild has fewer nodes (use after deleting or renaming code). Ignored with clusterOnly.',
        },
        noCluster: { type: 'boolean', description: 'Skip clustering and the report; write the raw extraction only. Ignored with clusterOnly.' },
        noViz: { type: 'boolean', description: 'With clusterOnly: skip graph.html generation, for very large graphs.' },
        allowOutsideWorkspace: ALLOW_OUTSIDE_PARAMETER,
        timeoutMs: TIMEOUT_PARAMETER,
      },
      async execute(args, exec) {
        const dir = resolveTargetDir(args.path, exec)
        assertWritable(dir, exec, args.allowOutsideWorkspace)
        const argv = args.clusterOnly === true ? ['cluster-only', dir] : ['update', dir]
        if (args.clusterOnly === true) {
          if (args.noViz === true) argv.push('--no-viz')
        } else {
          if (args.force === true) argv.push('--force')
          if (args.noCluster === true) argv.push('--no-cluster')
        }
        const result = await runGraphify(argv, { cwd: dir, timeoutMs: args.timeoutMs, signal: exec.signal })
        assertStarted(result)
        const note = succeeded(result)
          ? undefined
          : 'Nonzero exit does not always mean the graph is unusable — read the artifact inventory below before retrying.'
        return lines(formatRun(result, { note }), describeArtifacts(dir), nextSteps(dir))
      },
    }),
  ]
}
