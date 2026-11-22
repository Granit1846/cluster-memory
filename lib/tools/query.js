/**
 * Reading the graph: traversal questions, node-to-node paths, node explanations
 * and reverse impact analysis.
 *
 * Two behaviours make these the fast path rather than a detour. A missing graph is
 * built automatically from code (no LLM, seconds), and every read consults the
 * keyword trail first, so a question phrased the way it was asked before starts
 * from the nodes and files that answered it last time.
 */
import { assertStarted, formatRun, lines } from '../text.js'
import { runGraphify } from '../runner.js'
import { ensureGraph } from '../autobuild.js'
import { lookupWhere } from '../trail.js'
import { locateGraph, resolveFileArgument, resolveTargetDir } from '../workspace.js'
import {
  GRAPH_PARAMETER,
  PROJECT_PATH_PARAMETER,
  TIMEOUT_PARAMETER,
  historyFallback,
  textTool,
} from './define.js'

/** Trail seeds handed to the CLI; more than a few dilutes the traversal. */
const MAX_TRAIL_SEEDS = 4

/** Explain why no graph is available, including why the automatic build did not run. */
function noGraphMessage(dir, ensured) {
  return lines(
    `No graph for ${dir} yet.`,
    ensured?.reason === undefined ? undefined : `The automatic build did not run: ${ensured.reason}.`,
    `Looked in: ${ensured?.located?.outDir ?? locateGraph(dir).outDir}`,
    'Build one with graphify_build (codeOnly: true is the fast offline pass), or pass the graph argument.',
  )
}

/** What the trail already knows about this question, as a compact block. */
function trailBlock(where) {
  if (where === undefined || where.matches.length === 0) return undefined
  const rows = where.matches.slice(0, 3).map((match) => lines(
    `  ${match.keyword} ×${match.count}${match.files.length > 0 ? ` → ${match.files.slice(0, 4).join(', ')}` : ''}`,
    match.questions.length > 0 ? `    asked before: ${JSON.stringify(match.questions[0])}` : undefined,
  ))
  return lines('Earlier trail for these words:', rows, '  Read those files for exact detail; the traversal below is the graph view.')
}

/**
 * Preconditions shared by the read-only commands.
 * @returns either a `problem` text to return, or the resolved context.
 */
async function prepareRead(dir, args, exec) {
  if (typeof args.graph === 'string' && args.graph.trim() !== '') {
    return { argv: ['--graph', resolveFileArgument(args.graph, exec)], dir }
  }

  const ensured = await ensureGraph(dir, exec, { out: args.out, timeoutMs: args.timeoutMs, signal: exec.signal })
  if (!ensured.located.hasGraph) return { problem: noGraphMessage(dir, ensured) }

  const where = lookupWhere(ensured.located.outDir, { question: args.question ?? args.node ?? '' })
  const notes = []
  if (ensured.built) {
    notes.push(`Auto-built a code graph for ${dir} (${ensured.files} files, no LLM) because none existed.`)
  }
  return {
    argv: ['--graph', ensured.located.graphFile],
    dir,
    where,
    note: notes.join(' '),
  }
}

/**
 * Build the four read-only graph tools.
 * @param ctx - plugin context, used for the last-resort history guidance.
 * @returns tool definitions for the tool registry.
 */
export function queryTools(ctx) {
  return [
    textTool({
      name: 'graphify_query',
      description:
        'Layer two of project search: answer an architecture or relationship question by traversing the graph instead of reading files. Seeds come from the question, or from earlier trail hits when graphify_where already ran. Then read source files only for exact line-level detail. Builds a code graph automatically when the project has none.',
      parameters: {
        question: { type: 'string', required: true, description: 'The question in natural language, naming the concepts you expect in the graph.' },
        path: PROJECT_PATH_PARAMETER,
        dfs: { type: 'boolean', description: 'Depth-first instead of the default breadth-first traversal.' },
        budget: { type: 'number', description: 'Cap the answer at roughly this many tokens (default 2000).' },
        seeds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Explicit start nodes (id, label or file path) instead of the keyword matches from the question.',
        },
        context: {
          type: 'array',
          items: { type: 'string' },
          description: 'Only follow edges whose context matches these values, such as call or import.',
        },
        graph: GRAPH_PARAMETER,
        timeoutMs: TIMEOUT_PARAMETER,
      },
      async execute(args, exec) {
        const dir = resolveTargetDir(args.path, exec)
        const prepared = await prepareRead(dir, args, exec)
        if (prepared.problem !== undefined) return prepared.problem

        const argv = ['query', args.question, ...prepared.argv]
        if (args.dfs === true) argv.push('--dfs')
        if (typeof args.budget === 'number') argv.push('--budget', String(Math.max(100, Math.round(args.budget))))
        const explicitSeeds = args.seeds ?? []
        for (const seed of explicitSeeds) argv.push('--seed', String(seed))
        // Without explicit seeds, start from what answered this before.
        if (explicitSeeds.length === 0) {
          for (const seed of (prepared.where?.nodes ?? []).slice(0, MAX_TRAIL_SEEDS)) argv.push('--seed', seed)
        }
        for (const context of args.context ?? []) argv.push('--context', String(context))

        const result = await runGraphify(argv, { cwd: dir, timeoutMs: args.timeoutMs, signal: exec.signal })
        assertStarted(result)
        const note = result.exitCode === 3
          ? 'Exit 3: a name in the question is ambiguous; the candidates are listed above. Re-run with seeds naming the exact node.'
          : result.exitCode === 4
            ? lines(
                'Exit 4: no node matched. Try graphify_where for earlier work on these words, graphify_explain on a nearby name, or fall back to source reads.',
                `Last resort: ${historyFallback(ctx)}`,
              )
            : undefined
        return lines(prepared.note, trailBlock(prepared.where), formatRun(result, { note }))
      },
    }),

    textTool({
      name: 'graphify_path',
      description:
        'Shortest path between two named nodes in the graph, with the relation and confidence of every hop. Use it to show how two subsystems connect instead of inferring the chain from imports by hand. Exits 3 with candidates when a name is ambiguous, 4 when no node matches.',
      parameters: {
        from: { type: 'string', required: true, description: 'Start node: id, label or file path.' },
        to: { type: 'string', required: true, description: 'End node: id, label or file path.' },
        path: PROJECT_PATH_PARAMETER,
        undirected: { type: 'boolean', description: 'Ignore edge direction rather than following it.' },
        graph: GRAPH_PARAMETER,
        timeoutMs: TIMEOUT_PARAMETER,
      },
      async execute(args, exec) {
        const dir = resolveTargetDir(args.path, exec)
        const prepared = await prepareRead(dir, { ...args, node: args.from }, exec)
        if (prepared.problem !== undefined) return prepared.problem
        const argv = ['path', args.from, args.to, ...prepared.argv]
        if (args.undirected === true) argv.push('--undirected')
        const result = await runGraphify(argv, { cwd: dir, timeoutMs: args.timeoutMs, signal: exec.signal })
        assertStarted(result)
        const note = result.exitCode === 3
          ? 'Exit 3: ambiguous name, candidates above. Retry with the exact id.'
          : result.exitCode === 4
            ? 'Exit 4: no connecting path, or a name did not match. Try graphify_explain on each endpoint to confirm the exact node names.'
            : undefined
        return lines(prepared.note, formatRun(result, { note }))
      },
    }),

    textTool({
      name: 'graphify_explain',
      description:
        'Plain-language explanation of one node: its source location, community, degree, and every connection with relation and confidence. The fastest way to learn what a symbol is and what depends on it.',
      parameters: {
        node: { type: 'string', required: true, description: 'Node to explain: id, label or file path.' },
        path: PROJECT_PATH_PARAMETER,
        all: { type: 'boolean', description: 'List every connection instead of the 20 most connected.' },
        graph: GRAPH_PARAMETER,
        timeoutMs: TIMEOUT_PARAMETER,
      },
      async execute(args, exec) {
        const dir = resolveTargetDir(args.path, exec)
        const prepared = await prepareRead(dir, args, exec)
        if (prepared.problem !== undefined) return prepared.problem
        const argv = ['explain', args.node, ...prepared.argv]
        if (args.all === true) argv.push('--all')
        const result = await runGraphify(argv, { cwd: dir, timeoutMs: args.timeoutMs, signal: exec.signal })
        assertStarted(result)
        const note = result.exitCode === 4
          ? 'Exit 4: no node matched that name. Try graphify_where for earlier work on these words, or the label as it appears in GRAPH_REPORT.md.'
          : result.exitCode === 3
            ? 'Exit 3: ambiguous name, candidates above.'
            : undefined
        return lines(prepared.note, formatRun(result, { note }))
      },
    }),

    textTool({
      name: 'graphify_affected',
      description:
        'Reverse traversal: what is impacted if this node changes. Use it before editing a shared symbol, moving a module, or answering "what breaks if I touch this".',
      parameters: {
        node: { type: 'string', required: true, description: 'Node whose dependents you want: id, label or file path.' },
        path: PROJECT_PATH_PARAMETER,
        depth: { type: 'number', description: 'Reverse traversal depth (default 2).' },
        relation: {
          type: 'array',
          items: { type: 'string' },
          description: 'Only traverse these relations in reverse, such as calls or imports.',
        },
        graph: GRAPH_PARAMETER,
        timeoutMs: TIMEOUT_PARAMETER,
      },
      async execute(args, exec) {
        const dir = resolveTargetDir(args.path, exec)
        const prepared = await prepareRead(dir, args, exec)
        if (prepared.problem !== undefined) return prepared.problem
        const argv = ['affected', args.node, ...prepared.argv]
        if (typeof args.depth === 'number') argv.push('--depth', String(Math.max(1, Math.round(args.depth))))
        for (const relation of args.relation ?? []) argv.push('--relation', String(relation))
        const result = await runGraphify(argv, { cwd: dir, timeoutMs: args.timeoutMs, signal: exec.signal })
        assertStarted(result)
        const note = result.exitCode === 4
          ? 'Exit 4: no node matched that name.'
          : result.exitCode === 3
            ? 'Exit 3: ambiguous name, candidates above.'
            : undefined
        return lines(prepared.note, formatRun(result, { note }))
      },
    }),
  ]
}
