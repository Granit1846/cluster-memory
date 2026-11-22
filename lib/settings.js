/**
 * Effective settings for the plugin.
 *
 * Config in the profile's `cordis.patch.yml` wins, then the environment, then the
 * default. Resolved once when the plugin is applied and read through `settings()`
 * everywhere else, so a tool does not have to thread configuration through ten
 * call signatures for a value that never changes during a session.
 */
const DEFAULTS = {
  /** Record a keyword trail of every settled tool call. */
  trail: true,
  /** Build a code-only graph automatically when a read tool finds none. */
  autobuild: true,
  /** Refuse the automatic build above this many files. */
  autobuildFileLimit: 4_000,
  /** Deadline for the automatic build. */
  autobuildTimeoutMs: 300_000,
  /** Where CLI output is captured; defaults to the OS temp directory. */
  captureDir: undefined,
  /** Explicit path to the graphify executable. */
  bin: undefined,
  /** When to mention session-history tools in hints: auto, always, never. */
  historyHint: 'auto',
  /** Optional allow-list of tool names, for a narrower surface. */
  tools: undefined,
}

let current = { ...DEFAULTS }

function asBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

function asPositive(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : fallback
}

function asString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Merge profile config, environment and defaults.
 * @param config - the `config` object cordis passes to `apply`.
 */
export function resolveSettings(config) {
  const raw = typeof config === 'object' && config !== null ? config : {}
  const env = process.env
  return {
    trail: asBoolean(raw.trail, env.DSH_GRAPHIFY_TRAIL === '0' ? false : DEFAULTS.trail),
    autobuild: asBoolean(raw.autobuild, env.DSH_GRAPHIFY_AUTOBUILD === '0' ? false : DEFAULTS.autobuild),
    autobuildFileLimit: asPositive(raw.autobuildFileLimit, DEFAULTS.autobuildFileLimit),
    autobuildTimeoutMs: asPositive(raw.autobuildTimeoutMs, DEFAULTS.autobuildTimeoutMs),
    captureDir: asString(raw.captureDir) ?? asString(env.DSH_GRAPHIFY_CAPTURE_DIR),
    bin: asString(raw.bin) ?? asString(env.DSH_GRAPHIFY_BIN) ?? asString(env.GRAPHIFY_BIN),
    historyHint: raw.historyHint === 'always' || raw.historyHint === 'never' ? raw.historyHint : 'auto',
    tools: Array.isArray(raw.tools) && raw.tools.length > 0 ? new Set(raw.tools.filter((name) => typeof name === 'string')) : undefined,
  }
}

/** Install the resolved settings for this process. */
export function setSettings(config) {
  current = resolveSettings(config)
  return current
}

/** The settings in force. */
export function settings() {
  return current
}

/** One-line summary for diagnostics. */
export function describeSettings() {
  const value = current
  return [
    `trail: ${value.trail ? 'on' : 'off'}`,
    `autobuild: ${value.autobuild ? `on up to ${value.autobuildFileLimit} files` : 'off'}`,
    `history hint: ${value.historyHint}`,
    `bin: ${value.bin ?? 'auto-detected'}`,
    `capture dir: ${value.captureDir ?? 'OS temp'}`,
    value.tools === undefined ? 'tools: all' : `tools: ${[...value.tools].join(', ')}`,
  ].join(' · ')
}
