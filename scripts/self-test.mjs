/**
 * Self-test: exercises the script as a library and as a CLI, in a throwaway project.
 *
 *   node scripts/self-test.mjs
 *
 * No network, no fixtures to download, cleans up after itself.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { lookup, main, recordEntry, recentEntries, rebuildIndex } from './cluster-memory.mjs'

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cluster-memory.mjs')
/** Returned by a check whose subject cannot be exercised in this environment. */
const SKIPPED = Symbol('skipped')
let failures = 0
const check = (label, body) => {
  try {
    const result = body()
    console.log(result === SKIPPED ? `skip ${label}` : `ok   ${label}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL ${label}\n     ${error?.message ?? error}`)
  }
}

const project = mkdtempSync(path.join(tmpdir(), 'cluster-memory-test-'))
const store = path.join(project, '.cluster-memory')

try {
  const recorded = recordEntry(project, {
    kind: 'answer',
    question: 'where are invoices stored',
    summary: 'InvoiceStore keeps them in memory; ingest() parses and adds.',
    keywords: ['invoice', 'store', 'ingest'],
    files: ['src/invoice.js', 'src/service.js'],
    nodes: ['InvoiceStore'],
    outcome: 'useful',
  })

  check('remember writes the log and the index', () => {
    assert.ok(existsSync(path.join(store, 'trail.jsonl')), 'trail.jsonl missing')
    assert.ok(existsSync(path.join(store, 'index.json')), 'index.json missing')
    assert.deepEqual(recorded.keywords, ['invoice', 'store', 'ingest'])
  })

  check('keywords given by the author are kept verbatim', () => {
    const index = JSON.parse(readFileSync(path.join(store, 'index.json'), 'utf8'))
    assert.ok(index.keywords.invoice !== undefined)
    assert.equal(index.count, 1)
  })

  check('where finds files, nodes and the conclusion', () => {
    const result = lookup(project, { question: 'where are invoices stored' })
    assert.ok(result.matches.length > 0, 'no matches')
    assert.ok(result.files.includes('src/invoice.js'), JSON.stringify(result.files))
    assert.ok(result.nodes.includes('InvoiceStore'), JSON.stringify(result.nodes))
    assert.equal(result.answers.length, 1)
    assert.match(result.answers[0].summary, /InvoiceStore/)
  })

  check('a miss returns no matches but usable keywords', () => {
    const result = lookup(project, { question: 'quantum banana telemetry' })
    assert.equal(result.matches.length, 0)
    assert.ok(result.terms.length > 0, 'no terms extracted')
  })

  check('prefix matching finds the keyword from a shorter stem', () => {
    const result = lookup(project, { question: 'invoic' })
    assert.ok(result.matches.some((match) => match.keyword === 'invoice'), JSON.stringify(result.matches.map((m) => m.keyword)))
  })

  check('a dead end is recorded as an outcome, not dropped', () => {
    recordEntry(project, {
      kind: 'answer',
      question: 'does the ledger write to s3',
      summary: 'No: the ledger is local only.',
      keywords: ['ledger', 's3'],
      outcome: 'dead_end',
    })
    const result = lookup(project, { question: 'does the ledger use s3' })
    assert.ok(result.answers.some((answer) => answer.outcome === 'dead_end'), JSON.stringify(result.answers))
  })

  check('the DSH plugin trail is merged into lookups', () => {
    const externalDir = path.join(project, 'graphify-out', 'trail')
    mkdirSync(externalDir, { recursive: true })
    writeFileSync(path.join(externalDir, 'index.json'), JSON.stringify({
      version: 1,
      count: 1,
      updatedAt: new Date().toISOString(),
      keywords: { webhook: { count: 1, lastSeen: new Date().toISOString(), files: ['src/hooks/webhook.ts'], nodes: [], questions: ['how do webhooks retry'] } },
    }))
    const result = lookup(project, { question: 'how do webhooks retry' })
    assert.ok(result.matches.some((match) => match.keyword === 'webhook'), JSON.stringify(result.matches.map((m) => m.keyword)))
    assert.ok(result.files.includes('src/hooks/webhook.ts'), JSON.stringify(result.files))
  })

  check('rebuild reconstructs the index from the log alone', () => {
    rmSync(path.join(store, 'index.json'), { force: true })
    const result = rebuildIndex(project)
    assert.ok(result.applied >= 2, `applied ${result.applied}`)
    const index = JSON.parse(readFileSync(path.join(store, 'index.json'), 'utf8'))
    assert.ok(index.keywords.invoice !== undefined)
    assert.ok(index.keywords.ledger !== undefined)
  })

  check('recent returns the newest entries', () => {
    const entries = recentEntries(project, 5)
    assert.ok(entries.length >= 2)
    assert.ok(entries.some((entry) => entry.question === 'does the ledger write to s3'))
  })

  // ---- CLI surface ----
  //
  // The entry point is exercised in-process: `main(argv)` is a pure function of its
  // arguments and `--cwd`, so a second Node process would only add a pipe that a
  // confined host may refuse (spawn EPERM). The two checks that need a real process
  // — the hook payload on stdin and the exit code — skip when spawning is denied.

  const run = (args) => main([...args, '--cwd', project])

  let spawnVerdict
  const canSpawn = () => {
    if (spawnVerdict !== undefined) return spawnVerdict
    try {
      execFileSync(process.execPath, ['-e', '0'], { stdio: 'pipe' })
      spawnVerdict = true
    } catch (error) {
      spawnVerdict = !/EPERM|EACCES/.test(String(error?.code ?? error?.message))
    }
    return spawnVerdict
  }

  check('CLI: where prints a project header', () => {
    const output = run(['where', 'where are invoices stored'])
    assert.match(output, /Project:/)
    assert.match(output, /invoice/)
  })

  check('CLI: where --json is parseable', () => {
    const parsed = JSON.parse(run(['where', 'invoices', '--json']))
    assert.ok(Array.isArray(parsed.matches))
  })

  check('CLI: remember adds an entry', () => {
    const output = run(['remember', '--question', 'how are totals computed', '--answer', 'parseInvoice sums the lines.', '--keywords', 'total,parse'])
    assert.match(output, /Remembered: how are totals computed/)
    assert.ok(recentEntries(project, 1).some((entry) => entry.question === 'how are totals computed'))
  })

  check('CLI: record mines a hook payload from stdin', () => {
    if (!canSpawn()) {
      console.log('     (this host refuses to spawn a child process)')
      return SKIPPED
    }
    const output = execFileSync(process.execPath, [script, 'record', '--stdin', '--tool', 'claude-code', '--cwd', project], {
      encoding: 'utf8',
      input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/repo/src/shipping/carrier.ts' } }),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    assert.match(output, /Recorded Read/)
    const last = recentEntries(project, 1)[0]
    assert.ok(last.files.some((file) => file.includes('carrier.ts')), JSON.stringify(last.files))
    assert.ok(last.keywords.includes('carrier'), JSON.stringify(last.keywords))
  })

  check('CLI: summary and recent run', () => {
    assert.match(run(['summary']), /Entries:/)
    assert.match(run(['recent', '--limit', '3']), /Entries shown: 3/)
  })

  check('CLI: a bad command reports usage instead of guessing', () => {
    assert.throws(() => main(['nonsense', '--cwd', project]), /unknown command/)
  })

  check('CLI: a bad command exits non-zero', () => {
    if (!canSpawn()) {
      console.log('     (this host refuses to spawn a child process)')
      return SKIPPED
    }
    let failed = false
    try {
      execFileSync(process.execPath, [script, 'nonsense'], { stdio: 'pipe' })
    } catch (error) {
      failed = true
      assert.match(String(error.stderr), /unknown command/)
    }
    assert.ok(failed, 'expected a non-zero exit')
  })
} finally {
  rmSync(project, { recursive: true, force: true })
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nall checks passed')
}
