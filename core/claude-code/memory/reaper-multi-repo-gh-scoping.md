---
name: reaper-multi-repo-gh-scoping
description: "[RETIRED ENGINE] From the retired VPS fleet reaper (deleted in #807): one concern resolved through TWO structurally different gh seams with DIFFERENT fail-mode contracts — a test exercising one proves nothing about the other. The seam-pair trap generalizes; the modules named here no longer exist."
metadata:
  type: project
---

> **[RETIRED ENGINE] — historical.** `run-reaper.mjs`, `reaper.mjs`, `list-worktrees.mjs` and
> `gh-exec.mjs` were deleted with the VPS cron engine (#807 / PR #830, see
> `docs/vps-retirement.md`). None of the paths below resolve today — do not go looking for them. What
> carries over is the review rule: when ONE concern is resolved through TWO seams with different
> fail-mode contracts, each needs its own assertion, and the seam that cannot distinguish "empty"
> from "could not ask" may never gate a destructive action.

**Why:** `run-reaper.mjs` gained per-project `owner`/`repo` scoping (fleet-multi-repo, #117) via
`buildProjectRepoIndex` + `resolveRepoScope`, but it resolves that scope through **two structurally
different gh call paths**, not one:

- `prExists` and the crash-recovery relabel (`crashRecover`'s `gh issue edit`) go through the
  **normalized `scopedGh` seam** (`scopedGh(owner, repo, ghExec)`), which appends `--repo owner/repo`
  at the end of the args array.
- `issueClosed`, `prMerged`, and `prOpen` (the completed-worktree and orphan-topic sweeps) go through
  a **raw `spawnSync` seam** with an inline `["--repo", \`${owner}/${repo}\`, ...]`, deliberately NOT
  the normalized seam — `scopedGh`/`ghExec` returns `[]` on both a real gh error AND a genuine empty
  result, which is unsafe here: these probes must fail CLOSED (`null`, never `false`) on an outage so a
  transient gh failure can never authorize `git branch -D`.

A test (or a future adversary/compliance pass) that asserts `--repo` was passed on only ONE of these
two seams proves nothing about the other — they are separate call sites with separate fail-mode
contracts, not one shared helper.

**How to apply:**
- Any change to how the reaper resolves gh scope per project must add/verify assertions on **both**
  seams independently: `prExists`/relabel via `scopedGh`, and `issueClosed`/`prMerged`/`prOpen` via the
  raw `spawn` seam with the inline `--repo`.
- `crashRecover`'s `harness:in-review` guard (`reaper.mjs`) read `opts.issueLabels`, but
  `runReaper` (`run-reaper.mjs`) never wired an `issueLabels` seam — it always resolved to `[]`. This
  was a **pre-existing latent gap** (confirmed at the time via `git show HEAD:core/vps/run-reaper.mjs |
  grep issueLabels` → no match), not introduced by #117. A fix would have needed to construct an
  `issueLabels` probe (scoped per-project like the others) and pass it through `runReaper`'s options
  into `reaper()` — the shape of the fix, for the next time a similar seam goes unwired.
- `reaper.mjs`'s `holderMissing` branch (bare `gitWorktreeRemove` + `gitBranchDelete`, no gh probe at
  all) was **dead in production**: it only fired on the explicit `holder == null && lockDirAgeSeconds ==
  null` guard, and `run-reaper.mjs`'s `listWorktreesSeam` never supplied a `lockDirAgeSeconds` callback
  to `list-worktrees.mjs`, so a null holder always had `lockDirAgeSeconds === null` too and routed to
  the completed-sweep path instead. Any adversary/security finding whose blast-radius depended on
  `holderMissing` firing in production was refutable on that basis alone — the general lesson: verify
  a branch is actually reachable before treating a finding against it as live.
- Separately, `list-worktrees.mjs`'s `for (const project of projects)` had no `Array.isArray` guard —
  an absent/empty `config.projects` threw OUTSIDE `reaper.mjs`'s per-worktree try/catch and crashed
  the whole shared reaper run. This was a known, deliberately out-of-scope gap (an absent
  `config.projects` was declared out of scope for #117); the general lesson is not to assume every
  caller pre-validates an array-shaped config field.
