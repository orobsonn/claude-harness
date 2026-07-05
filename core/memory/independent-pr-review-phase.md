---
name: independent-pr-review-phase
description: Architecture of the independent PR-review phase (cron-review.mjs + run-cron-review.mjs) that replaces the editable-PR-body auto-merge verdict with a fresh, fail-closed, cross-family conjunction. spawnReviewSession is now LIVE (real claude -p actuator); breaker now-threading and the idempotency gap are fixed; open risks before enabling cross-family auto-merge are tracked below.
metadata:
  type: project
---

**Why:** Cron B's original auto-merge read the merge verdict from the PR body text
(`parseVerdictBlock(bodyText)`), which is editable by anyone with push access — an open auto-merge
spoofing vector. The `independent-pr-review` feature replaces that with an independent review phase:
a separate cron reads a fresh, out-of-band verdict artifact and only merges on the full conjunction of
checks. Anyone extending or debugging the review/merge path needs to know the module boundaries,
the conjunction, the label taxonomy, and — critically — that the phase does not yet run in production.

**How to apply:**

- **Composition root:** `run-cron-review.mjs` is the production entry point; `cron-review.mjs` is the
  pure per-PR review/route/merge logic it drives (parallel to `cron-a-dispatch.mjs` /
  `run-cron-a.mjs` for the delivery side). `install-crons` schedules `run-cron-review.mjs` and
  **no longer schedules `run-cron-b.mjs`** — but `run-cron-b.mjs`/`cron-b.mjs` still exist on disk
  and will keep running the OLD weak verdict path on any box whose crontab isn't re-installed after
  the update (different lock scope than the review phase, so no mutual exclusion). Always re-run
  `install-crons` after pulling this change; consider making `run-cron-b.mjs` a no-op that logs
  "retired — re-run install-crons".

- **The merge conjunction (auto-merge gate):** a PR only merges when ALL of: (1) the harness/* branch
  signal (or a future `engineKnows` secondary signal — currently hardcoded `false`, so only the
  primary branch-name signal is live) confirms machine origin; (2) `review-verdict-source.mjs` reads
  a **fresh** verdict artifact from `stateDir` (`review-<prNumber>-<sha>.json`) with `status ===
  "CLEAN"` — never the PR body; (3) cross-family agreement where configured (fail-closed: if the
  cross-family check is unavailable, it defaults to NOT merging, never to merging).

- **Fresh-verdict-artifact-in-stateDir:** `review-verdict-source.mjs` is "the single trusted verdict
  source" — it reads `join(stateDir, review-<pr.number>-<sha>.json)`. This is what makes the verdict
  un-spoofable by editing the PR body. Known hardening gaps (recorded, not yet applied): no path
  validation on `pr.number`/`sha` before the `join` (a caller passing a non-numeric/non-hex value
  could traverse `stateDir`), and `JSON.parse(raw)` is returned without validating shape
  (`status` must be exactly `"CLEAN"` or `"BLOCKED"`, object, non-array).

- **Label taxonomy:** `harness:ready` → `harness:in-review` (cron-a-exit hands off, no longer jumps
  straight to `harness:done`) → `harness:awaiting-merge` (CLEAN, mainline route while cross-family
  `available:false`) → `harness:done` (merged + counter reset) / `harness:blocked` (ceiling reached).
  `review-routing.mjs` handles reject → re-enqueue to `harness:in-review` → `harness:ready` on repair.

- **`spawnReviewSession` is now WIRED (LIVE actuator).** `core/vps/spawn-review-session.mjs`
  implements a real synchronous `claude -p` spawn: it feeds the diff/title/body brief via **stdin**
  (never argv), with per-invocation `randomUUID` nonce delimiters around the untrusted PR
  title/body/changedFiles (defeats a static-delimiter forgery from the PR body). The SESSION emits
  only its **raw eye-outputs** (adversary/compliance/security) to
  `join(meta.stateDir, "session-out")/eyes-<pr>-<sha>.json`; **NODE** (not the LLM) derives the
  canonical `{status: 'CLEAN'|'BLOCKED', finding?}` via a strict positive conjunction (`adversary
  verdict === 'CLEAN' AND compliance verdict === 'pass' AND security verdict === 'SECURE'`, no
  normalization — any missing/typo'd field defaults to `BLOCKED`) and writes it to
  `review-<pr>-<sha>.json` via tmp-file + atomic rename. The session **never** writes the canonical
  directly.
  - **Anti-spoof (hardened during review):** both the canonical AND the eye-outputs file are erased
    (`rmSync force`) BEFORE every spawn, and again on every fail-closed exit (timeout / non-zero /
    error / missing-or-corrupt eye-outputs). Erasing only the canonical was insufficient — a stale
    all-CLEAN `eyes-<pr>-<sha>.json` left over from a prior killed/timed-out attempt could be read by
    a later run that exits 0 without writing fresh eye-outputs, producing a false CLEAN. The
    derivation INPUT must be erased, not only the OUTPUT.
  - **Timeout + failure:** `spawnSync` with `timeout: reviewTimeoutMs` (default 900000) +
    `killSignal: 'SIGKILL'`; any timeout/non-zero/error/missing-corrupt path is fail-closed (no
    canonical, unlink any existing one) plus one `notify` event via the injected seam.
  - **Hands-free:** child env sets `CLAUDE_CODE_REMOTE: '1'` and deletes `OLLAMA_HAND_TOKEN` (and any
    cheap-hand token) — the review session is eyes-only, Claude tier, never reaches the spawn-hand
    (Ollama) path.
  - `engineKnows` still defaults to `false` (secondary machine-origin signal not yet built).
  - `recordFindings` is still a no-op (repair-session findings aren't durably persisted yet).
- **Breaker now-threading — FIXED.** `run-cron-review` invokes `now()` → passes a **numeric** value
  at every `cron-state` boundary (`breakerTripped`, `recordReviewSession`); `run-lock` still keeps the
  `()=>number` function form for its own `acquire` call. The window-rollover math no longer jams on
  `NaN` — the breaker counts, cuts at the cap, and recovers after the window.
- **Idempotency — PARTIALLY closed.** `recordReviewed(pr.number, sha, {stateDir})` now also fires on
  the **awaiting-merge** and **2nd-pass-blocked** routes (previously only the MERGE route called it),
  so a same-SHA PR is reviewed at most once per SHA on those two paths. The **REJECT route still
  re-reviews** on every cycle by design (a rejected PR is expected to change before the next pass).
  Regardless of this route, the anti-spoof erase-eye-outputs-before-spawn (above) independently closes
  the catastrophic stale-artifact path — the idempotency gap was always a cost/efficiency concern, not
  a wrong-CLEAN vector.

- **Reaper integration:** `reaper.mjs` accepts `opts.issueLabels(issueNumber) => string[]` and skips
  `crashRecover` for `harness:in-review` issues, but `run-reaper.mjs` (composition root) does not yet
  pass a real `issueLabels` — until wired, the explicit skip is inert (defaults to `[]`); the
  pre-existing `!prExists` guard still protects the common case.

- **Open risks (before enabling cross-family auto-merge)** — the review phase is live and
  fail-closed for merge, but these gaps must close before flipping `crossFamilyEligible`/real
  cross-family on for auto-merge:
  - **(a) judge prompt-injection:** prBody/prTitle/changedFiles are attacker-controlled and only
    delimited as untrusted stdin data (nonce-scoped, never argv/system instructions) — this defends
    against argv/shell injection, but a fully prompt-injected eye output (the LLM judge itself
    convinced to lie) is only truly backstopped by cross-family agreement + human PR review, both
    currently out of scope. Safe today only because nothing auto-merges without cross-family, which
    defaults to unavailable → fail-closed.
  - **(b) gh diff-fetch failure is indistinguishable from an empty diff:** `normalizeGhResult`
    returns `[]` both when a PR's diff is genuinely empty and when the `gh pr diff --name-only` fetch
    itself fails/hiccups. `touchesGateMachinery([])` is `false` either way, so a transient `gh` failure
    on a gate-machinery PR silently skips the HR-9 2nd pass — fail-**open** for that gate. Unreachable
    today only because cross-family is `available:false` (nothing merges regardless). **Must be made
    fail-closed before enabling cross-family** — signal diff-fetch failure distinctly (e.g. `null`)
    and force the 2nd pass / re-queue on a failed diff, updating the frozen `gh-exec.test.mjs` `[]`
    contract accordingly.
  - **(c) breaker 2nd-pass overrun:** `breakerTripped` is checked before the primary spawn but not
    re-checked before the 2nd-pass spawn — the session cap can overrun by 1 on a gate-machinery PR.
    Bounded/reversible; fix is a 3-line re-check + `secondPassClean=false` (fail-closed) if tripped.
  - **(d) dead read:** `review-routing.mjs:65` calls `reviewed.alreadyReviewed(...)` and discards the
    boolean (vestigial, out of scope for this slice).
  - Also still open (unchanged from before this feature): `engineKnows`/`recordFindings` remain
    stub/no-op, real cross-family wiring over the diff is not implemented, and
    `review-verdict-source.mjs` path/shape hardening (validating `pr.number`/`sha` before `join`, and
    the parsed JSON shape) is a pre-existing follow-up — `getFreshVerdict` stays untouched by design.
