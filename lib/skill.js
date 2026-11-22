/**
 * The bundled skill: the behavioural half of the plugin.
 *
 * Tools alone do not change what an agent does — it still greps by habit. The
 * skill states the layered order of search (trail → graph → files → history),
 * forbids starting at the expensive layer, and requires leaving a keyword trail so
 * the next session starts in the cheapest layer.
 *
 * Registered in memory through `ctx.skills.register`, so it ships with the plugin
 * and needs no file in any skills directory.
 */

/** Kebab-case catalog name; matches the published package name. */
export const SKILL_NAME = 'cluster-memory'

/** One-line routing text; this is all the model sees until it loads the skill. */
export const SKILL_DESCRIPTION =
  'Use for any question about this project\'s code, architecture, documents or earlier work: search in layers — keyword trail, then graph, then files, and only as a last resort earlier sessions — and leave a keyword trail after answering.'

/** The instruction body. */
export const SKILL_CONTENT = `# Layered project search

Four layers, cheapest first. Use the lowest-numbered layer that answers the
question, and stop there.

| Layer | What it is | Typical cost | Tool |
|---|---|---|---|
| 1 | Keyword trail of everything already asked here | ~230 tokens | \`graphify_where\` |
| 2 | Structural graph of the project | 70–560 tokens | \`graphify_report\`, \`graphify_query\`, \`graphify_explain\` |
| 3 | Source files | 1.5–2.5k per file | \`read\`, \`grep\` |
| 4 | Earlier conversations in this workspace | 3–6k per question | \`session_search\` → \`session_trace\` / \`session_event_read\` |

Layer 4 is a **last resort**, not a shortcut. History records what was said, not
what is true now; the code does.

## Layer 1 — trail (always start here)

\`graphify_where\` with the user's own words. It returns the files and nodes that
answered related questions before, the exact earlier questions, and the last
conclusion. If the conclusion still holds, answer from it and name the source. An
empty result is not a failure — it is the signal to descend.

## Layer 2 — graph

- \`graphify_report\` once per project, or \`section: "god_nodes"\` for orientation:
  the hubs, the surprising cross-community links, the questions this graph answers.
- \`graphify_query\` for relationship questions ("how does X reach Y", "what owns Z").
  Trail hits are used as seeds automatically; pass \`seeds\` when you know the names.
- \`graphify_explain\` for one symbol, \`graphify_affected\` before changing one.

A missing graph is not a dead end: these tools build a code-only graph on first
use.

## Layer 3 — files

Only the files the graph or the trail pointed at, and only for the exact lines,
signatures or default values you still need. Never grep the whole tree first.

## Layer 4 — session history (only when 1–3 found nothing)

\`session_search\` looks at earlier conversations in this workspace; follow a useful
hit with \`session_trace\` or \`session_event_read\`. Use it when the question is
about intent, a decision, or a preference that was never written into the code or
the trail — not when the code could answer it.

Every hit taken from layer 4 must be verified against the current code, and then
recorded with \`graphify_remember\`, so the same question is answered from layer 1
next time. A layer-4 search that is never remembered stays expensive forever.

## Leaving the trail (do this every time)

After answering a question about this project — including a failed search — call
\`graphify_remember\` with:

- \`question\`: the question in the user's words;
- \`answer\`: two or three sentences of what you concluded;
- \`keywords\`: 3–8 domain words a *later* question would contain (\`invoice\`,
  \`retry\`, \`refresh token\`), not tool names or file names;
- \`files\`: the files that actually answered it;
- \`outcome\`: \`useful\`, \`dead_end\` when the path went nowhere, or \`corrected\`
  with \`correction\` when the first answer was wrong.

## Keeping the graph honest

- Say whether the graph is current: \`graphify_status\` reports counts, the
  \`needs_update\` marker and a freshness verdict.
- After changing code, run \`graphify_update\` (incremental, no LLM, no API key).
  Use \`force: true\` after deleting or renaming code.
- Docs, PDFs and images only enter the graph through \`graphify_build\` (needs a
  model backend) or \`graphify_add\` for a URL. Code alone needs neither.
- \`graphify_update\` with \`clusterOnly: true\` regenerates \`GRAPH_REPORT.md\` without
  re-extracting files.
- Edges carry confidence: \`EXTRACTED\` (found in source), \`INFERRED\`, \`AMBIGUOUS\`.
  Say which one an answer rests on when it matters.

## Reporting back

Name the layer and the source: \`graphify_where\`, \`graphify_report\`,
\`graphify_query\`, a source file, or \`session_search\`. State the freshness verdict
and any place the graph did not cover the question, so the user knows the limits.
`

/** The in-memory skill definition. */
export const GRAPHIFY_SKILL = {
  name: SKILL_NAME,
  description: SKILL_DESCRIPTION,
  content: SKILL_CONTENT,
  invocation: { modelInvocable: true, userInvocable: true },
}
