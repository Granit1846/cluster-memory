# Changelog

All notable changes to this project. Format: [Keep a Changelog](https://keepachangelog.com/),
versioning: [SemVer](https://semver.org/).

## 1.2.0 — 2026-11-22

One package, two surfaces.

### Added

- **Plugin settings**: `trail`, `autobuild`, `autobuildFileLimit`, `autobuildTimeoutMs`,
  `captureDir`, `bin`, `historyHint`, `tools`. Resolution order is profile config →
  environment → default; `graphify_doctor` prints what is in force on one line.
- `docs/SETTINGS.md` (every key, env var, recipe, tool-surface cost) and
  `docs/INSTALL.md` (per-agent install, DSH from GitHub, hooks, troubleshooting).
- Automatic first build: a read tool that finds no graph builds a code-only one instead
  of dead-ending, bounded by file count, deadline and the session workspace.

### Changed

- The repository root is now the DSH bundle, so `github:Granit1846/cluster-memory`
  installs without cloning, and the same clone is the skill. The former `plugin/`
  subdirectory is gone.
- Bundled skill renamed to `cluster-memory`.
- `where` merges the plugin trail (`graphify-out/trail/`) with the skill store
  (`.cluster-memory/`).
- Conclusion lookup in `where` now matches stems like the keyword index does, so
  "invoices" finds a conclusion filed under "invoice".

## 1.1.0 — 2026-11-21

### Added

- Keyword trail: every settled tool call leaves question, keywords, files, nodes and a
  one-line summary in `.cluster-memory/` (skill) or `graphify-out/trail/` (plugin).
- Memory tools: `graphify_where`, `graphify_remember`, `graphify_lessons`.
- Bundled skill that states the layered order of search (trail → graph → files →
  history).
- Layered fallback hints: an empty trail names the next layer, and session-history tools
  are mentioned only when the profile actually has them.

## 1.0.0 — 2026-11-20

### Added

- DSH bundle wrapping the `graphify` CLI: `graphify_doctor`, `graphify_build`,
  `graphify_update`, `graphify_status`, `graphify_query`, `graphify_path`,
  `graphify_explain`, `graphify_affected`, `graphify_report`, `graphify_export`,
  `graphify_add`, `graphify_hook`.
- Output capture through temporary files, so a sandbox that refuses piped child stdio
  still works; tree-kill on timeout; bounded capture.
- The dependency-free `cluster-memory` CLI with the same trail format.
