# Settings

Two surfaces, two answers:

- **The skill** (`scripts/cluster-memory.mjs`) has no configuration. It stores its
  trail in `.cluster-memory/` next to the project and takes only `--cwd`.
- **The DSH plugin** is configurable, because it also decides *when* a graph is built
  and which tools it exposes to the model.

Everything below applies to the plugin only.

## Resolution order

```
profile config (cordis.patch.yml)  >  environment  >  built-in default
```

Settings are resolved once when the plugin is applied, so a change takes effect after
a DSH restart, not mid-session.

## Keys

| Key | Type | Default | Environment | Effect |
|---|---|---|---|---|
| `trail` | boolean | `true` | `DSH_GRAPHIFY_TRAIL=0` turns it off | Records a keyword trail for every settled tool call (files, nodes, one-line summary). With `false` only an explicit `graphify_remember` writes anything. |
| `autobuild` | boolean | `true` | `DSH_GRAPHIFY_AUTOBUILD=0` | When a read tool (`query`, `where`, `status`, `report`) finds no graph, build a code-only graph first instead of dead-ending on "No graph found". Only inside the session workspace. |
| `autobuildFileLimit` | integer | `4000` | — | Above this many project files the automatic build is refused (`node_modules`, `.git`, `dist`, `build`, `vendor`, caches and hidden directories are not counted). |
| `autobuildTimeoutMs` | integer | `300000` | — | Deadline for the automatic build (5 minutes). A tool call that passes its own `timeoutMs` wins. |
| `captureDir` | path | OS temp directory | `DSH_GRAPHIFY_CAPTURE_DIR` | Where CLI output is captured. Set it when the temp directory is small, on a slow disk, or inside a sandbox that dislikes `%TEMP%`. |
| `bin` | path | auto-detected | `DSH_GRAPHIFY_BIN`, or `GRAPHIFY_BIN` | Explicit path to the `graphify` executable, for a virtualenv PATH that DSH does not see. |
| `historyHint` | `auto` \| `always` \| `never` | `auto` | — | Whether answers mention session-history tools. `auto` mentions them only when the session-search bundle is installed; `never` keeps the hint layer 1–3 only. |
| `tools` | string[] | all 15 | — | Allow-list of tool names to register, for a narrower (cheaper) surface. |

### Cost of the tool surface

Every registered tool ships its schema on every request. Measured on this repo:

| Surface | Tools | Tokens per request |
|---|---|---|
| Default (all) | 15 | ≈ 5 800 |
| `where` + `remember` + `query` + `lessons` | 4 | ≈ 1 400 |
| `where` + `remember` | 2 | ≈ 950 |

A narrower surface is the biggest lever if the budget is tight; it costs you the
structural tools (`path`, `explain`, `affected`, `build`, `export`, `hook`).

## Where to set it

Profile patch — `~/.dsh/profiles/<profile>/cordis.patch.yml`, the entry that the
installer wrote:

```yaml
- insert:
    - id: tool-cluster-memory
      name: cluster-memory
      config:
        trail: true
        autobuild: true
        autobuildFileLimit: 4000
        autobuildTimeoutMs: 300000
        historyHint: auto
        # bin: C:\Users\you\.local\bin\graphify.exe
        # captureDir: D:\tmp
        # tools: [graphify_where, graphify_remember, graphify_query, graphify_lessons]
```

Restart DSH, then check what is in force:

```
graphify_doctor          # prints one line: settings: trail: on · autobuild: on up to 4000 files · ...
```

## Recipes

**Hands-off scope memory** — the default. Trail everything, build the graph on first
read, all tools.

**Explicit only** — the model decides what deserves remembering:

```yaml
trail: false
```

**No surprise builds** — the graph is built by `graphify_build` when asked:

```yaml
autobuild: false
```

**Big monorepo** — keep the automatic build, but only for small projects:

```yaml
autobuildFileLimit: 800
autobuildTimeoutMs: 120000
```

**Minimal surface** — cheapest, memory only:

```yaml
tools: [graphify_where, graphify_remember]
```

**Graphify in a virtualenv** that DSH's PATH misses:

```yaml
bin: C:\Users\you\venvs\graphify\Scripts\graphify.exe
```

## Environment variables

Useful when the same setting must apply to every profile, or when DSH is started from
a script:

| Variable | Meaning |
|---|---|
| `DSH_GRAPHIFY_TRAIL=0` | Same as `trail: false` |
| `DSH_GRAPHIFY_AUTOBUILD=0` | Same as `autobuild: false` |
| `DSH_GRAPHIFY_CAPTURE_DIR` | Same as `captureDir` |
| `DSH_GRAPHIFY_BIN` / `GRAPHIFY_BIN` | Same as `bin` |

Precedence again: a value in the profile config beats the environment, so an env var
cannot override a profile that sets the key explicitly. Booleans are read as
"`0` disables", which means `DSH_GRAPHIFY_TRAIL=1` changes nothing — it is already on.
