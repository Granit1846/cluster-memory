/**
 * Output shaping shared by every tool.
 *
 * Tool results are plain text because that is exactly what the model reads;
 * every block keeps the exact command, the exit status and an explicit note when
 * the CLI failed while still producing artifacts (community labelling without an
 * API key exits nonzero after writing the report).
 */
import { GraphifyError, succeeded } from './runner.js'

/** Cap for any single tool result. */
const MAX_CHARS = 60_000

/**
 * Recurring CLI failures that have a concrete fix, matched on output rather than
 * exit status: the CLI exits nonzero for a missing optional Python module, for a
 * missing API key during community naming, and for an auth rejection, and each of
 * those needs a different next step.
 */
const RECIPES = [
  {
    pattern: /No module named '([^']+)'/,
    advise: (match) =>
      `The CLI's Python environment is missing "${match[1]}". Install it there: \`uv tool install --force "graphifyy[office,video,mcp]"\`, or \`pip install ${match[1]}\` into that same environment.`,
  },
  {
    pattern: /no API key found/i,
    advise: () =>
      'No model backend is configured, so only the deterministic extraction ran. Set DEEPSEEK_API_KEY, GEMINI_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY or MOONSHOT_API_KEY, pass backend: "ollama" for a local model, or keep working code-only.',
  },
  {
    pattern: /Failed to authenticate|API Error: 403|invalid_api_key|401 Unauthorized/i,
    advise: () =>
      'The configured backend rejected the request. Check that backend\'s key, or pick a different one with the backend argument.',
  },
  {
    pattern: /fatal: not a git repository/i,
    advise: () => 'This folder is not a git repository, so hooks and commit metadata are unavailable.',
  },
]

/** Fix-oriented advice for a failed run, empty when nothing matches. */
export function advice(result) {
  if (succeeded(result)) return []
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  const hints = []
  for (const recipe of RECIPES) {
    const match = output.match(recipe.pattern)
    if (match !== null) hints.push(recipe.advise(match))
  }
  return [...new Set(hints)]
}

/** Clip a long block, keeping both the head and the tail. */
export function clip(text, max = MAX_CHARS) {
  if (typeof text !== 'string' || text.length <= max) return text ?? ''
  const headLength = Math.floor(max * 0.4)
  const tailLength = max - headLength
  return `${text.slice(0, headLength)}\n… [${text.length - max} characters clipped] …\n${text.slice(-tailLength)}`
}

/** Seconds with one decimal, for short commands this still reads clearly. */
export function seconds(milliseconds) {
  return `${(milliseconds / 1000).toFixed(1)}s`
}

/**
 * Render a CLI run as the result text.
 * @param result - a settled {@link runGraphify} outcome.
 * @param options - optional trailing note and whether to show stderr prominently.
 */
export function formatRun(result, options = {}) {
  const lines = []
  lines.push(`$ ${result.command}`)
  const status = []
  status.push(`exit ${result.exitCode ?? 'no status'}`)
  status.push(seconds(result.durationMs))
  if (result.timedOut) status.push('TIMED OUT')
  if (result.aborted) status.push('CANCELLED')
  if (result.overflowed === true) status.push('OUTPUT STOPPED')
  lines.push(status.join(' · '))

  const stdout = (result.stdout ?? '').trim()
  const stderr = (result.stderr ?? '').trim()
  if (stdout !== '') {
    lines.push('', stdout)
  }
  if (stderr !== '') {
    lines.push('', '--- stderr ---', stderr)
  }
  if (result.spawnError !== undefined) {
    lines.push('', `--- spawn failed ---`, String(result.spawnError?.message ?? result.spawnError))
  }
  if (result.timedOut) {
    lines.push('', 'The command hit the deadline and was stopped. Re-run with a larger timeoutMs, or narrow the scope (use codeOnly, a subfolder, or fewer files).')
  }
  if (result.overflowed === true) {
    lines.push('', 'The command was stopped because it wrote an unreasonable amount of output; narrow the scope (a subfolder, or codeOnly) and retry.')
  }
  if (result.aborted) {
    lines.push('', 'The call was cancelled, so the process was stopped. Artifacts on disk may be partial; re-run to complete the graph.')
  }
  const hints = advice(result)
  if (hints.length > 0) lines.push('', '--- advice ---', ...hints)
  if (options.note !== undefined && options.note !== '') lines.push('', options.note)
  return clip(lines.join('\n'))
}

/** Throw for a run that could not start at all (missing binary, spawn failure). */
export function assertStarted(result) {
  if (result.spawnError !== undefined) {
    throw new GraphifyError(
      `Could not start ${result.binary}: ${result.spawnError?.message ?? result.spawnError}. Check that the file is executable and that its interpreter exists.`,
      'GRAPHIFY_SPAWN_FAILED',
    )
  }
}

/** A `label: value` line, skipped when the value is unavailable. */
export function field(label, value) {
  if (value === undefined || value === null || value === '') return undefined
  return `${label}: ${value}`
}

/** Join present lines only. */
export function lines(...values) {
  const flat = values.flat(Infinity).filter((value) => typeof value === 'string' && value !== '')
  return flat.join('\n')
}

/** Byte size in human units. */
export function humanBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return undefined
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value < 10 && index > 0 ? value.toFixed(1) : Math.round(value)} ${units[index]}`
}

/** "1 entry" / "3 entries" without dragging in an i18n layer for two words. */
export function plural(count, singular, pluralForm) {
  return `${count} ${count === 1 ? singular : pluralForm}`
}
