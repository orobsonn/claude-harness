# Lifecycle ship to main (model-routing only)

Shared close-out for `oc-configuring-model-routing`. Harness update owns its own isolated published
CLI operation; do not combine these flows.

**Default: always ship** the routing result in the same session. The lifecycle helper makes an exact,
lifecycle-only commit; product work may be dirty or staged and must remain byte-for-byte untouched.

## Non-negotiable boundary

- The only cargo is the fixed routing ownership set: its config, manifests, and the harness files the
  routing engine changed.
- Product work, plans, `.state`, local plugins, secrets, and every other file outside that set are not
  lifecycle cargo.
- Never broad-stage, force-push, use `--no-verify`, or merge with `--admin`.

## Procedure

The routing skill already captured its baseline. Run its matching helper once; it stages exact owned
paths and creates its commit with `git commit --only`:

```bash
node .opencode/tools/lifecycle-ship.mjs prepare configuring-model-routing
```

- `committed`: continue below.
- `resume`: the helper found an already-created, verified lifecycle-only commit; continue below.
- `noop`: report and stop.
- `merged`: the helper completed its narrow compatibility path; report and stop.
- ownership, branch, or conflict error: report the exact reason and stop. Never recover with stash,
  reset, broad staging, or a branch from product work.

Push and create the PR:

```bash
git push -u origin HEAD
```

```bash
gh pr create --title "chore: reconfigura model routing do harness" --body "Lifecycle do harness. Sem delivery de produto."
```

Verify its base, wait for checks, and merge only normally:

```bash
gh pr view --json url,baseRefName,headRefName
```

The base must be `main` or `master`. Then:

```bash
gh pr checks --watch
```

If checks are pending, failed, unknown, or cannot be read, stop with the PR URL. If no checks are
reported, continue: this remains a lifecycle sync and GitHub branch rules remain authoritative.

```bash
gh pr merge --squash --delete-branch
```

```bash
git switch main
```

or `git switch master`, then:

```bash
git pull --ff-only
```

Report the merged PR and require an OpenCode session restart.
