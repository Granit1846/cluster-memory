/**
 * Turning the graph into other artifacts, and the two project-level commands
 * that touch the world outside graphify-out: fetching a URL into the corpus and
 * installing git hooks.
 */
import { assertStarted, formatRun, lines } from '../text.js'
import { GraphifyError, runGraphify, succeeded } from '../runner.js'
import { assertWritable, locateGraph, resolveFileArgument, resolveTargetDir } from '../workspace.js'
import {
  ALLOW_OUTSIDE_PARAMETER,
  PROJECT_PATH_PARAMETER,
  TIMEOUT_PARAMETER,
  textTool,
} from './define.js'

/** Export targets the CLI exposes, plus the standalone tree view. */
const EXPORT_FORMATS = ['html', 'svg', 'graphml', 'obsidian', 'wiki', 'neo4j', 'falkordb', 'callflow-html', 'tree']

/** Say where the graph lives, so a failed export is easy to retry by hand. */
function graphHint(dir) {
  const located = locateGraph(dir)
  return located.hasGraph
    ? `Default graph: ${located.graphFile}`
    : `No graph in ${located.outDir} yet — build one with graphify_build first.`
}

/** No graph to export is a precondition, not a CLI failure. */
function missingGraph(dir, args) {
  if (typeof args.graph === 'string' && args.graph.trim() !== '') return undefined
  const located = locateGraph(dir)
  if (located.hasGraph) return undefined
  return lines(`No graph found for ${dir}.`, `Looked in: ${located.outDir}`, 'Build one with graphify_build (codeOnly: true for a fast offline pass).')
}

/**
 * Build the export, corpus-add and hook tools.
 * @returns tool definitions for the tool registry.
 */
export function exportTools() {
  return [
    textTool({
      name: 'graphify_export',
      description:
        'Export the graph to another artifact: interactive graph.html, graph.svg, GraphML for Gephi/yEd, an Obsidian vault, a wiki an agent can crawl, Cypher for Neo4j/FalkorDB, a collapsible D3 tree, or a Mermaid call-flow page. Use it when the user wants something to open, commit or hand to another tool.',
      parameters: {
        format: { type: 'string', enum: EXPORT_FORMATS, required: true, description: 'Target artifact format.' },
        path: PROJECT_PATH_PARAMETER,
        graph: { type: 'string', description: 'Path to a specific graph.json. Defaults to the project graphify-out directory.' },
        labels: { type: 'string', description: 'Path to .graphify_labels.json when community labels live elsewhere.' },
        output: { type: 'string', description: 'Output file or directory, resolved by the CLI against the project folder.' },
        push: { type: 'string', description: 'For neo4j or falkordb: push to this URI instead of writing Cypher.' },
        user: { type: 'string', description: 'Database user for push. Keep the secret in NEO4J_PASSWORD or FALKORDB_PASSWORD, not here.' },
        allowOutsideWorkspace: ALLOW_OUTSIDE_PARAMETER,
        timeoutMs: TIMEOUT_PARAMETER,
      },
      async execute(args, exec) {
        const dir = resolveTargetDir(args.path, exec)
        assertWritable(dir, exec, args.allowOutsideWorkspace)
        const problem = missingGraph(dir, args)
        if (problem !== undefined) return problem

        const argv = args.format === 'tree' ? ['tree'] : ['export', args.format]
        if (typeof args.graph === 'string' && args.graph.trim() !== '') argv.push('--graph', resolveFileArgument(args.graph, exec))
        else argv.push('--graph', locateGraph(dir).graphFile)
        if (typeof args.labels === 'string' && args.labels.trim() !== '') argv.push('--labels', resolveFileArgument(args.labels, exec))
        if (typeof args.output === 'string' && args.output.trim() !== '') argv.push('--output', args.output.trim())
        if (typeof args.push === 'string' && args.push.trim() !== '') argv.push('--push', args.push.trim())
        if (typeof args.user === 'string' && args.user.trim() !== '') argv.push('--user', args.user.trim())

        const result = await runGraphify(argv, { cwd: dir, timeoutMs: args.timeoutMs, signal: exec.signal })
        assertStarted(result)
        const note = succeeded(result)
          ? `Project: ${dir}`
          : lines(`Project: ${dir}`, graphHint(dir))
        return formatRun(result, { note })
      },
    }),

    textTool({
      name: 'graphify_add',
      description:
        'Fetch a URL (paper, article, tweet, documentation page), save it into the corpus folder, and update the graph with it. Needs a model backend for the semantic pass. Use it to fold outside material into the same graph the code lives in.',
      parameters: {
        url: { type: 'string', required: true, description: 'HTTP(S) URL to fetch into the corpus.' },
        path: PROJECT_PATH_PARAMETER,
        author: { type: 'string', description: 'Attribute the content to this author.' },
        dir: { type: 'string', description: 'Corpus folder for the fetched file. Defaults to ./raw inside the project.' },
        allowOutsideWorkspace: ALLOW_OUTSIDE_PARAMETER,
        timeoutMs: TIMEOUT_PARAMETER,
      },
      async execute(args, exec) {
        let parsed
        try {
          parsed = new URL(args.url)
        } catch {
          throw new GraphifyError(`Not a valid URL: ${args.url}`, 'BAD_URL')
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          throw new GraphifyError(`Only http and https URLs can be added, got ${parsed.protocol}`, 'BAD_URL')
        }
        const dir = resolveTargetDir(args.path, exec)
        assertWritable(dir, exec, args.allowOutsideWorkspace)
        const argv = ['add', parsed.toString()]
        if (typeof args.author === 'string' && args.author.trim() !== '') argv.push('--author', args.author.trim())
        if (typeof args.dir === 'string' && args.dir.trim() !== '') argv.push('--dir', args.dir.trim())
        const result = await runGraphify(argv, { cwd: dir, timeoutMs: args.timeoutMs, signal: exec.signal })
        assertStarted(result)
        const note = succeeded(result)
          ? 'The fetched file is now part of the corpus; ask the graph about it with graphify_query.'
          : 'If the fetch failed the graph is unchanged; if only the update failed, the file stays in the corpus folder and a later graphify_update picks it up.'
        return formatRun(result, { note })
      },
    }),

    textTool({
      name: 'graphify_hook',
      description:
        'Manage the git hooks that keep the graph current (post-commit, post-checkout, post-merge, post-rewrite) and the graph.json merge driver. action=status first, then install when the user wants the graph refreshed automatically instead of on request. This writes into .git/hooks of the project.',
      parameters: {
        action: { type: 'string', enum: ['status', 'install', 'uninstall'], required: true, description: 'Hook action to perform.' },
        path: PROJECT_PATH_PARAMETER,
        allowOutsideWorkspace: ALLOW_OUTSIDE_PARAMETER,
        timeoutMs: TIMEOUT_PARAMETER,
      },
      async execute(args, exec) {
        const dir = resolveTargetDir(args.path, exec)
        if (args.action !== 'status') assertWritable(dir, exec, args.allowOutsideWorkspace)
        const result = await runGraphify(['hook', args.action], { cwd: dir, timeoutMs: args.timeoutMs, signal: exec.signal })
        assertStarted(result)
        const note = args.action === 'install' && succeeded(result)
          ? 'Hooks now rebuild the graph after commits and merges; no background process is needed.'
          : undefined
        return formatRun(result, { note })
      },
    }),
  ]
}
