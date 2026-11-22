/**
 * Host half of Cluster Memory for DeepSeek Harness.
 *
 * Three pieces, all of them optional to each other:
 *  - a model-facing tool surface over the `graphify` CLI, which owns the graph;
 *  - a trail observer that records every settled tool call, so the project keeps a
 *    keyword index of what was already asked and where it was answered;
 *  - a bundled skill that states the order of operations: trail, report, graph
 *    traversal, files — and remember what you concluded.
 *
 * Settings arrive as the `config` object of the entry in `cordis.patch.yml`, for
 * example `config: { trail: false }`. See docs/SETTINGS.md for every key.
 */
import { createTools } from './lib/tools/index.js'
import { observeToolResults } from './lib/observe.js'
import { GRAPHIFY_SKILL } from './lib/skill.js'
import { setSettings } from './lib/settings.js'

/** Cordis plugin name. */
export const name = 'tool-cluster-memory'

/** The tool registry this plugin registers into. */
export const inject = ['tools']

/**
 * Register the tools, start trailing, and offer the skill when a skill registry
 * exists in this deployment.
 * @param ctx - the tool registry, plus whatever else the profile composes.
 * @param config - optional settings from the profile patch.
 */
export function apply(ctx, config) {
  const settings = setSettings(config)
  for (const definition of createTools(ctx)) {
    if (settings.tools !== undefined && !settings.tools.has(definition.name)) continue
    ctx.tools.register(definition)
  }
  if (settings.trail) observeToolResults(ctx)
  if (typeof ctx.inject === 'function') {
    ctx.inject(['skills'], (scoped) => {
      scoped.skills.register(GRAPHIFY_SKILL)
    })
  }
}
