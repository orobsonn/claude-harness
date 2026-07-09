---
name: reaper-multi-repo-gh-scoping
description: The multi-repo fleet reaper resolves gh scope through TWO distinct seams per project — a test that only exercises one proves nothing about the other. Two related latent gaps documented for future touches.
metadata:
  type: project
---

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
- `crashRecover`'s `harness:in-review` guard (`reaper.mjs`) reads `opts.issueLabels`, but
  `runReaper` (`run-reaper.mjs`) never wires an `issueLabels` seam — it always resolves to `[]`. This
  is a **pre-existing latent gap** (confirmed via `git show HEAD:core/vps/run-reaper.mjs | grep
  issueLabels` → no match), not introduced by #117. A future fix needs to construct an `issueLabels`
  probe (scoped per-project like the others) and pass it through `runReaper`'s options into `reaper()`.
- `reaper.mjs`'s `holderMissing` branch (bare `gitWorktreeRemove` + `gitBranchDelete`, no gh probe at
  all) is **dead in production**: it only fires on the explicit `holder == null && lockDirAgeSeconds ==
  null` guard, and `run-reaper.mjs`'s `listWorktreesSeam` never supplies a `lockDirAgeSeconds` callback
  to `list-worktrees.mjs`, so a null holder always has `lockDirAgeSeconds === null` too and routes to
  the completed-sweep path instead. Any adversary/security finding whose blast-radius depends on
  `holderMissing` firing in production is refutable on that basis alone — verify `listWorktreesSeam`
  wires `lockDirAgeSeconds` before treating such a finding as live.
- Separately, `list-worktrees.mjs`'s `for (const project of projects)` has no `Array.isArray` guard —
  an absent/empty `config.projects` throws OUTSIDE `reaper.mjs`'s per-worktree try/catch and crashes
  the whole shared reaper run. This is a known, deliberately out-of-scope gap (an absent
  `config.projects` was declared out of scope for #117); a future fix touching `list-worktrees.mjs`
  should add the guard rather than assume every caller pre-validates `projects[]`.
