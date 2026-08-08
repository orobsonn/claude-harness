# Lifecycle ship to main (harness-config lane)

Shared close-out for `oc-updating-harness` and `oc-configuring-model-routing`.
**Default: always ship** after a successful lifecycle write that dirties the tree.
Skip only when (a) working tree is clean for harness paths, or (b) the operator said not to ship.

Goal: same session ends with **PR squash-merged on `main`** — operator must not open a second session just to commit/PR.

## Rules

- **Always create the chore branch from the updated default-branch tip** (`main` or `master`). Never create it from a product feature branch tip — product commits would ride the squash PR.
- Carry **uncommitted** lifecycle edits onto the default branch with `git switch <default>` (Git keeps the dirty worktree when paths do not conflict). Then `git switch -c chore/…`.
- Never commit on the default branch directly.
- Never `git add -A` / `git add .`. Stage only harness lifecycle paths, one path per `git add` call.
- Never stage secrets: `.env*`, `.dev.vars`, `*.pem`, `*.key`, credentials.
- Never stage runtime ephemera: `.opencode/plans/**`, `.opencode/**/.state/**`, `.claude/plans/**` if present.
- Never force-push. Never `--no-verify`. Never `gh pr merge --admin`.
- No `Co-Authored-By` trailer.
- Interactive lane only (already enforced by `harness-config`).
- After merge: **session restart is mandatory** (agents/plugins load at boot).

## Preconditions (fail closed)

```bash
git status --short
```

```bash
git branch --show-current
```

```bash
git diff --stat
```

1. If nothing dirty under harness paths → report and stop (still demand restart if this session already wrote config on disk).
2. If `git status --short` shows **any path outside** the lifecycle allowlist below → **stop**. Tell the operator in pt-br to finish/stash product work (or open a clean session) and re-run. Do not ship a mixed tree.
3. If status shows `.opencode/plans`, any `.state/`, or other run-ephemeral paths → **stop**. Those are not lifecycle ship cargo.
4. If entry-gate / host later denies push/PR because a delivery is mid-flight on this session → stop with that reason; do not reshape commands. Operator opens a clean session or finishes delivery first.

Lifecycle paths only (stage subset of these, and only if changed):

- `.opencode` (framework trees only — never `plans/` / `.state/`)
- `.claude` (framework trees only — never plans/state if present)
- `opencode.json`
- `AGENTS.md` (project **root** — `vendor-core` merges harness markers here)
- `harness.routing.json` (rare root copy)
- `core/opencode` (harness **source** repo only)

## Procedure (each command = its own bash call)

### 1. Default-branch tip + chore branch

```bash
git fetch origin
```

```bash
git rev-parse --abbrev-ref origin/HEAD
```

Use the result (`origin/main` → `main`, or `origin/master` → `master`) as `<default>` below.

Move the uncommitted lifecycle worktree onto the default branch (does **not** bring product commits from a feature branch — only dirty files travel):

```bash
git switch main
```

(or `git switch master` when that is the default)

If switch refuses (local changes would be overwritten) → **stop**. Operator must clear the conflict; do not force, do not branch from the feature tip.

```bash
git pull --ff-only
```

If pull fails with local changes → **stop** and report (do not rebase product history).

Confirm you are on the default branch with lifecycle-only dirty files, then:

```bash
git switch -c chore/harness-lifecycle
```

If that name already exists locally:

```bash
git switch -c chore/harness-update
```

```bash
git switch -c chore/harness-routing
```

**Never** run `git switch -c chore/…` while still on a product feature branch.

### 2. Selective stage (one path per call)

Stage only what this operation changed:

**updating-harness (vendored project):**

```bash
git add .opencode
```

```bash
git add .claude
```

```bash
git add opencode.json
```

```bash
git add AGENTS.md
```

**configuring-model-routing (vendored project):**

```bash
git add .opencode
```

```bash
git add opencode.json
```

```bash
git add AGENTS.md
```

**source repo (`core/opencode`):**

```bash
git add core/opencode
```

```bash
git add opencode.json
```

```bash
git add AGENTS.md
```

Skip any path that does not exist or did not change. Never multi-path `git add`. Never stage unrelated project files. Precondition 3 already refused ephemeral plans/state — if `git status` after add shows them staged, unstage is not allowlisted → **stop** and report.

### 3. Commit

One-line Conventional Commit (pt-br description). Pick the matching message:

```bash
git commit -m "chore: sincroniza harness vendored"
```

```bash
git commit -m "chore: reconfigura model routing do harness"
```

If commit says nothing to commit → continue only if remote already has the change; otherwise stop.

### 4. Push + PR + merge

```bash
git push -u origin HEAD
```

```bash
gh pr create --title "chore: lifecycle harness" --body "Lifecycle do harness (update e/ou model routing). Sem ceremony de delivery — lane harness-config."
```

Prefer a concrete title when you know which op ran (`chore: sincroniza harness vendored` / `chore: reconfigura model routing`).

```bash
gh pr view --json url,baseRefName,headRefName
```

Confirm `baseRefName` is the repo default (`main` or `master`). If base is a feature branch → **stop**, do not merge.

```bash
gh pr checks --watch
```

If checks are absent or the repo has none, continue. If a required check fails, stop and give the operator the PR URL — do not merge red CI.

```bash
gh pr merge --squash --delete-branch
```

If merge is blocked (review required, ruleset), stop with the PR URL and what the operator must click. Do not force. Do not pass `--admin`.

### 5. Sync local default branch

```bash
git switch main
```

(or `git switch master`)

```bash
git pull --ff-only
```

### 6. Close (operator language)

- One line: what landed on main (version and/or routing map).
- PR URL.
- **Reinicie a sessão OpenCode agora** — agents/plugins da versão/config nova só carregam no boot.
