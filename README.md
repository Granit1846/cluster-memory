# Cluster Memory

**A coding agent forgets. This makes the project remember.**

Cluster Memory keeps a keyword trail of what was already asked and found in a project —
the files, the graph nodes, and one sentence of what was concluded — so the next
question is answered by **one small lookup** instead of grepping the tree, re-reading
files, or scrolling through history that compaction may have hidden.

No database, no server, no embeddings, no model calls. A JSON file inside the project,
plus one dependency-free Node script.

```
agent asks: "where are invoices stored?"
      │
      ▼
cluster-memory where "where are invoices stored"
      │
      ├─ invoice ×4  → src/invoice.js, src/service.js
      │                nodes: InvoiceStore, ingest()
      ├─ asked before: "как считается итог счёта"
      └─ concluded: InvoiceStore keeps them in memory; ingest() parses and adds.
      │
      ▼
answer in ~230 tokens. No file opened, no grep, no history replay.
```

Version 1.2.0 · Node 20+ · MIT · works with Claude Code, Codex, Cursor, Gemini CLI and
DSH.

## Two ways to use it

| | **Skill** | **DSH plugin** |
|---|---|---|
| What it is | The layered-search procedure plus the `cluster-memory` CLI | 15 tools in the DSH tool list, automatic trailing, automatic first build |
| For | Claude Code, Codex, Cursor, Gemini CLI, any agent with a shell | DSH 0.2.0-rc.1+ |
| Install | `git clone` into the agent's skills directory | one bundle from GitHub |
| Cost while idle | nothing | ≈ 5 800 tokens of tool schemas, or ≈ 950 with a narrowed surface |

Both write the same trail format, so a project remembers across agents.

## Install — terminal (skill)

```bash
git clone https://github.com/Granit1846/cluster-memory.git ~/.claude/skills/cluster-memory
```

```powershell
# Windows
git clone https://github.com/Granit1846/cluster-memory.git "$env:USERPROFILE\.claude\skills\cluster-memory"
```

| Agent | Where it goes |
|---|---|
| Claude Code | `~/.claude/skills/cluster-memory/` (or `.claude/skills/` per project) |
| Codex | `~/.codex/skills/cluster-memory/` |
| Cursor | copy `SKILL.md` to `.cursor/rules/cluster-memory.mdc` |
| Gemini CLI | add `@cluster-memory/SKILL.md` to `GEMINI.md` |
| Anything else | clone anywhere and run `node scripts/cluster-memory.mjs` |

Verify:

```bash
node ~/.claude/skills/cluster-memory/scripts/cluster-memory.mjs summary
```

## Install — DSH plugin, straight from GitHub

The repository root **is** the bundle, so a git spec is enough — no build, no npm
publish, no clone.

In a DSH session, ask:

> Install the cluster-memory bundle from github:Granit1846/cluster-memory

which runs:

```
plugin_manager
  action: install_bundle
  target: github:Granit1846/cluster-memory
```

Or use the GUI: **Plugins** → **Add plugin** → paste the same spec → install → restart
when asked. Afterwards:

```
graphify_doctor
  settings: trail: on · autobuild: on up to 4000 files · history hint: auto · tools: all
```

Update and removal use the same spec: `install_bundle`, `set_bundle enabled: false`,
`remove_bundle`. Every route, plus local checkouts and troubleshooting, is in
[docs/INSTALL.md](docs/INSTALL.md).

## Use

```bash
# layer 1: where did we look for these words?
node scripts/cluster-memory.mjs where "how is the invoice total computed"

# record what you concluded (this is the write side)
node scripts/cluster-memory.mjs remember \
  --question "how is the invoice total computed" \
  --answer "parseInvoice strips non-digits; total lives on the invoice object." \
  --keywords invoice,total,parse \
  --files src/invoice.js --nodes parseInvoice --outcome useful

# housekeeping
node scripts/cluster-memory.mjs summary
node scripts/cluster-memory.mjs recent --limit 10
node scripts/cluster-memory.mjs rebuild
```

Every command takes `--cwd DIR` when the agent is not running from the project root.

## Layered search

The whole point is the order. Cheapest layer first, stop at the first that answers:

| # | Layer | Cost | Tool |
|---|---|---|---|
| 1 | Keyword trail | ~230 tokens | `cluster-memory where`, `graphify_where` |
| 2 | Code graph / grep | 100–600 tokens | `graphify query`, `graphify_query`, `grep` |
| 3 | Source files | 1.5–2.5k each | targeted reads |
| 4 | Earlier conversations | 3–6k | session history, last resort |

Measured numbers and the method behind them: [docs/COMPARISON.md](docs/COMPARISON.md).

## Storage

`.cluster-memory/` inside the project:

```
.cluster-memory/
├── trail.jsonl   # append-only entries, one JSON object per line
└── index.json    # derived: keyword → files / nodes / questions
```

`trail.jsonl` is the source of truth; `index.json` is rebuilt from it (`rebuild`).
Commit the log if the team should share the memory, ignore the index — the snippet is
in [.gitignore](.gitignore) already. The DSH plugin keeps its own trail under
`graphify-out/trail/`, and `where` merges the two when both exist.

Entry shape:

```json
{"at":"2026-11-10T09:37:36.137Z","kind":"answer","tool":"remember",
 "question":"where are invoices stored","keywords":["invoice","store","ingest"],
 "files":["src/invoice.js","src/service.js"],"nodes":["InvoiceStore"],
 "outcome":"useful","summary":"InvoiceStore keeps them in memory; ingest() parses and adds."}
```

Caps keep it bounded: 12 keywords per entry, 1 200 keywords in the index, 4 MB log with
automatic compaction.

## Settings (plugin)

| Key | Default | Effect |
|---|---|---|
| `trail` | `true` | Trail every settled tool call automatically |
| `autobuild` | `true` | Build a code-only graph on the first read instead of dead-ending |
| `autobuildFileLimit` | `4000` | Refuse the automatic build above this many files |
| `autobuildTimeoutMs` | `300000` | Deadline for that build |
| `bin` | auto | Path to the `graphify` executable |
| `captureDir` | OS temp | Where CLI output is captured |
| `historyHint` | `auto` | Mention session-history tools: `auto`, `always`, `never` |
| `tools` | all 15 | Allow-list, e.g. `[graphify_where, graphify_remember]` |

Set them in the profile patch, or through environment variables
(`DSH_GRAPHIFY_TRAIL=0`, `DSH_GRAPHIFY_AUTOBUILD=0`, `DSH_GRAPHIFY_BIN`,
`DSH_GRAPHIFY_CAPTURE_DIR`). Every key, recipe and cost table:
[docs/SETTINGS.md](docs/SETTINGS.md). The skill has no settings at all.

## Works with the graphify CLI, and without it

If [`graphify`](https://github.com/Graphify-Labs/graphify) is installed, layer 2 is its
graph — nodes from the trail are ideal seeds for `graphify query`. If it is not, layer 2
is a bounded grep and the structural tools say so instead of pretending. The memory
layer works either way.

## Automation

- `examples/claude-code-hooks.json` — a `PostToolUse` hook that trails every tool result.
- `examples/git-post-commit.sh` — records commit keywords, so decisions tied to a commit
  stay findable.

Without hooks the model records explicitly with `remember`; the skill instructs it to do
so after every answered question. In DSH the plugin does this on its own unless
`trail: false`.

## Honest limits

- **The trail only knows what was recorded.** A decision nobody wrote down is not in it.
  That is why recording after each answer is part of the procedure, and why the layer-4
  history search still exists.
- **The index is lexical, not semantic.** Prefix and stem matching, no embeddings. A
  question in completely different words may miss; recording good keywords is what
  prevents that.
- **It is a memory, not a graph.** Structural questions ("what calls this", "what breaks
  if I change it") belong to the graph layer.
- **Per project.** Memories do not merge across repositories.

## Русский, коротко

Плагин и скилл, которые заставляют проект помнить. После каждого ответа агент
записывает «след»: вопрос, 3–8 ключевых слов, файлы, узлы графа и вывод одной строкой.
Следующий вопрос решается одним дешёвым чтением (~230 токенов) вместо grep, чтения
файлов (1.5–2.5k за файл) или перечитывания истории. Переживает сжатие контекста, новые
сессии и смену модели — потому что это файл в проекте, а не состояние чата. Поиск идёт
слоями: журнал → граф/код → файлы → история как крайний случай.

Установка в терминале:

```bash
git clone https://github.com/Granit1846/cluster-memory.git ~/.claude/skills/cluster-memory
```

Установка в DSH прямо из GitHub — попросить агента:

> Установи бандл cluster-memory из github:Granit1846/cluster-memory

или в интерфейсе: **Плагины** → **Add plugin** → `github:Granit1846/cluster-memory`.
Настройки — в [docs/SETTINGS.md](docs/SETTINGS.md), подробности установки — в
[docs/INSTALL.md](docs/INSTALL.md).

## Documentation

| File | Contents |
|---|---|
| [docs/INSTALL.md](docs/INSTALL.md) | Per-agent install, DSH from GitHub, hooks, troubleshooting |
| [docs/SETTINGS.md](docs/SETTINGS.md) | Every plugin setting, env var, recipe and cost |
| [docs/COMPARISON.md](docs/COMPARISON.md) | Measured costs against graph-only and history-only search |
| [SKILL.md](SKILL.md) | The agent-facing procedure |

## License

MIT — see [LICENSE](LICENSE).
