---
name: independent-pr-review-phase
description: "[RETIRED ENGINE] Architecture of the VPS engine's independent PR-review phase, deleted in #807 — the cron-review composition named below is gone, but the cross-family driver was NOT part of it and is live (`driveCrossFamily`/`runCodexRole` in `modules/codex-adversary/references/`, `securityVerdict` in `core/shared/lib/merge-findings.mjs`). Kept for the traps that outlive it: NODE (never the LLM session) derives the canonical verdict; erase the derivation INPUT not just the output; never coerce a fail-closed sentinel to []; scrub hand tokens from a child fed an untrusted patch; a gate predicate must stay synchronous; nonce-delimited stdin, never argv."
metadata:
  type: project
---

> **[RETIRED ENGINE] — historical, read for the traps not the wiring.** The whole composition
> described here — `run-cron-review.mjs`, `cron-review.mjs`, `run-cron-a.mjs`/`run-cron-b.mjs`,
> `cron-a-dispatch.mjs`, `cron-b.mjs`, `install-crons.mjs`, `spawn-review-session.mjs`,
> `review-verdict-source.mjs`, `review-routing.mjs` — was deleted with the VPS cron engine in #807 /
> PR #830 (see `docs/vps-retirement.md`). **Nothing below is an instruction to run, install, or flip
> anything**; `autoMergeEnabled` no longer exists to flip, and the "open risks" list is a record of
> what was still open when the engine was retired, not a backlog.
>
> **What carries forward to today's PR-review automation (scheduled Orca automation, per
> `core/orca/README.md`):** (1) an LLM review session emits only raw eye-outputs — a deterministic
> non-LLM step derives and writes the canonical CLEAN/BLOCKED; (2) erase the derivation INPUT before
> every run, not only the output — a stale all-CLEAN input file forges a CLEAN on a run that exits 0
> without writing fresh output; (3) a fail-closed sentinel must never be coerced back to `[]`;
> (4) scrub `ANTHROPIC_AUTH_TOKEN`/hand tokens from any child fed an untrusted PR patch; (5) a gate
> predicate stays SYNCHRONOUS — a Promise there is always truthy and silently opens the gate;
> (6) untrusted PR title/body go in as nonce-delimited stdin, never argv; (7) cross-family latency
> makes per-step nudging impractical — carry it at boundary gates only; (8) **the cross-family fold is
> not history — it is live code.** `driveCrossFamily` / `driveCrossFamilyVerdict`
> (`modules/codex-adversary/references/cross-family.mjs`) and `securityVerdict`
> (`core/shared/lib/merge-findings.mjs`) survived the engine, so RD-1 below is a rule about what ships
> today: never drive a cross-family role with a hardcoded `claudeIssues: []` — that shape produces a
> permanent false-CLEAN.

**Why:** Cron B's original auto-merge read the merge verdict from the PR body text
(`parseVerdictBlock(bodyText)`), which is editable by anyone with push access — an open auto-merge
spoofing vector. The `independent-pr-review` feature replaces that with an independent review phase:
a separate cron reads a fresh, out-of-band verdict artifact and only merges on the full conjunction of
checks. Anyone extending or debugging the review/merge path needs to know the module boundaries,
the conjunction, the label taxonomy, and — critically — that the phase does not yet run in production.

**How to apply:**

- **Composition root:** `run-cron-review.mjs` was the production entry point; `cron-review.mjs` was
  the pure per-PR review/route/merge logic it drove (parallel to `cron-a-dispatch.mjs` /
  `run-cron-a.mjs` for the delivery side). `install-crons` scheduled `run-cron-review.mjs` and
  **no longer scheduled `run-cron-b.mjs`** — but `run-cron-b.mjs`/`cron-b.mjs` stayed on disk and
  would keep running the OLD weak verdict path on any box whose crontab wasn't re-installed after the
  update (different lock scope than the review phase, so no mutual exclusion): the engine required
  re-running `install-crons` after such a change — a crontab that was not reinstalled kept running the
  OLD weak verdict path.

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

- **`spawnReviewSession` was the LIVE actuator.** `core/vps/spawn-review-session.mjs` (deleted, #807)
  implemented a real synchronous `claude -p` spawn: it fed the diff/title/body brief via **stdin**
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

- **Real cross-family (Codex) actuator — NOW WIRED** (`cross-family-review-actuator` feature, closes
  what was previously listed here as "not implemented"):
  - **Verdict derivation (RD-1):** `deriveSecondFamilyVerdict` is a pure fold over
    `{adversary, security}` codex-eye envelopes + an injected `securityVerdict` (from
    `merge-findings.mjs`, not `codex-adversary.mjs` — no hard import of the optional driver). CLEAN
    iff both eyes present, `available !== false`, `Array.isArray(issues)`, and both resolve SECURE/no
    high-medium. Any missing/unavailable/malformed eye → BLOCKED. Never route through
    `driveCrossFamily`/`runForRole` with a hardcoded `claudeIssues:[]` — that shape produces a
    permanent false-CLEAN.
  - **Real subscription auth (RD-2):** `checkAvailability` probes `codex login status` for real
    (exit 0 + "Logged in using ChatGPT" stdout = authed by ChatGPT subscription, no API key needed).
    `OPENAI_API_KEY` remains an accepted alternate. Ambiguous probe (spawn error/timeout, which
    `spawnSync` returns as `{error, status:null}` rather than a throw) resolves to **available**
    (let the real codex exec be the authority) — never to silently-Claude-only.
  - **`autoMergeEnabled` rollout lock (RD-3/RD-6):** hard `=== true` check, default OFF. Flag-off →
    every eligible PR routes to `awaiting-merge` exactly like the cross-family-absent path
    (still calls `recordReviewed`). Must be threaded explicitly at the composition root
    (`run-cron-review.mjs` → `cronReviewFn({..., autoMergeEnabled: config.autoMergeEnabled === true})`)
    — omitting this wiring leaves the flag permanently inert (fail-safe, but silently so).
  - **Fail-closed diff fetch (RD-4/RD-5) — closes what open-risk (b) below used to describe:**
    `gh-exec` now returns a distinct non-array sentinel (`{ok:false, diffFailed:true}`) when
    `pr diff --name-only` fails, instead of collapsing to `[]` (which was indistinguishable from a
    genuinely-empty diff and silently skipped the HR-9 2nd pass). `cron-review` detects the sentinel
    and skips/re-queues (notify + continue) BEFORE any spawn/record — coercing the sentinel to `[]`
    would re-open the same fail-open bug, so callers must branch on `diffFailed`, never coerce.
    A second `gh(["pr","diff",<n>])` (no `--name-only`) branch returns the raw patch-string codex
    reviews; a non-string result from that branch is also treated as fail-closed (re-queue).
  - **Sibling artifact (RD-8):** cross-family writes `review-<n>-<sha>.crossfamily.json`, a SIBLING
    of the canonical `review-<n>-<sha>.json` — `spawn-review-session.mjs` stays the canonical's
    exclusive writer.
  - **Sync-seam invariant preserved:** `crossFamilyEligible(pr, {...})` stays a SYNCHRONOUS
    `(pr) => boolean` (a Promise here would be always-truthy and silently defeat the gate). The
    codex driver loads ONCE at `runCronReview` setup (now async); the per-PR closure itself stays
    sync since `runCodexRole`/`gh`/`fs` are all `spawnSync`-backed.
  - **Bounded spawn:** `runCodexRole` now runs under a bounded `spawnSync` (120s timeout,
    `SIGKILL`) — an earlier draft had no timeout, so a hung codex process would have frozen the
    review cron while holding its lock.
  - **Env scrub (security-blocking, fixed):** the codex child process must NOT inherit the full
    `process.env` — `ANTHROPIC_AUTH_TOKEN`/`OLLAMA_HAND_TOKEN` (and other hand tokens) are scrubbed
    from its env before spawn, mirroring the scrub `spawn-review-session.mjs` already does. An
    untrusted PR patch is fed to this binary — leaking harness credentials into it is a real, not
    theoretical, exposure.
  - **Codex latency is HIGH (~minutes per exec).** Per-task `codex-eye-nudge` dispatch is
    impractical inside a cron/headless review session with tight timeouts — it timed out (300s) on
    a spec-adversary refutation loop during this feature's own delivery. Carry cross-family at
    **boundary gates only** (spec adversary, per-task adversary/security, final dual-review) rather
    than nudging every intermediate step in a cron context. Subscription-based auth (no API key) is
    confirmed working headless/live.

- **Open risks (before flipping `autoMergeEnabled: true`)** — the review phase is live, fail-closed
  for merge, and cross-family now genuinely runs, but these gaps should close before trusting it to
  auto-merge unattended:
  - **(a) judge prompt-injection:** prBody/prTitle/changedFiles are attacker-controlled and only
    delimited as untrusted stdin data (nonce-scoped, never argv/system instructions) — this defends
    against argv/shell injection, but a fully prompt-injected eye output (the LLM judge itself
    convinced to lie) is only truly backstopped by cross-family agreement + human PR review. Same
    residual risk applies to the codex eye now that it runs for real — a prompt-injected codex verdict
    is not independently detected beyond disagreement with the Claude eyes.
  - **(b) transient vs. permanent cross-family failure not distinguished (NEW, from this feature's
    final review):** a transient cross-family failure (codex timeout, internal full-patch fetch
    failure) is currently treated identically to a genuine BLOCKED verdict — `recordReviewed` fires,
    parking the PR in `awaiting-merge` until the SHA changes, and the gate never re-runs after codex
    recovers. The crossfamily sibling artifact's `available` field could distinguish the two
    (`available === true` → genuine BLOCKED → record; `available === false` → transient → re-queue
    without recording) but the fold currently returns only a boolean, losing that signal at the
    call site. Fail-safe today (never wrong-merges) — just needs the re-queue path before enabling
    auto-merge in earnest.
  - **(c) breaker 2nd-pass overrun:** `breakerTripped` is checked before the primary spawn but not
    re-checked before the 2nd-pass spawn — the session cap can overrun by 1 on a gate-machinery PR.
    Bounded/reversible; fix is a 3-line re-check + `secondPassClean=false` (fail-closed) if tripped.
  - **(d) dead read:** `review-routing.mjs:65` calls `reviewed.alreadyReviewed(...)` and discards the
    boolean (vestigial, out of scope for this slice).
  - **(e) silent stuck auto-merge on protected-branch rejection (NEW):** `mergeAndFinalize` returning
    `{merged:false}` (e.g. GitHub branch protection rejects the merge) currently fires no notify and
    no record — the PR silently stalls and the same PR re-runs the full review cycle on every cycle.
    Needs a `notify('pr-merge-failed', ...)` on that branch.
  - Also still open (unchanged from before this feature): `engineKnows`/`recordFindings` remain
    stub/no-op, and `review-verdict-source.mjs` path/shape hardening (validating `pr.number`/`sha`
    before `join`, and the parsed JSON shape) is a pre-existing follow-up — `getFreshVerdict` stays
    untouched by design.
