/**
 * The tool-definition helper shared by every graphify tool.
 *
 * Parameters are authored in the same convenient shape `defineTool` accepts
 * (`{ field: { type, required, description } }`) but are emitted as the plain
 * JSON Schema the registry projects onto the wire: the supported keyword subset
 * is type/oneOf/properties/required/additionalProperties/items/enum/const plus
 * annotations, so `required` is hoisted to the object level and nothing else is
 * added.
 */

import { settings } from '../settings.js'

/** Every tool returns formatted text: it is exactly what the model reads. */
const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
}

function objectSchema(spec) {
  const properties = {}
  const required = []
  for (const [key, schema] of Object.entries(spec ?? {})) {
    const { required: isRequired, ...rest } = schema
    properties[key] = rest
    if (isRequired === true) required.push(key)
  }
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  }
}

/**
 * Build one text tool.
 * @param options - name, description, parameter spec and execute body.
 */
export function textTool(options) {
  return {
    name: options.name,
    description: options.description,
    parameters: objectSchema(options.parameters),
    output: TEXT_OUTPUT,
    execute: options.execute,
  }
}

/** The shared `path` parameter, worded once. */
export const PROJECT_PATH_PARAMETER = {
  type: 'string',
  description:
    'Project folder to work on. Defaults to the session workspace. Relative paths resolve from the session workspace; artifacts land in its graphify-out directory.',
}

/** The shared write opt-in. Only tool definitions that write include it. */
export const ALLOW_OUTSIDE_PARAMETER = {
  type: 'boolean',
  description:
    'Allow writing graph artifacts for a folder outside the session workspace. Needed because this plugin runs the CLI directly, without the shell tool approval path. Defaults to false.',
}

/** The shared deadline. */
export const TIMEOUT_PARAMETER = {
  type: 'number',
  description:
    'Deadline in milliseconds (default 120000, max 1800000). Large corpora and doc/image extraction legitimately need several minutes.',
}

/** The shared explicit graph file. */
export const GRAPH_PARAMETER = {
  type: 'string',
  description: 'Path to a specific graph.json, when it does not live in the default graphify-out directory.',
}

/**
 * Whether the session-history tools are registered in this deployment.
 *
 * Layered search puts history last, and the guidance only mentions a tool the
 * model actually has: recommending `session_search` in a profile where the
 * session-search bundle is off would send the model after a tool that is not
 * there. Resolved at call time because the bundle can be switched on or off
 * while this plugin stays loaded.
 */
export function hasHistorySearch(ctx) {
  if (settings().historyHint === 'never') return false
  try {
    return ctx?.tools?.get?.('session_search') !== undefined
  } catch {
    return false
  }
}

/** The last-resort layer, worded once for every tool that can fall through to it. */
export function historyFallback(ctx) {
  if (settings().historyHint === 'never') {
    return 'This profile switches session-history lookup off (historyHint: never), so answer from the trail, the graph and the files.'
  }
  return hasHistorySearch(ctx)
    ? 'Only if the graph and the files come up empty: session_search for earlier conversations in this workspace, then session_trace or session_event_read for detail. After a hit, call graphify_remember so the next lookup stays in the cheap layer.'
    : 'Session history is not searchable in this profile; install @deepseek-ai/dsh-experimental-session-search if last-resort recall of earlier conversations is needed.'
}
