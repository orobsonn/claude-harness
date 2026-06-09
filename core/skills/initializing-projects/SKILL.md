---
name: initializing-projects
description: "Installs (vendors) the Claude Harness core into a project's .claude/ so the pipeline works locally and in cloud routines. Resolves the source portably (local path or git URL), copies agents/skills/rules/CLAUDE.md/settings.json, seeds repo-relative memory, stamps .harness-version, and merges idempotently so re-running updates without clobbering project content. Use to onboard a project or to update its vendored harness."
---

# Initializing-Projects — Vendor the harness core into a project

**This skill installs the framework into a target project.** It copies the source `core/` into the
project's `.claude/` (the only place cloud routines can see), so the pipeline runs both locally and
headless. It does not plan, implement, or review.

**Announce at start (pt-br):** "Instalando o Claude Harness no `.claude/` do projeto."

All identifiers and reasoning stay in English; every message to the operator is **pt-br, product-language**.

---

## Source resolution (portable — option b)

The source of truth is the **claude-harness repo** (this framework). The installer resolves it
portably, so it works on any machine and forward-fits a future plugin/marketplace:

- **git URL (default, portable):** the installer shallow-clones the repo, optionally at a `--ref`
  (tag/branch), and vendors `core/` from the clone. This is the recommended path.
- **local path (dev / offline):** pass a local clone path that contains `core/`. Used in place, no clone.

The `.harness-version` written into the project records the source version (`git describe`), so a
later re-run can update deliberately.

---

## Pipeline

### Step 1 — Confirm target and source
- **Target:** the project root to onboard (default: current directory). Confirm with the operator.
- **Source:** the claude-harness git URL (preferred) or a local clone path. If the operator has not
  configured a URL yet (the repo may be unpublished), use a local clone path.

### Step 2 — Run the vendoring installer
Run the deterministic installer (Node builtins only, no install needed):

```bash
node .claude/skills/initializing-projects/references/vendor-core.mjs \
  --source <git-url-or-local-path> [--ref <tag>] [--target <project-dir>]
```

It performs, **idempotently**:
- **framework-owned (overwritten):** `agents/`, `skills/`, `rules/`, `CLAUDE-HARNESS-MEMORY-MODEL.md`.
- **accumulated (seeded only if absent — never clobbered):** `.claude/memory/MEMORY.md`, `.claude/kaizen.md`.
- **`.claude/CLAUDE.md`:** the harness entry-policy merged **between `<!-- harness:start -->` / `<!-- harness:end -->` markers**; any project-specific content outside the markers is preserved. Re-running replaces only the managed block.
- **`.claude/settings.json`:** copied if absent; if one already exists, written as `settings.harness.json` for the operator to merge (never clobbered).
- **`.claude/.gitignore`:** ignores ephemerals (`plans/`, `settings.local.json`, `*.local.md`) — keeps `memory/` and `kaizen.md` committed.
- **`.claude/.harness-version`:** the vendored version + timestamp.

### Step 3 — Reconcile settings (only if `settings.harness.json` was written)
If the project already had a `settings.json`, the installer wrote `settings.harness.json` beside it.
Present the diff to the operator in product-language and merge the harness baseline into their config
(do not silently overwrite their permissions/hooks). Then delete `settings.harness.json`.

### Step 4 — Optional add-ons (opt-in, per `modules/`)
Ask the operator (interactive) or read the routine prompt (headless) whether to enable:
- **RTK** (token savings) — follow `modules/rtk/`: install the binary and add the **fail-open** `PreToolUse` hook to `.claude/settings.json`. Recommended, but opt-in.
- **MV** (Mind Vault — curated mental models) — follow `modules/mv/`: connect per-user (connector or committed `.mcp.json`). Optional.

Never enable an add-on without explicit opt-in; never hardcode credentials.

### Step 5 — Report
Report in pt-br, product-language: what was installed, the harness version, whether settings needed a
manual merge, and which add-ons were enabled. Suggest committing `.claude/` (so cloud routines see it),
and — for an existing codebase with cold memory — running `surveying-codebase` to seed `.claude/memory/`.

---

## Idempotency contract

Re-running the installer **updates** a project safely:
- Framework files are refreshed to the new version.
- The operator's accumulated memory (`.claude/memory/`), kaizen outbox, and project-specific `CLAUDE.md`
  content (outside the markers) and `settings.json` are **never** overwritten.
- `.harness-version` reflects the new source version.

---

## Anti-patterns

- **Copying outside `.claude/`** — the harness lives under `.claude/` (agents/rules must be at its top for cloud discovery). Do not scatter files into the repo root.
- **Clobbering project state** — never overwrite an existing `settings.json`, `memory/`, `kaizen.md`, or project content in `CLAUDE.md`. The marker merge and settings-merge step exist precisely to avoid this.
- **Hardcoding the source path** — resolve the source via `--source` (git URL preferred); do not bake a machine-specific path into the skill.
- **Enabling add-ons by default** — RTK and MV are opt-in. The core must work with neither.
- **Vendoring a stale agent/skill set** — the source `core/` is the single truth; do not hand-edit vendored copies in a project (changes belong in the framework source, promoted via kaizen).
