# Lifecycle ship to main (harness-config lane)

Shared close-out for `oc-updating-harness` and `oc-configuring-model-routing`.
**Default: always ship** the lifecycle result in this same session. Restart only happens *after*
the PR is squash-merged on the default branch.

Goal: the operator never needs a second session to turn a completed lifecycle change into a merged
PR. A restart may load a newer skill, but it must not make an already-created lifecycle commit invisible.

## Non-negotiable boundary

- The only cargo is the fixed vendor ownership set: harness framework trees, their version/config
  manifests, root `AGENTS.md`, `opencode.json`, and the two harness-installed repo templates.
- Product work may be dirty or already staged. Leave it exactly as it is; it is **not** a reason to
  stop and it must never enter this commit.
- Plans, `.state`, local plugins, secrets, and every other `.opencode`/`.claude` file outside the
  ownership set are never lifecycle cargo.
- Never force-push, use `--no-verify`, or merge with `--admin`.

## Procedure (each command = its own bash call)

### 1. Recover or prepare the isolated lifecycle commit

Run exactly one matching command. It fetches the default branch, then does one of three things:

- `resume`: finds an **already-created lifecycle commit** ahead of `origin/main`/`origin/master`,
  verifies that every changed path belongs to the ownership set, and keeps its current branch.
- `committed`: starts from the updated default branch, stages only changed owned paths, and makes a
  lifecycle-only commit with `git commit --only` so unrelated staged product work cannot leak in.
- `noop`: no lifecycle change exists; report that result and stop.

The matching `snapshot` command must already have run immediately before the lifecycle write. It
records unrelated product paths but rejects a pre-existing tracked change to a vendor-owned file;
that is the boundary which prevents a local plugin or a manual harness edit from being republished.

**updating-harness:**

```bash
node .opencode/tools/lifecycle-ship.mjs prepare updating-harness
```

**configuring-model-routing:**

```bash
node .opencode/tools/lifecycle-ship.mjs prepare configuring-model-routing
```

If it reports an ownership error, a switch/pull conflict, or an existing branch that also contains
product paths: stop and report that precise reason. Do not recover it with a broad `git add`, stash,
reset, or a branch from a product commit.

### 2. Push + PR + merge

```bash
git push -u origin HEAD
```

```bash
gh pr create --title "chore: lifecycle harness" --body "Lifecycle do harness (update e/ou model routing). Sem ceremony de delivery — lane harness-config."
```

Prefer a concrete title when known (`chore: sincroniza harness vendored` or
`chore: reconfigura model routing do harness`).

```bash
gh pr view --json url,baseRefName,headRefName
```

Confirm `baseRefName` is the default (`main` or `master`). Otherwise stop; do not merge.

```bash
gh pr checks --watch
```

Continue only with at least one completed `SUCCESS` or `NEUTRAL` check. If checks are absent,
pending, failing, unknown, or GitHub cannot be read, stop with the PR URL.

```bash
gh pr merge --squash --delete-branch
```

If GitHub blocks merge (review/ruleset), stop with the URL and the precise action needed. Do not force.

### 3. Sync and close

```bash
git switch main
```

(or `git switch master`.)

```bash
git pull --ff-only
```

Tell the operator in one line what landed, give the PR URL, and require a session restart.
