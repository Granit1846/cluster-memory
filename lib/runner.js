/**
 * Locating and running the `graphify` CLI.
 *
 * Every tool in this plugin funnels through {@link runGraphify}, so the process
 * contract (argument array, no shell, tree kill, cooperative cancellation) lives
 * in exactly one place.
 */
import { spawn } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { settings } from './settings.js'

/** Default per-call deadline. */
export const DEFAULT_TIMEOUT_MS = 120_000

/** Hard cap any caller may request; larger values are clamped. */
export const MAX_TIMEOUT_MS = 1_800_000

/** How long a cancelled process may linger before it is killed forcefully. */
const KILL_GRACE_MS = 5_000

/** Bytes kept per stream; anything beyond is reported and clipped. */
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024

/** A run writing more than this to its logs is stopped rather than grown. */
const RUN_OUTPUT_GUARD_BYTES = 256 * 1024 * 1024


const WINDOWS = process.platform === 'win32'

const INSTALL_HINT = [
  'Install the CLI with one of:',
  '  uv tool install graphifyy',
  '  pipx install graphifyy',
  '  pip install graphifyy   (package is graphifyy, command is graphify)',
  'Then make sure the Scripts/bin directory is on PATH, or set DSH_GRAPHIFY_BIN to the executable.',
].join('\n')

/** Failure that is not the CLI's own exit status: plugin wiring, paths, spawn. */
export class GraphifyError extends Error {
  /**
   * @param message - model-facing, actionable text.
   * @param code - stable machine-readable reason.
   */
  constructor(message, code = 'GRAPHIFY_ERROR') {
    super(message)
    this.name = 'GraphifyError'
    this.code = code
  }
}

function isFile(candidate) {
  try {
    return statSync(candidate).isFile()
  } catch {
    return false
  }
}

function executableNames(base) {
  if (!WINDOWS) return [base]
  const extensions = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean)
  const names = new Set([base])
  for (const extension of extensions) {
    names.add(base + extension.toLowerCase())
    names.add(base + extension.toUpperCase())
  }
  return [...names]
}

/**
 * Every path that could hold the CLI, in priority order.
 * @param explicit - an exact executable path from a tool argument.
 * @returns absolute candidate paths, highest priority first.
 */
export function binaryCandidates(explicit) {
  const candidates = []
  const push = (value) => {
    if (typeof value !== 'string') return
    const trimmed = value.trim()
    if (trimmed !== '') candidates.push(path.resolve(trimmed))
  }
  push(explicit)
  push(settings().bin)
  push(process.env.DSH_GRAPHIFY_BIN)
  push(process.env.GRAPHIFY_BIN)

  const directories = []
  for (const entry of (process.env.PATH ?? '').split(path.delimiter)) {
    if (entry.trim() !== '') directories.push(entry)
  }
  const home = homedir()
  // uv tool, pipx and per-user installs are frequently NOT on the PATH a GUI
  // application inherits, which is the usual "works in my terminal" report.
  directories.push(path.join(home, '.local', 'bin'))
  directories.push(path.join(home, '.cargo', 'bin'))
  directories.push(path.join(home, '.local', 'pipx', 'bin'))
  directories.push('/usr/local/bin')
  directories.push('/opt/homebrew/bin')
  if (WINDOWS) {
    const appData = process.env.APPDATA
    if (appData) {
      for (const version of ['Python314', 'Python313', 'Python312', 'Python311', 'Python310']) {
        directories.push(path.join(appData, 'Python', version, 'Scripts'))
      }
    }
    directories.push(path.join(home, 'AppData', 'Roaming', 'Python', 'Scripts'))
  }

  const names = executableNames('graphify')
  for (const directory of directories) {
    for (const name of names) candidates.push(path.join(directory, name))
  }
  return [...new Set(candidates)]
}

/**
 * Resolve the CLI executable.
 * @param explicit - an exact executable path from a tool argument.
 * @returns the first existing candidate, or undefined.
 */
export function findBinary(explicit) {
  for (const candidate of binaryCandidates(explicit)) {
    if (isFile(candidate)) return candidate
  }
  return undefined
}

/** Where the CLI would be looked for, for diagnostics. */
export function searchedLocations(explicit) {
  const candidates = binaryCandidates(explicit)
  return { candidates, preview: candidates.slice(0, 12) }
}

/** Explain a missing CLI without failing the call. */
export function missingBinaryMessage(explicit) {
  const { preview } = searchedLocations(explicit)
  return [
    'graphify CLI not found.',
    INSTALL_HINT,
    '',
    `Looked at ${preview.length} of ${binaryCandidates(explicit).length} candidates, starting with:`,
    ...preview.map((candidate) => `  ${candidate}`),
  ].join('\n')
}

function clampTimeout(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return DEFAULT_TIMEOUT_MS
  return Math.min(Math.round(value), MAX_TIMEOUT_MS)
}

function childEnvironment() {
  return {
    ...process.env,
    // Deterministic, descriptor-safe capture: no ANSI noise, no pager, UTF-8 out.
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    CLICOLOR: '0',
    PYTHONIOENCODING: 'utf-8',
    PYTHONUNBUFFERED: '1',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
  }
}

/** Shell-free quoting, for the `$ command` line only; execution never uses a shell. */
export function quoteArg(argument) {
  if (argument === '') return '""'
  return /^[A-Za-z0-9_./:=@,+%-]+$/.test(argument) ? argument : `"${argument.replaceAll('"', '\\"')}"`
}

/**
 * Kill a process and everything it started.
 *
 * `graphify extract` fans out to worker subprocesses; killing only the parent
 * leaves them writing into graphify-out, so on Windows the whole tree dies via
 * taskkill and elsewhere the child gets a grace period before SIGKILL.
 */
function terminate(child) {
  if (child.pid === undefined) return
  if (child.exitCode !== null || child.signalCode !== null) return
  if (WINDOWS) {
    try {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      })
      killer.on('error', () => {})
    } catch {
      child.kill()
    }
    return
  }
  child.kill('SIGTERM')
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }, KILL_GRACE_MS)
  timer.unref?.()
}

/**
 * Capture buffers.
 *
 * Output is collected through two temporary files rather than pipes. Pipes
 * require the parent to own a named-pipe handle, which a confined host may
 * refuse outright (spawn EPERM), and a full pipe buffer stalls a chatty child
 * until the parent drains it. Files have neither problem, and they let a runaway
 * run be stopped on size instead of on a memory spike.
 */
function createCapture() {
  const directory = settings().captureDir?.trim() || process.env.DSH_GRAPHIFY_CAPTURE_DIR?.trim() || tmpdir()
  try {
    const root = mkdtempSync(path.join(directory, 'dsh-graphify-'))
    const stdoutFile = path.join(root, 'stdout.log')
    const stderrFile = path.join(root, 'stderr.log')
    const stdoutFd = openSync(stdoutFile, 'w')
    const stderrFd = openSync(stderrFile, 'w')
    return { kind: 'files', root, stdoutFile, stderrFile, fds: [stdoutFd, stderrFd] }
  } catch {
    return { kind: 'pipes' }
  }
}

function fileSize(file) {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

function readCaptureFile(file) {
  const size = fileSize(file)
  if (size === 0) return ''
  if (size <= MAX_CAPTURE_BYTES) return readFileSync(file, 'utf8')
  const headLength = Math.floor(MAX_CAPTURE_BYTES / 3)
  const tailLength = MAX_CAPTURE_BYTES - headLength
  const fd = openSync(file, 'r')
  try {
    const head = Buffer.alloc(headLength)
    readSync(fd, head, 0, headLength, 0)
    const tail = Buffer.alloc(tailLength)
    readSync(fd, tail, 0, tailLength, size - tailLength)
    return `${head.toString('utf8')}\n… [${size - MAX_CAPTURE_BYTES} bytes clipped] …\n${tail.toString('utf8')}`
  } finally {
    closeSync(fd)
  }
}

function releaseCapture(capture) {
  if (capture.kind !== 'files') return
  for (const fd of capture.fds) {
    try {
      closeSync(fd)
    } catch {
      // Already closed by the OS during a crash; nothing to repair.
    }
  }
  try {
    rmSync(capture.root, { recursive: true, force: true })
  } catch {
    // A locked log on Windows is left for the OS temp cleaner.
  }
}

/**
 * Run the CLI once.
 * @param args - argument array exactly as the CLI expects it.
 * @param options - working directory, deadline, cancellation signal, explicit binary.
 * @returns the settled process outcome; never rejects for a nonzero exit code.
 */
export async function runGraphify(args, options = {}) {
  const binary = findBinary(options.bin)
  if (binary === undefined) throw new GraphifyError(missingBinaryMessage(options.bin), 'GRAPHIFY_NOT_INSTALLED')

  const cwd = options.cwd
  const timeoutMs = clampTimeout(options.timeoutMs)
  const signal = options.signal
  const command = ['graphify', ...args].map(quoteArg).join(' ')
  const startedAt = Date.now()

  if (signal?.aborted === true) {
    return {
      command, binary, args, cwd, exitCode: null, stdout: '', stderr: '',
      timedOut: false, aborted: true, overflowed: false, spawnError: undefined, durationMs: 0,
    }
  }

  const capture = createCapture()
  const stdio = capture.kind === 'files' ? ['ignore', capture.fds[0], capture.fds[1]] : ['ignore', 'pipe', 'pipe']

  return await new Promise((resolve) => {
    let child
    try {
      child = spawn(binary, args, { cwd, windowsHide: true, env: childEnvironment(), stdio })
    } catch (error) {
      releaseCapture(capture)
      resolve({
        command, binary, args, cwd, exitCode: null, stdout: '', stderr: '',
        timedOut: false, aborted: false, overflowed: false, spawnError: error, durationMs: Date.now() - startedAt,
      })
      return
    }

    let pipedStdout = ''
    let pipedStderr = ''
    let timedOut = false
    let aborted = false
    let overflowed = false
    let settled = false
    let deadline
    let watchdog

    const cleanup = () => {
      if (deadline !== undefined) clearTimeout(deadline)
      if (watchdog !== undefined) clearInterval(watchdog)
      signal?.removeEventListener?.('abort', onAbort)
    }

    const settle = (exitCode, spawnError) => {
      if (settled) return
      settled = true
      cleanup()
      let stdout = pipedStdout
      let stderr = pipedStderr
      if (capture.kind === 'files') {
        stdout = readCaptureFile(capture.stdoutFile)
        stderr = readCaptureFile(capture.stderrFile)
        releaseCapture(capture)
      }
      resolve({
        command, binary, args, cwd, exitCode, stdout, stderr,
        timedOut, aborted, overflowed, spawnError, durationMs: Date.now() - startedAt,
      })
    }

    const onAbort = () => {
      aborted = true
      terminate(child)
    }

    if (capture.kind === 'pipes') {
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', (chunk) => {
        pipedStdout += chunk
      })
      child.stderr?.on('data', (chunk) => {
        pipedStderr += chunk
      })
    } else {
      watchdog = setInterval(() => {
        const total = fileSize(capture.stdoutFile) + fileSize(capture.stderrFile)
        if (total > RUN_OUTPUT_GUARD_BYTES) {
          overflowed = true
          terminate(child)
        }
      }, 1_000)
      watchdog.unref?.()
    }

    child.on('error', (error) => settle(null, error))
    child.on('close', (code) => settle(code, undefined))

    deadline = setTimeout(() => {
      timedOut = true
      terminate(child)
    }, timeoutMs)
    deadline.unref?.()

    signal?.addEventListener?.('abort', onAbort, { once: true })
    if (signal?.aborted === true) onAbort()
  })
}


/** True when the CLI reported success. */
export function succeeded(result) {
  return result.spawnError === undefined && !result.timedOut && !result.aborted && result.exitCode === 0
}
