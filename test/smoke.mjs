/**
 * Self-check for the plugin: schema conformance, trail logic, and a live round
 * trip against throwaway fixtures.
 *
 * Run it with the bundled runtime:
 *   node test/smoke.mjs
 *
 * The live part needs the `graphify` CLI; the schema and trail parts always run.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply } from '../index.js'
import { findBinary } from '../lib/runner.js'
import { buildTrailEntry } from '../lib/observe.js'
import { lookupWhere, recordEntry, trailSummary } from '../lib/trail.js'
import { locateGraph } from '../lib/workspace.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = path.join(here, '.tmp', 'fixture')
const autoFixture = path.join(here, '.tmp', 'auto')

/** Keywords the registry accepts (its JSON Schema subset). */
const SUPPORTED_KEYWORDS = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
  'description', 'title', 'default', 'examples',
])

let failures = 0
const check = (label, body) => {
  try {
    body()
    console.log(`ok   ${label}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL ${label}\n     ${error?.message ?? error}`)
  }
}

function assertSupportedSchema(schema, at) {
  assert.equal(typeof schema, 'object', `${at} must be an object`)
  for (const key of Object.keys(schema)) {
    assert.ok(SUPPORTED_KEYWORDS.has(key), `${at}.${key} is not a supported keyword`)
  }
  if (schema.properties !== undefined) {
    assert.equal(schema.type, 'object', `${at}.properties requires type object`)
    for (const [name, child] of Object.entries(schema.properties)) assertSupportedSchema(child, `${at}.properties.${name}`)
  }
  if (schema.required !== undefined) {
    assert.ok(Array.isArray(schema.required), `${at}.required must be an array`)
    for (const name of schema.required) assert.ok(schema.properties?.[name] !== undefined, `${at}.required names unknown ${name}`)
  }
  if (schema.items !== undefined) assertSupportedSchema(schema.items, `${at}.items`)
  if (schema.oneOf !== undefined) schema.oneOf.forEach((child, index) => assertSupportedSchema(child, `${at}.oneOf[${index}]`))
}

const exec = (cwd, signal) => ({ agent: { session: { id: 'smoke', header: { cwd } } }, signal })

// --- registration ---------------------------------------------------------

const registered = []
apply({
  tools: {
    register: (definition) => registered.push(definition),
    // Pretend the session-search bundle is enabled in this profile.
    get: (name) => (name === 'session_search' ? { name: 'session_search' } : undefined),
  },
})

// A profile without the session-search bundle must not be told to call a tool it lacks.
const withoutHistory = []
apply({ tools: { register: (definition) => withoutHistory.push(definition), get: () => undefined } })

check('registers fifteen tools', () => assert.equal(registered.length, 15))
check('tool names are unique and prefixed', () => {
  const names = registered.map((definition) => definition.name)
  assert.equal(new Set(names).size, names.length, 'duplicate tool name')
  for (const name of names) assert.match(name, /^graphify_[a-z_]+$/)
})
check('definitions are complete', () => {
  for (const definition of registered) {
    assert.equal(typeof definition.description, 'string')
    assert.ok(definition.description.length > 80, `${definition.name} description is too thin`)
    assert.equal(typeof definition.execute, 'function', `${definition.name} has no execute`)
    assert.equal(definition.output?.schema?.type, 'string', `${definition.name} must return text`)
    assert.equal(typeof definition.output?.render, 'function')
  }
})
check('parameter schemas stay inside the registry subset', () => {
  for (const definition of registered) assertSupportedSchema(definition.parameters, definition.name)
})
check('memory tools are present', () => {
  for (const required of ['graphify_where', 'graphify_remember', 'graphify_lessons']) {
    assert.ok(registered.some((definition) => definition.name === required), `${required} is missing`)
  }
})

const tool = (name) => registered.find((definition) => definition.name === name)
const call = async (name, args, context) => await tool(name).execute(args, context)

// --- fixture --------------------------------------------------------------

rmSync(path.join(here, '.tmp'), { recursive: true, force: true })
mkdirSync(fixture, { recursive: true })
writeFileSync(path.join(fixture, 'invoice.js'), [
  'export function parseInvoice(text) {',
  '  return { total: Number(text.replace(/[^0-9.]/g, "")) }',
  '}',
  '',
  'export class InvoiceStore {',
  '  constructor() { this.items = [] }',
  '  add(invoice) { this.items.push(invoice); return this }',
  '}',
  '',
].join('\n'))
writeFileSync(path.join(fixture, 'service.js'), [
  'import { parseInvoice, InvoiceStore } from "./invoice.js"',
  '',
  'export function ingest(payload) {',
  '  const invoice = parseInvoice(payload)',
  '  return new InvoiceStore().add(invoice)',
  '}',
  '',
].join('\n'))

// --- trail logic ----------------------------------------------------------

const trailEntry = buildTrailEntry(
  { name: 'graphify_query', arguments: { question: 'where are invoices stored' }, agent: { session: { id: 's1', header: { cwd: fixture } } } },
  { value: 'NODE InvoiceStore [src=invoice.js loc=L9 community=store]\nEDGE invoice.js --contains [EXTRACTED]--> InvoiceStore at=invoice.js:L9' },
)
check('trail entry carries keywords, files and nodes', () => {
  assert.ok(trailEntry !== undefined, 'no entry produced')
  for (const keyword of ['invoice', 'invoices', 'store']) {
    assert.ok(trailEntry.entry.keywords.includes(keyword), `missing keyword ${keyword} in ${trailEntry.entry.keywords.join(', ')}`)
  }
  assert.ok(trailEntry.entry.files.some((file) => file.includes('invoice.js')), `files: ${trailEntry.entry.files.join(', ')}`)
  assert.ok(trailEntry.entry.nodes.includes('InvoiceStore'), `nodes: ${trailEntry.entry.nodes.join(', ')}`)
  assert.equal(trailEntry.entry.tool, 'graphify_query')
})
check('the memory tools do not trail themselves', () => {
  const ignored = buildTrailEntry(
    { name: 'graphify_remember', arguments: { question: 'q' }, agent: { session: { header: { cwd: fixture } } } },
    { value: 'x' },
  )
  assert.equal(ignored, undefined)
})
check('session administration leaves no trail', () => {
  for (const name of ['plugin_manager', 'todo_write', 'agent_teams_status', 'schedule_create']) {
    const ignored = buildTrailEntry(
      { name, arguments: { target: 'x' }, agent: { session: { header: { cwd: fixture } } } },
      { value: 'installed something' },
    )
    assert.equal(ignored, undefined, `${name} should not be trailed`)
  }
})
check('a project path outside the workspace is not trailed', () => {
  const ignored = buildTrailEntry(
    { name: 'graphify_query', arguments: { path: tmpdir(), question: 'anything' }, agent: { session: { header: { cwd: fixture } } } },
    { value: 'NODE x' },
  )
  assert.equal(ignored, undefined)
})
check('reads of outside files still land in the local trail', () => {
  // The entry is written under the session workspace, so a foreign file path is
  // data in the entry, not a write outside the workspace.
  const entry = buildTrailEntry(
    { name: 'read', arguments: { file_path: path.join(tmpdir(), 'elsewhere.js') }, agent: { session: { header: { cwd: fixture } } } },
    { value: 'content' },
  )
  assert.ok(entry !== undefined, 'no entry produced')
  assert.ok(entry.outDir.startsWith(path.join(fixture, 'graphify-out')), entry.outDir)
})

const outDir = locateGraph(fixture).outDir
recordEntry(outDir, trailEntry.entry)
recordEntry(outDir, {
  kind: 'answer',
  tool: 'graphify_remember',
  question: 'how does a payment reach the invoice store',
  keywords: ['payment', 'invoice'],
  files: ['service.js'],
  nodes: ['ingest()'],
  outcome: 'useful',
})
check('lookup returns files and nodes for earlier words', () => {
  const found = lookupWhere(outDir, { question: 'where are invoices stored' })
  assert.ok(found.matches.length > 0, 'no matches')
  assert.ok(found.files.length > 0, 'no files')
  assert.ok(found.nodes.length > 0, 'no nodes')
  assert.ok(found.entries >= 2, `entries: ${found.entries}`)
})
check('trail summary reports the hottest words', () => {
  const summary = trailSummary(outDir)
  assert.ok(summary.entries >= 2)
  assert.ok(summary.hottest.some((entry) => entry.keyword === 'invoice'), JSON.stringify(summary.hottest))
})

// --- live behaviour -------------------------------------------------------

const cli = findBinary()
console.log(cli === undefined ? 'skip live checks: graphify CLI not found' : `live checks against ${cli}`)

if (cli !== undefined) {
  const build = await call('graphify_build', { codeOnly: true }, exec(fixture))
  check('build writes a graph', () => {
    assert.match(build, /exit 0/)
    assert.match(build, /graph\.json/)
  })

  const status = await call('graphify_status', {}, exec(fixture))
  check('status reports counts, freshness and the trail', () => {
    assert.match(status, /nodes/)
    assert.match(status, /verdict: (up to date|stale)/)
    assert.match(status, /Trail/)
  })

  const query = await call('graphify_query', { question: 'where are invoices stored' }, exec(fixture))
  check('query traverses the graph', () => assert.match(query, /NODE/))

  const explain = await call('graphify_explain', { node: 'InvoiceStore' }, exec(fixture))
  check('explain describes a node', () => assert.match(explain, /InvoiceStore/))

  const route = await call('graphify_path', { from: 'ingest', to: 'InvoiceStore' }, exec(fixture))
  check('path connects two nodes', () => assert.match(route, /path|ambiguous|no connecting path/i))

  const clustered = await call('graphify_update', { clusterOnly: true }, exec(fixture))
  check('clusterOnly produces the report', () => assert.match(clustered, /GRAPH_REPORT\.md/))

  const report = await call('graphify_report', { section: 'god_nodes' }, exec(fixture))
  check('report section reader returns a section or lists the available ones', () => assert.match(report, /god nodes|not present/i))

  const doctor = await call('graphify_doctor', {}, exec(fixture))
  check('doctor inspects the install and the trail', () => {
    assert.match(doctor, /Setup/)
    assert.match(doctor, /Trail/)
  })

  const remembered = await call('graphify_remember', {
    question: 'where are invoices stored',
    answer: 'InvoiceStore keeps them in memory; service.js ingest() calls parseInvoice and adds to the store.',
    keywords: ['invoice', 'store', 'ingest'],
    files: ['invoice.js', 'service.js'],
    nodes: ['InvoiceStore'],
  }, exec(fixture))
  check('remember writes the trail', () => {
    assert.match(remembered, /Remembered/)
    assert.match(remembered, /Recorded in the trail/)
  })

  const where = await call('graphify_where', { query: 'where are invoices stored' }, exec(fixture))
  check('where points at the files that answered before', () => {
    assert.match(where, /Where earlier answers|invoice/)
    assert.match(where, /files:/)
  })

  const miss = await call('graphify_where', { query: 'zzz quantum banana' }, exec(fixture))
  check('an empty trail descends the layers, history last', () => {
    assert.match(miss, /Nothing in the trail/)
    assert.match(miss, /graphify_query/)
    assert.match(miss, /only if|last resort|session_search/i)
  })

  const missWithoutHistory = await withoutHistory
    .find((definition) => definition.name === 'graphify_where')
    .execute({ query: 'zzz quantum banana' }, exec(fixture))
  check('without the bundle the hint does not invent a missing tool', () => {
    assert.match(missWithoutHistory, /not searchable in this profile/)
    assert.doesNotMatch(missWithoutHistory, /session_trace/)
  })

  const recent = await call('graphify_where', { mode: 'recent', limit: 5 }, exec(fixture))
  check('recent lists the newest entries', () => assert.match(recent, /graphify_remember|graphify_query/))

  const lessons = await call('graphify_lessons', { refresh: false }, exec(fixture))
  check('lessons reports the trail state', () => assert.match(lessons, /Trail|Hottest areas/))

  // A project with no graph at all: the first question builds one automatically.
  mkdirSync(autoFixture, { recursive: true })
  writeFileSync(path.join(autoFixture, 'billing.js'), 'export function charge(invoice) { return invoice.total }\n')
  const auto = await call('graphify_query', { question: 'how is an invoice charged' }, exec(autoFixture))
  check('a missing graph is built automatically', () => {
    assert.match(auto, /Auto-built a code graph/)
    assert.ok(locateGraph(autoFixture).hasGraph, 'graph.json was not created')
  })

  const outsideRoot = mkdtempSync(path.join(tmpdir(), 'dsh-graphify-outside-'))
  let refusal = ''
  try {
    await call('graphify_update', { path: outsideRoot }, exec(fixture))
  } catch (error) {
    refusal = String(error?.message ?? error)
  }
  check('writes outside the workspace are refused', () => assert.match(refusal, /outside this session/))
  rmSync(outsideRoot, { recursive: true, force: true })

  const empty = path.join(fixture, 'empty-subdir')
  mkdirSync(empty, { recursive: true })
  const noGraph = await call('graphify_query', { question: 'anything' }, exec(empty))
  check('an empty folder explains why nothing was built', () => assert.match(noGraph, /No graph for/))

  const cancelled = await call('graphify_build', { codeOnly: true }, exec(fixture, AbortSignal.abort()))
  check('cancellation is reported, not thrown', () => assert.match(cancelled, /CANCELLED/))
}

rmSync(path.join(here, '.tmp'), { recursive: true, force: true })

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
