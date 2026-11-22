/**
 * Project, output-directory and graph-artifact resolution.
 *
 * A Graphify project is a folder plus a `graphify-out` directory next to it. This
 * module resolves both, refuses to write outside the session workspace unless the
 * caller says so explicitly, and reads the artifacts without parsing a graph that
 * is too large to be worth loading.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { GraphifyError } from './runner.js'

/** Parsing ceiling for graph.json; above this, counts come from the CLI instead. */
const MAX_PARSED_GRAPH_BYTES = 64 * 1024 * 1024

/** The session working directory a tool call runs against. */
export function sessionWorkspace(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd.trim() !== '') return path.resolve(cwd)
  return process.cwd()
}

function expandHome(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(homedir(), value.slice(2))
  return value
}

/**
 * Resolve the folder a call works on.
 * @param rawPath - the optional `path` argument.
 * @param exec - tool execution context, used for the session workspace.
 */
export function resolveTargetDir(rawPath, exec) {
  const base = sessionWorkspace(exec)
  const raw = typeof rawPath === 'string' && rawPath.trim() !== '' ? expandHome(rawPath.trim()) : base
  const dir = path.resolve(base, raw)
  let stat
  try {
    stat = statSync(dir)
  } catch {
    throw new GraphifyError(`Project folder does not exist: ${dir}`, 'BAD_PATH')
  }
  if (!stat.isDirectory()) throw new GraphifyError(`Not a directory: ${dir}`, 'BAD_PATH')
  return dir
}

function isInside(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/** Whether a folder is the session workspace or inside it. */
export function insideWorkspace(dir, exec) {
  return isInside(dir, sessionWorkspace(exec))
}

/**
 * Guard a call that writes artifacts.
 *
 * The plugin starts the CLI directly, without the shell tool's sandbox and
 * approval path, so writes outside the session workspace require an explicit
 * opt-in instead of happening silently.
 */
export function assertWritable(dir, exec, allowOutsideWorkspace) {
  const root = path.parse(dir).root
  if (path.resolve(dir) === path.resolve(root)) {
    throw new GraphifyError(`Refusing to graph a filesystem root (${dir}). Pass a project folder instead.`, 'REFUSED_SCOPE')
  }
  if (allowOutsideWorkspace === true) return
  const workspace = sessionWorkspace(exec)
  if (isInside(dir, workspace)) return
  throw new GraphifyError(
    `Refusing to write graph artifacts for ${dir}: it is outside this session's workspace (${workspace}). Pass allowOutsideWorkspace: true if that is intentional.`,
    'OUTSIDE_WORKSPACE',
  )
}

/**
 * Resolve a path argument written by the model (`~`, relative or absolute).
 * @param raw - the raw argument.
 * @param exec - tool execution context, used for the session workspace.
 */
export function resolveFileArgument(raw, exec) {
  return path.resolve(sessionWorkspace(exec), expandHome(String(raw).trim()))
}

/**
 * Directories that may hold `graph.json` for a project, most specific first.
 * @param dir - the project folder.
 * @param options - `out` as passed to `graphify extract --out`.
 */
export function outputCandidates(dir, options = {}) {
  const candidates = []
  if (typeof options.out === 'string' && options.out.trim() !== '') {
    const outRoot = path.resolve(dir, expandHome(options.out.trim()))
    candidates.push(path.join(outRoot, 'graphify-out'), outRoot)
  }
  const envOut = process.env.GRAPHIFY_OUT
  if (typeof envOut === 'string' && envOut.trim() !== '') {
    const resolved = path.resolve(dir, expandHome(envOut.trim()))
    candidates.push(resolved, path.join(resolved, 'graphify-out'))
  }
  candidates.push(path.join(dir, 'graphify-out'))
  return [...new Set(candidates)]
}

function fileSize(file) {
  try {
    return statSync(file).size
  } catch {
    return undefined
  }
}

function modifiedAt(file) {
  try {
    return statSync(file).mtime
  } catch {
    return undefined
  }
}

/**
 * Locate the graph for a project without running the CLI.
 * @returns the resolved directories, the graph path and which artifacts exist.
 */
export function locateGraph(dir, options = {}) {
  const candidates = outputCandidates(dir, options)
  let outDir = candidates[candidates.length - 1]
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, 'graph.json'))) {
      outDir = candidate
      break
    }
  }
  const graphFile = path.join(outDir, 'graph.json')
  const reportFile = path.join(outDir, 'GRAPH_REPORT.md')
  const htmlFile = path.join(outDir, 'graph.html')
  return {
    outDir,
    graphFile,
    reportFile,
    htmlFile,
    hasGraph: existsSync(graphFile),
    hasReport: existsSync(reportFile),
    hasHtml: existsSync(htmlFile),
    dir,
  }
}

/**
 * Read counts and metadata out of graph.json.
 *
 * Returns `tooLarge` instead of loading a graph that would blow up the tool's
 * memory; callers fall back to CLI-reported counts.
 */
export function readGraphSummary(graphFile) {
  const size = fileSize(graphFile)
  if (size === undefined) return { exists: false }
  if (size > MAX_PARSED_GRAPH_BYTES) return { exists: true, sizeBytes: size, tooLarge: true }
  let raw
  try {
    raw = readFileSync(graphFile, 'utf8')
  } catch (error) {
    return { exists: true, sizeBytes: size, error: String(error?.message ?? error) }
  }
  let graph
  try {
    graph = JSON.parse(raw)
  } catch (error) {
    return { exists: true, sizeBytes: size, error: `graph.json is not valid JSON: ${String(error?.message ?? error)}` }
  }
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : []
  const links = Array.isArray(graph.links) ? graph.links : Array.isArray(graph.edges) ? graph.edges : []
  const communities = new Set()
  const confidence = new Map()
  for (const node of nodes) {
    if (node?.community !== undefined && node.community !== null) communities.add(String(node.community))
  }
  for (const link of links) {
    const key = String(link?.confidence ?? 'UNKNOWN')
    confidence.set(key, (confidence.get(key) ?? 0) + 1)
  }
  return {
    exists: true,
    sizeBytes: size,
    nodes: nodes.length,
    links: links.length,
    communities: communities.size,
    directed: graph.directed,
    multigraph: graph.multigraph,
    schemaVersion: graph.graph?.schema_version,
    graphifyVersion: graph.graph?.graphify_version,
    confidence: Object.fromEntries(confidence),
    modifiedAt: modifiedAt(graphFile),
  }
}

/** Files that a build may have written, newest-first friendly for status output. */
export function artifacts(outDir) {
  const known = [
    'graph.json',
    'GRAPH_REPORT.md',
    'graph.html',
    'graph.svg',
    'graph.graphml',
    'GRAPH_TREE.html',
    'cypher.txt',
    'manifest.json',
    'needs_update',
    '.graphify_root',
    '.graphify_analysis.json',
    '.graphify_labels.json',
  ]
  const present = []
  for (const name of known) {
    const file = path.join(outDir, name)
    if (!existsSync(file)) continue
    present.push({ name, sizeBytes: fileSize(file) })
  }
  for (const [name, label] of [['wiki', 'wiki/'], ['obsidian', 'obsidian/'], ['cache', 'cache/'], ['memory', 'memory/']]) {
    if (existsSync(path.join(outDir, name))) present.push({ name: label, sizeBytes: undefined })
  }
  return present
}

/** Read the `needs_update` marker the CLI leaves when semantic re-extraction is pending. */
export function needsUpdateFlag(outDir) {
  const file = path.join(outDir, 'needs_update')
  if (!existsSync(file)) return undefined
  try {
    const text = readFileSync(file, 'utf8').trim()
    return text === '' ? true : text
  } catch {
    return true
  }
}

/** Count files the last extraction tracked, from manifest.json. */
export function manifestFileCount(outDir) {
  const file = path.join(outDir, 'manifest.json')
  if (!existsSync(file)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? Object.keys(parsed).length : undefined
  } catch {
    return undefined
  }
}
