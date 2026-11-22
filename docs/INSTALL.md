# Install

Cluster Memory is one package with two surfaces:

| Surface | What you get | Needs |
|---|---|---|
| **Skill** | The layered-search procedure in your agent, plus the `cluster-memory` CLI | Node 20+ |
| **DSH plugin** | 15 tools (`graphify_where`, `graphify_remember`, `graphify_query`, …), automatic trailing, automatic first build | Node 20+, DSH 0.2.0-rc.1 or newer |

Both read and write the same kind of trail. Install either one; install both if you
use DSH *and* another agent.

Version 1.2.0 · MIT.

---

## A. Skill (any agent, terminal)

Clone once into the directory your agent loads skills from.

```bash
git clone https://github.com/Granit1846/cluster-memory.git ~/.claude/skills/cluster-memory
```

PowerShell:

```powershell
git clone https://github.com/Granit1846/cluster-memory.git "$env:USERPROFILE\.claude\skills\cluster-memory"
```

| Agent | Clone target |
|---|---|
| Claude Code | `~/.claude/skills/cluster-memory` (project-local: `.claude/skills/cluster-memory`) |
| Codex | `~/.codex/skills/cluster-memory` |
| Cursor | clone anywhere, copy `SKILL.md` to `.cursor/rules/cluster-memory.mdc` |
| Gemini CLI | clone anywhere, add `@cluster-memory/SKILL.md` to `GEMINI.md` |
| Anything with a shell | clone anywhere and run the script; the skill text is optional |

Verify the script works — it prints an empty store, not an error:

```bash
node ~/.claude/skills/cluster-memory/scripts/cluster-memory.mjs summary
```

Update: `git -C ~/.claude/skills/cluster-memory pull`. Uninstall: delete the directory
and, per project, `.cluster-memory/`.

Nothing else is required: no config file, no daemon, no model call. The store appears
in a project the first time something is recorded.

On DSH use the plugin below instead: it registers the same skill from memory, so do not
also copy `SKILL.md` into `~/.dsh/skills`.

---

## B. DSH plugin, straight from GitHub

The repository root is a DSH bundle, so a bare git spec is enough — no build step, no
npm publish, no clone.

### B1. From a terminal (`dsh plugin`)

If `dsh` is on your PATH (npm/global install, or `npx @deepseek-ai/dsh`), the CLI manages a
profile's packages directly — everything after its own flags is forwarded to pnpm inside
`$DSH_HOME/profiles/<name>`:

```bash
dsh plugin --profile web add github:Granit1846/cluster-memory
```

This is the same operation the plugin manager performs: after pnpm succeeds, DSH reconciles
the profile and appends any newly installed dependency that declares `dsh.bundle.patch` to
`dsh.profile.bundles`, so the bundle activates on the next boot of that profile. A profile
that does not exist yet is initialized from its template first
(`dsh: initialized profile web at …`).

Other pnpm verbs pass through unchanged:

```bash
dsh plugin --profile web why cluster-memory      # who depends on it
dsh plugin --profile web remove cluster-memory   # uninstall
dsh plugin --profile web list                    # everything in the profile
```

DSH intercepts only the compatibility subcommands:

```bash
dsh plugin --profile web version-exemptions
dsh plugin --profile web allow-version cluster-memory@1.2.0 --dsh-version 0.2.2-rc.5 --accept-risk
dsh plugin --profile web revoke-version cluster-memory@1.2.0 --dsh-version 0.2.2-rc.5
```

Three limits are worth knowing:

- **`--profile desktop` is refused** — `error: profile "desktop" is managed exclusively by
  the Electron application`. Use **Plugins** or `plugin_manager` (B2/B3) for the Desktop app.
- **Git-hosted specs build on install** through their `prepare` script, which pnpm blocks
  until allowed: add the exact key pnpm prints under `allowBuilds` in the profile's
  `pnpm-workspace.yaml`, then re-run.
- **Changes land on the next boot** of that profile; nothing hot-reloads into a running app.

The Desktop installer ships this CLI inside `app.asar` and does not put `dsh` on PATH, which
is why the routes below are the normal ones on Desktop.

### B2. From a DSH session

Ask the agent:

> Install the cluster-memory bundle from github:Granit1846/cluster-memory

It runs, with approval:

```
plugin_manager
  action: install_bundle
  target: github:Granit1846/cluster-memory
```

Accepted target forms:

| Target | Meaning |
|---|---|
| `github:Granit1846/cluster-memory` | GitHub repo, default branch |
| `https://github.com/Granit1846/cluster-memory.git` | any git URL |
| `link:C:\Users\you\src\cluster-memory` | a local checkout, kept in sync by you (this is how to pin a commit) |
| `cluster-memory` | npm registry name, once published there |

DSH pre-checks the repository with `git ls-remote`, then installs the package into the
current profile and adds the bundle row. Without hot reload the result is
`application: restart-required` — restart DSH, then open a new session.

### B3. From the GUI

**Plugins** → **Add plugin** → paste `github:Granit1846/cluster-memory` → install →
restart when asked.

### B4. Verify

```
graphify_doctor
```

Expect, among other lines:

```
  settings: trail: on · autobuild: on up to 4000 files · history hint: auto · bin: auto-detected · capture dir: OS temp · tools: all
```

If the CLI is missing it says so and the memory features still work — the graph tools
report an honest "graphify is not installed" instead of failing.

The 15 tools, the `cluster-memory` skill, automatic trailing and automatic first
build are all in that one bundle. Settings: [SETTINGS.md](SETTINGS.md).

### B5. Update and remove

```
plugin_manager  action: list_bundles                       # current rows and specs
plugin_manager  action: install_bundle  target: github:Granit1846/cluster-memory   # update
plugin_manager  action: set_bundle  target: cluster-memory  enabled: false          # disable, keep files
plugin_manager  action: remove_bundle  target: cluster-memory                       # remove
```

Each change is profile-wide and needs a restart to take effect. From a terminal, the same
jobs are `dsh plugin --profile <name> add|remove <spec>` (see B1).

---

## C. Optional: automatic trailing with hooks

Without hooks the model records with `remember`/`graphify_remember` after it answers.
With hooks the trail fills itself.

**Claude Code** — merge `examples/claude-code-hooks.json` into
`.claude/settings.json`; it pipes every tool result to `record --stdin`.

**Git** — `examples/git-post-commit.sh` as `.git/hooks/post-commit` records the commit
message keywords, so decisions tied to a commit stay findable:

```bash
cp examples/git-post-commit.sh .git/hooks/post-commit && chmod +x .git/hooks/post-commit
```

Hooks are additive and failure-tolerant: if the store cannot be written, the hook stays
quiet and the agent is unaffected.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Unknown command` from the script | You are on an older copy — `git pull`. |
| `spawn EPERM` in a sandboxed shell | The host forbids piped child processes; the plugin captures CLI output through temp files instead. In the skill, run commands in-process (`main([...])`) or outside the sandbox. |
| Plugin installed, tools absent | Restart DSH, then check the row in **Plugins**. If the row is there but tools are not, your agent preset's tool policy may exclude them. |
| `graphify is not installed` | The graph layer is optional. `where`, `remember` and `lessons` work without it. Install it with `pip install graphifyy` for the structural tools. |
| Graph built for the wrong directory | The automatic build only runs inside the session workspace; use `graphify_build` with an explicit `path` for anything else. |
| Trail stays empty in DSH | `trail: false` in the profile config, or `DSH_GRAPHIFY_TRAIL=0` in the environment — see [SETTINGS.md](SETTINGS.md). |
| Numbers in `where` look stale | `rebuild` regenerates the index from the log; the log itself is append-only. |
