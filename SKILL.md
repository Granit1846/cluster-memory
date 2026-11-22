---
name: cluster-memory
description: Use before searching a codebase or recalling earlier work in a project. Keeps a keyword trail - files, graph nodes and conclusions - so a question is answered by one small lookup instead of grepping, re-reading history, or re-deriving what was already known. Record the answer when done.
---

# Cluster Memory

A project remembers what it was asked. This skill keeps that memory as a keyword
index of conclusions, not transcripts: for every answered question it stores a few
keywords, the files that answered it, the graph nodes involved, and one sentence of
what was concluded. A later question is then a single small read - "where did we
look for these words?" - instead of a grep, a file crawl, or a scroll through
history that compaction may have hidden.

Everything lives in `.cluster-memory/` inside the project and is plain JSON, so it
survives new sessions, context compaction, model changes and even a different
agent.

## Search in layers, cheapest first

| Layer | What it is | Typical cost | How |
|---|---|---|---|
| 1 | Keyword trail | ~230 tokens | `cluster-memory where` |
| 2 | Code and docs | 100–600 tokens | `graphify query`, `grep`, targeted reads |
| 3 | Source files | 1.5–2.5k per file | read only what layer 2 pointed at |
| 4 | Earlier conversations | 3–6k | session history tools, only as a last resort |

Stop at the first layer that answers. Never start at the bottom.

### Layer 1 - trail (always start here)

```bash
node <skill-dir>/scripts/cluster-memory.mjs where "how is the invoice total computed"
```

It prints the matching keywords, the files and graph nodes that answered them
before, the earlier phrasings of the question, and the last conclusion. If that
conclusion still holds, answer from it and name its source - the question is done,
no file was opened.

An empty result is not an error. It means the trail has not seen this area yet:
descend to layer 2.

Add `--keywords a,b` when the user's words are vague but you know the domain terms.
Add `--json` when you need to process the result programmatically.

### Layer 2 - the code

If the [`graphify`](https://github.com/Graphify-Labs/graphify) CLI is installed,
prefer its graph over grepping: `graphify query "<question>"`, `graphify explain`,
`graphify path`, `graphify affected`. Nodes from layer 1 make excellent seeds.
Otherwise grep, bounded to the directories the trail suggests.

### Layer 3 - files

Only the files layer 2 named, and only for the exact lines, signatures or defaults
you still need.

### Layer 4 - earlier conversations (last resort)

Only when layers 1–3 found nothing. History records what was said, not what is true
now. Verify anything you take from it against the current code, then record it with
`remember` so the next attempt stays in layer 1.

## Always record what you concluded

After answering a question about the project - including a failed search - record
it:

```bash
node <skill-dir>/scripts/cluster-memory.mjs remember \
  --question "where are invoices stored" \
  --answer "InvoiceStore keeps them in memory; ingest() parses and adds." \
  --keywords invoice,store,ingest \
  --files src/invoice.js,src/service.js \
  --nodes InvoiceStore \
  --outcome useful
```

- `--keywords` are 3–8 domain words a *later* question would contain, not tool
  names and not file names. They are what the index is keyed on; chosen well, they
  make the next lookup instant. Omit them and they are derived from the text.
- `--outcome` is `useful`, `dead_end` for a path that went nowhere, or `corrected`
  together with `--correction "what the right answer was"`.
- Record dead ends too. Knowing where the answer is *not* saves the same search
  again.

## Automatic trailing (optional)

Where the agent supports hooks, tool results can be trailed without asking:

- Claude Code: a `PostToolUse` hook that pipes the tool name and input to
  `record` - see `examples/claude-code-hooks.json`.
- Any agent with git hooks: `examples/git-post-commit.sh` records the commit
  message keywords, so decisions tied to a commit are findable later.

```bash
echo '{"tool_name":"Read","tool_input":{"file_path":"src/invoice.js"}}' \
  | node <skill-dir>/scripts/cluster-memory.mjs record --tool read
```

`record` is deliberately forgiving: it keeps whatever keywords, files and nodes it
can mine, and does nothing when there is nothing to keep.

## Maintenance

```bash
node <skill-dir>/scripts/cluster-memory.mjs summary          # counts and hottest words
node <skill-dir>/scripts/cluster-memory.mjs recent --limit 10 # newest entries
node <skill-dir>/scripts/cluster-memory.mjs rebuild           # rebuild the index from the log
```

Commit `.cluster-memory/trail.jsonl` if the team should share the memory; ignore
`index.json`, it is derived. Nothing here leaves the machine and nothing calls a
model.

## Compatibility

In DSH this repository also installs as a bundle: it registers the same skill plus tools
with a `graphify_` prefix and writes its trail to `graphify-out/trail/`. When both stores
exist, `where` merges them, so the plugin and this skill share one memory without
configuration. Install routes for every agent: `docs/INSTALL.md`.
