# Lifecycle ship to main (harness-config lane)

Shared close-out for `oc-updating-harness` and `oc-configuring-model-routing`.
**Default: always ship** after a successful lifecycle write that dirties the tree.
Skip only when (a) working tree is clean for harness paths, or (b) the operator said not to ship.

Goal: same session ends with **PR squash-merged on `main`** — operator must not open a second session just to commit/PR.

## Rules

- Never commit on `main`/`master` directly — branch → selective stage → commit → push → PR → squash merge → return to main.
- Never `git add -A` / `git add .`. Stage only harness lifecycle paths.
- Never stage secrets: `.env*`, `.dev.vars`, `*.pem`, `*.key`, credentials.
- Never force-push. Never `--no-verify`.
- No `Co-Authored-By` trailer.
- Interactive lane only (already enforced by `harness-config`).
- After merge: **session restart is mandatory** (agents/plugins load at boot).

## Procedure (each command = its own bash call)

### 1. Inspect

```bash
git status --short
```

```bash
git branch --show-current
```

```bash
git diff --stat
```

If nothing to ship under harness paths → report and stop (still demand restart if files on disk already match the new config from this session).

### 2. Branch off main when needed

If current branch is `main` or `master`:

```bash
git switch -c chore/harness-lifecycle
```

If already on another branch that only carries this lifecycle work, keep it.
If `chore/harness-lifecycle` already exists and is wrong, use:

```bash
git switch -c chore/harness-routing
```

(or `chore/harness-update` for an update-only run).

### 3. Selective stage

Stage only what this operation changed. Typical sets:

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

**configuring-model-routing (vendored project):**

```bash
git add .opencode
```

```bash
git add opencode.json
```

**configuring-model-routing / source repo (`core/opencode`):**

```bash
git add core/opencode
```

```bash
git add opencode.json
```

Skip any path that does not exist or did not change. Never stage unrelated project files.

### 4. Commit

One-line Conventional Commit (pt-br description). Pick the matching message:

```bash
git commit -m "chore: sincroniza harness vendored"
```

```bash
git commit -m "chore: reconfigura model routing do harness"
```

If commit says nothing to commit → continue only if remote already has the change; otherwise stop.

### 5. Push + PR + merge

```bash
git push -u origin HEAD
```

```bash
gh pr create --title "chore: lifecycle harness" --body "Lifecycle do harness (update e/ou model routing). Sem ceremony de delivery — lane harness-config."
```

Prefer a concrete title when you know which op ran (`chore: sincroniza harness vendored` / `chore: reconfigura model routing`).

```bash
gh pr checks --watch
```

If checks are absent or the repo has none, continue. If a required check fails, stop and give the operator the PR URL — do not merge red CI.

```bash
gh pr merge --squash --delete-branch
```

If merge is blocked (review required, ruleset), stop with the PR URL and what the operator must click. Do not force.

### 6. Sync local main

```bash
git switch main
```

```bash
git pull --ff-only
```

### 7. Close (operator language)

- One line: what landed on main (version and/or routing map).
- PR URL.
- **Reinicie a sessão OpenCode agora** — agents/plugins da versão/config nova só carregam no boot.
