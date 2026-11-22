/**
 * The complete tool surface, in the order it reads best in a system prompt:
 * find what is already known, diagnose, build, read, remember, publish.
 */
import { buildTools } from './build.js'
import { exportTools } from './export.js'
import { inspectTools } from './inspect.js'
import { memoryTools } from './memory.js'
import { queryTools } from './query.js'

/**
 * Build every tool definition.
 * @param ctx - plugin context; the memory tools use it to see whether session
 *   history is searchable, so their guidance only names tools that exist here.
 * @returns the tool definitions to register.
 */
export function createTools(ctx) {
  return [...memoryTools(ctx), ...inspectTools(), ...buildTools(), ...queryTools(ctx), ...exportTools()]
}
