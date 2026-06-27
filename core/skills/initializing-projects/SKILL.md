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
- **`.github/ISSUE_TEMPLATE/harness-task.yml`** (repo root, non-clobber): the issue form that makes an issue harness-ready (auto-labels `harness:ready`). Feeds the issue-poll routine.

### Step 3 — Reconcile settings (only if `settings.harness.json` was written)
If the project already had a `settings.json`, the installer wrote `settings.harness.json` beside it.
Present the diff to the operator in product-language and merge the harness baseline into their config
(do not silently overwrite their permissions/hooks). Then delete `settings.harness.json`.

### Step 3b — Create the harness labels (for issue-driven routines)
The issue form auto-applies `harness:ready`, and the issue-poll routine uses these labels — they must exist in the repo. Create them (idempotent — ignore "already exists"):
```bash
gh label create "harness:ready"       -c "#0E8A16" -d "Pronta para a pipeline autônoma" 2>/dev/null || true
gh label create "harness:in-progress" -c "#FBCA04" -d "Routine processando" 2>/dev/null || true
gh label create "harness:done"        -c "#5319E7" -d "PR aberto pela routine" 2>/dev/null || true
```
Priority/size live in the issue body (form fields); the routine parses them when ranking.

### Step 4 — Optional add-ons (opt-in, per `modules/`)
Ask the operator (interactive) or read the routine prompt (headless) whether to enable:
- **RTK** (token savings) — follow `modules/rtk/`: install the binary and add the **fail-open** `PreToolUse` hook to `.claude/settings.json`. Recommended, but opt-in.
- **MV** (Mind Vault — curated mental models) — follow `modules/mv/`: connect per-user (connector or committed `.mcp.json`). Optional.

Never enable an add-on without explicit opt-in; never hardcode credentials.

### Step 4b — Generate project-specific CI workflow (NON-CLOBBER)

Once the harness is vendored into `.claude/`, generate a project-specific GitHub Actions CI workflow.
`generate-ci.mjs` calls `detect-stack` and `detect-secrets` internally — a single command handles the
full workflow.

```bash
# Generate .github/workflows/ci.yml (NON-CLOBBER — skips if file already exists)
node .claude/skills/initializing-projects/references/generate-ci.mjs \
  [--target <project-dir>] [--job-name <name>] [--node-version <version>]
```

For inspection without writing files, the sub-detectors can be run independently:

```bash
# Inspect detected stack only (prints JSON, no files written)
node .claude/skills/initializing-projects/references/detect-stack.mjs \
  [--target <project-dir>]

# Inspect detected secret names only (prints JSON with secrets[] + setupGuide)
node .claude/skills/initializing-projects/references/detect-secrets.mjs \
  [--target <project-dir>]
```

**Non-clobber guarantee:** `generate-ci.mjs` will NOT overwrite an existing `.github/workflows/ci.yml`.
If the file already exists, the CLI prints "Skipped (exists)" and exits 0 without modifying it.

**Secret setup guide:** After writing ci.yml, `generate-ci.mjs` prints the `gh secret set <NAME>`
commands for all detected secrets — the operator must run these before the workflow runs for the
first time.

**Stack skip:** If `detect-stack` returns `status: "skip"` (e.g. unrecognised runner), the CLI prints
the skip reason and writes nothing.

### Step 4c — Apply branch protection (RECOMMENDED where the bad-merge cost justifies it — workflow must land and run once first)

**When to apply (recommended, NOT mandatory):** branch-protection ENFORCEMENT (the GitHub rule that
blocks a merge until the check is green) is worth its friction only where the cost of a bad merge is
real — production users, deploys, or more than one committer. For a low-stakes or solo repo, the CI
signal alone (the ✅/❌ surfaced on each PR) is usually enough, and enforcement adds a footgun: a
drifted required-check name or a CI outage blocks ALL merges, and unblocking needs an `admin:repo`
token. Default: always generate the CI and surface the signal; apply `--apply` protection only where
the bad-merge cost justifies the friction. Never apply it autonomously.

**CRITICAL (when you do apply):** Branch protection can only be applied AFTER the CI workflow has been
deployed to GitHub and has run successfully at least once. A required status-check context cannot exist
before the job runs.

Once the workflow is live and has passed a pull request:

```bash
# DRY-RUN (default — no network calls, prints the payload that WOULD be PUT)
node .claude/skills/initializing-projects/references/branch-protection.mjs \
  --repo <owner/repo> --branch main \
  --required-context <jobName>

# APPLY (operator-gated — performs the actual PUT; requires admin:repo token)
node .claude/skills/initializing-projects/references/branch-protection.mjs \
  --repo <owner/repo> --branch main \
  --required-context <jobName> \
  --apply
```

**Default is DRY-RUN:** without `--apply`, the CLI prints the payload that WOULD be PUT and exits 0
without making any network call. The autonomous pipeline NEVER runs with `--apply` — that flag is
operator-gated.

**When no admin token is present:** the CLI returns `{ applied: false, reason: "..." }` — this is NOT
a failure. Report to the operator: "Branch protection not applied — provide a token with `admin:repo`
scope to apply branch protection." The pipeline continues; branch protection becomes a human follow-up
step.

**Safety:** The branch-protection module uses GET-then-merge to preserve existing protection rules
and only adds the new required status-check context (avoiding clobber).

### Step 5 — Report
Report in pt-br, product-language: what was installed, the harness version, whether settings needed a
manual merge, and which add-ons were enabled. Include CI generation status (generated, skipped, or failed)
and branch protection status (applied, not applied due to missing token, or failed). Suggest committing
`.claude/` (so cloud routines see it), and — for an existing codebase with cold memory — running
`surveying-codebase` to seed `.claude/memory/`.

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
