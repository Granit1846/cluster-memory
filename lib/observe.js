/**
 * Leaving a trail after every tool call.
 *
 * The plugin observes the registry's `tools/result` event, which fires once per
 * settled call for every tool in the session — not only its own. That is what
 * makes the trail complete: a `grep` or a `read` leaves keywords and files just
 * like a graph traversal does, so the next session can see where the answer came
 * from without replaying the conversation.
 *
 * Observation is fire-and-forget by contract: it never throws, never awaits, and
 * never changes a tool result.
 */
import path from 'node:path'
import { settings } from './settings.js'
import { extractFiles, extractKeywords, extractNodes, recordEntry } from './trail.js'
import { insideWorkspace, locateGraph, sessionWorkspace } from './workspace.js'

/** Tools that would record themselves, or that read the trail without adding to it. */
const SELF_RECORDING = new Set(['graphify_remember', 'graphify_where', 'graphify_lessons'])

/**
 * Session administration, not project work. Installing a plugin or editing a todo
 * list says nothing about where the code lives, and an install log indexed as a
 * project keyword makes the next lookup worse.
 */
const IGNORED_TOOLS = new Set([
  'ask_user_question', 'create_goal', 'get_goal', 'update_goal', 'todo_write', 'plugin_manager',
  'create_skill', 'skill', 'list_agents', 'send_message', 'interrupt_agent', 'subagent', 'subagent_fork',
  'workflow', 'working_directory', 'list_subagent_models', 'load_workspace_dependencies',
])

/** Tool families whose results never describe the project's content. */
const IGNORED_PREFIXES = ['agent_teams_', 'schedule_', 'job_', 'dsh_im_']

/** Result text kept for keyword mining; long reads would only add noise. */
const RESULT_SAMPLE_CHARS = 4_000
/** Argument text kept for keyword mining. */
const ARGUMENT_SAMPLE_CHARS = 2_000

/** Flatten string values out of tool arguments, bounded in depth and size. */
function argumentStrings(value, depth = 0, out = []) {
  if (depth > 2 || out.length > 40) return out
  if (typeof value === 'string') {
    out.push(value)
    return out
  }
  if (Array.isArray(value)) {
    for (const item of value) argumentStrings(item, depth + 1, out)
    return out
  }
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) argumentStrings(item, depth + 1, out)
  }
  return out
}

/** Text a tool actually returned, whichever shape the result uses. */
function resultText(result) {
  if (typeof result?.value === 'string') return result.value
  const blocks = result?.content
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/** The human-readable intent behind a call, used as its trail question. */
function callQuestion(args) {
  for (const key of ['question', 'query', 'pattern', 'command', 'description', 'path', 'file_path', 'url']) {
    const value = args?.[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

/** Split an identifier into lowercased parts, so `InvoiceStore` matches "invoice". */
function identifierParts(identifier) {
  return identifier
    .split(/(?=[A-Z])|[_.\-\s/\\]+/)
    .map((part) => part.toLowerCase())
    .filter((part) => part.length >= 4)
}

/** Strip a path down to its stem, which is what people search for. */
function fileStem(file) {
  const base = path.basename(String(file))
  const stem = base.includes('.') ? base.slice(0, base.lastIndexOf('.')) : base
  return stem.length >= 3 ? stem.toLowerCase() : undefined
}

/**
 * Build the trail entry for one settled tool call.
 * @param exec - the registry's execution record (name, arguments, agent).
 * @param result - the settled tool result.
 * @returns the entry plus the directory to record it in, or undefined to skip.
 */
export function buildTrailEntry(exec, result) {
  const toolName = exec?.name
  if (typeof toolName !== 'string' || SELF_RECORDING.has(toolName)) return undefined
  if (IGNORED_TOOLS.has(toolName)) return undefined
  if (IGNORED_PREFIXES.some((prefix) => toolName.startsWith(prefix))) return undefined

  const session = exec?.agent?.session
  const workspace = sessionWorkspace(exec)
  const args = exec?.arguments ?? {}
  const rawPath = typeof args.path === 'string' && args.path.trim() !== '' ? args.path.trim() : undefined
  const dir = rawPath === undefined ? workspace : path.resolve(workspace, rawPath)
  // A trail outside the session workspace would write where this plugin
  // deliberately does not write without an explicit opt-in.
  if (!insideWorkspace(dir, exec)) return undefined

  const text = resultText(result).slice(0, RESULT_SAMPLE_CHARS)
  const argumentText = argumentStrings(args).join(' ').slice(0, ARGUMENT_SAMPLE_CHARS)
  const question = callQuestion(args)

  const files = [...new Set([...extractFiles(text), ...extractFiles(argumentText)])].slice(0, 24)
  const nodes = extractNodes(text).slice(0, 20)

  const keywords = extractKeywords(
    question ?? '',
    argumentText,
    files.map((file) => fileStem(file) ?? '').join(' '),
    nodes.join(' '),
    text.length <= RESULT_SAMPLE_CHARS ? text.slice(0, 1_500) : '',
    ...nodes.flatMap((node) => identifierParts(node)),
    ...files.flatMap((file) => identifierParts(fileStem(file) ?? '')),
  )

  if (keywords.length === 0 && files.length === 0) return undefined

  return {
    outDir: locateGraph(dir).outDir,
    entry: {
      kind: 'tool',
      tool: toolName,
      session: session?.id,
      question,
      keywords,
      files,
      nodes,
      failed: result?.isError === true,
    },
  }
}

/**
 * Subscribe to every settled tool call in this context.
 * @param ctx - the plugin context (a cordis context with events).
 * @returns whether a subscription was installed.
 */
export function observeToolResults(ctx) {
  if (!settings().trail) return false
  const handle = (exec, result) => {
    try {
      const observation = buildTrailEntry(exec, result)
      if (observation !== undefined) recordEntry(observation.outDir, observation.entry)
    } catch (error) {
      ctx?.logger?.warn?.(`graphify trail: could not record a tool result: ${String(error?.message ?? error)}`)
    }
  }
  for (const candidate of [ctx, ctx?.root]) {
    if (typeof candidate?.on === 'function') {
      candidate.on('tools/result', handle)
      return true
    }
  }
  return false
}
