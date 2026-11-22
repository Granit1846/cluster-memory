/**
 * Building the graph the first time someone asks a question.
 *
 * The whole point of the plugin is a fast answer, so "no graph yet" must not be a
 * dead end. When a read tool finds no graph it runs the code-only extraction —
 * deterministic, no API key, seconds rather than minutes — and says so in the
 * answer. Bounded on purpose: a corpus above the file budget, a folder outside the
 * session workspace, or an explicit opt-out gets the build hint instead of a
 * surprise multi-minute run.
 */
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { runGraphify } from './runner.js'
import { settings } from './settings.js'
import { insideWorkspace, locateGraph } from './workspace.js'

/** Files above which automatic extraction is refused as a surprise cost. */
const MAX_AUTO_FILES = 4_000
/** Deadline for the automatic pass. */
const AUTO_TIMEOUT_MS = 300_000

/** Directories that never contribute to a first-pass graph. */
const SKIPPED_DIRECTORIES = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'target', 'vendor',
  '.next', '.nuxt', '.venv', 'venv', '__pycache__', 'coverage', '.cache', '.artifacts',
  'graphify-out', '.idea', '.vscode', 'bin', 'obj',
])

/**
 * Count source files without reading them.
 * @param dir - the project folder.
 * @returns the count (capped) and whether the budget was exhausted.
 */
export function countProjectFiles(dir) {
  const limit = settings().autobuildFileLimit ?? MAX_AUTO_FILES
  let files = 0
  let exhausted = false
  const walk = (current, depth) => {
    if (exhausted || depth > 12) return
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (exhausted) return
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name.toLowerCase())) continue
        walk(path.join(current, entry.name), depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      files += 1
      if (files > limit) {
        exhausted = true
        return
      }
    }
  }
  walk(dir, 0)
  return { files, exhausted }
}

/**
 * Locate the graph, building it first when that is cheap and safe.
 * @param dir - the project folder.
 * @param exec - tool execution context, for the workspace check and cancellation.
 * @param options - output override, deadline and cancellation signal.
 * @returns the located graph, whether it was just built, and why it was not.
 */
export async function ensureGraph(dir, exec, options = {}) {
  const located = locateGraph(dir, options)
  if (located.hasGraph) return { located, built: false }

  const config = settings()
  if (!config.autobuild) {
    return { located, built: false, reason: 'automatic building is turned off in the plugin settings (autobuild: false)' }
  }
  if (!insideWorkspace(dir, exec)) {
    return { located, built: false, reason: 'the folder is outside this session\'s workspace' }
  }
  const scan = countProjectFiles(dir)
  if (scan.exhausted) {
    return { located, built: false, reason: `the folder holds more than ${config.autobuildFileLimit} files, so a build is not started automatically` }
  }
  if (scan.files === 0) {
    return { located, built: false, reason: 'no files were found to index' }
  }

  const result = await runGraphify(['extract', dir, '--code-only'], {
    cwd: dir,
    timeoutMs: options.timeoutMs ?? config.autobuildTimeoutMs,
    signal: options.signal,
  })
  const after = locateGraph(dir, options)
  return { located: after, built: true, files: scan.files, result }
}
