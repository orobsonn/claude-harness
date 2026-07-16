# Kaizen — Harness-Improvement Proposals (outbox)

A committed outbox for improvements to the **harness itself** (an agent, skill, or rule) discovered
during a run. This is **not** project memory (that lives in `.claude/memory/`) — it is a queue of
proposals addressed to the human who maintains the framework.

Flow:
1. Any run (local or cloud) that spots a possible harness improvement **appends** a proposal below.
2. In headless mode the proposal travels in the PR — it does not evaporate with the session.
3. The human drains this outbox during PR review and promotes worthy items to the framework source
   (`core/`), from where they are re-vendored into every project on the next init.
4. **Never auto-applied** — promotion is always a human decision.

**Never write secrets, credentials, or PII here — this file is committed to git.**

## Proposals

<!-- append proposals below, e.g.:
### <date> — executor: stricter scope_paths enforcement
- **Observed:** ...
- **Proposed change:** ...
- **Rationale:** ...
-->

### 2026-06-12 — entry-gate: gate Bash delivery door while re-gate is pending

- **Observed:** The re-gate block (sniper HIGH fix awaiting strong-eye re-gate) is deterministic only
  for the SHIPPER Agent dispatch (PreToolUse `Agent` hook in `entry-gate.mjs`). A direct Bash call
  — `git push`, `gh pr create` — bypasses the gate entirely. In v1, the `orchestrating-delivery`
  convention is the single door (delivery always goes through the shipper Agent), so the risk is low.
  But it relies on convention, not enforcement.
- **Proposed change:** Extend the entry-gate's PreToolUse to also intercept `Bash` tool calls whose
  command matches `git push`, `gh pr`, `gh pr create`, or similar delivery patterns. When
  `regate_pending` is non-empty, block and return the same "re-gate required" error as the Agent gate.
- **Rationale:** Defense-in-depth. The shipper is the intended single door, but a Bash shortcut in a
  subagent (or a future script) would silently bypass the re-gate obligation. Closing the Bash door
  is cheap and makes the guarantee unconditional rather than convention-dependent.

### 2026-06-12 — creating-plans: locked_test must pin the FULL invariant, not a happy-path example

- **Observed:** In the `contract-split` task the adversary caught a frozen test that covered only 1 of
  7 eye roles in the eye→Ollama guard. The freeze "passed" but was a hole — it would have allowed a
  regression in the other 6 roles to ship undetected through the deterministic rail.
- **Proposed change:** Add an explicit rule to `creating-plans/SKILL.md` under the test-pin checklist:
  "When authoring a locked_test for an invariant with multiple branches/roles/states, the frozen test
  MUST cover ALL branches. A happy-path-only freeze is a hole. The compliance eye validates fidelity
  BEFORE freeze — it must explicitly check branch coverage."
- **Rationale:** The deterministic rail's safety guarantee rests on the frozen test being a sound
  specification. A partial freeze is worse than no freeze — it creates false confidence while missing
  the cases most likely to regress.

### 2026-06-12 — entry-gate: harden non-array regate_pending (currently fail-open)

- **Observed:** The gate reads `regate_pending` from `gate-state.json` and treats a non-array value
  (e.g. corrupted state) as an empty array → fail-open (delivery proceeds). This is consistent with
  the harness's "fail-open on infra error" contract, but a corrupted `regate_pending` specifically
  masks a pending re-gate obligation, which is a safety concern.
- **Proposed change:** Distinguish infra errors (file not readable → fail-open as today) from corrupt
  state (file readable but `regate_pending` is not an array → fail with an explicit "gate-state
  corrupted" error rather than treating it as empty). Log the raw value for debugging.
- **Rationale:** A corrupted `regate_pending` is not an infra failure — the state file exists but its
  content is wrong. Failing closed on corrupt state (rather than silently dropping the obligation)
  is safer and easier to diagnose.

### 2026-06-12 — SKILL.md authoring: routing-table rows must be uniquely named or tests must filter-all

- **Observed:** `orchestrating-delivery/SKILL.md` has duplicate rows for `adversary`, `compliance`, and
  `security` (one row for the per-task gate, one for the final dual-review gate). A test that uses
  `find-first` on role name will silently match only the first occurrence and miss the second,
  producing a false positive ("role is correctly not using Ollama") while the second row is wrong.
- **Proposed change:** Either (a) require unique role identifiers in routing tables by adding a
  qualifier (`adversary (per-task)` vs `adversary (final-gate)`), or (b) add a convention note to the
  SKILL authoring guide that parsing tests must use `filter-all` (find every matching row) rather than
  `find-first`. Option (a) is preferable — it removes the ambiguity at the source.
- **Rationale:** Routing-table integrity tests are the proof that model routing is correctly
  configured. A test that silently matches the wrong row provides no safety. Unique row identifiers
  make the table both human-readable and machine-verifiable without special test logic.

### 2026-07-04 — cross-family: codex eye fail-opens under a file-read-heavy sandbox — keep it advisory, never gate

- **Observed:** During the `process-eye-routing` delivery the operator asked to run the cross-family
  (Codex/GPT) eye at the two highest-leverage gates (spec-adversary + final dual-review). `codex exec
  --sandbox read-only` was logged in (ChatGPT session, no `OPENAI_API_KEY`) but **timed out with ZERO
  output on all three attempts** (spec ×2, final ×1) at 240–420s windows — it never emitted a verdict.
  The likely cause is the read-only sandbox + large-file reads (SKILL.md ~74KB, entry-gate ~55KB) being
  too slow for the CLI to reach a first token. The Claude opus adversary carried the gate; cross-family
  correctly **failed open** (checkpoint ran Claude-only exactly as today) and no verdict was fabricated.
- **Proposed change:** (a) document a **lean cross-family invocation profile** — point `cross-family.mjs`
  at the *diff* (and only the hunks' immediate context), not the full skill files, so the Codex peer can
  reach a verdict inside a normal window; (b) add a short **timeout budget** to the driver (e.g. 180s)
  that returns a `{ available:false, reason:"codex timeout" }` passthrough rather than blocking the
  orchestrator's own turn; (c) keep the fail-open invariant explicit in the SKILL: a cross-family eye
  that produces no output within budget is a non-event, never a gate — and the orchestrator must record
  the *attempt + timeout* (not silently drop it) so the operator sees cross-family was tried.
- **Rationale:** cross-family's whole value is a second family catching what the first's priors miss,
  but it is explicitly a fail-open enhancement. A profile that reliably reaches a verdict on the diff is
  worth more than a thorough prompt that never returns; and an audit line ("cross-family attempted,
  timed out, ran Claude-only") keeps the fail-open honest instead of looking like it silently ran.

### 2026-06-27 — executor/planner: inert-mechanism trap — CLI docs must be backed by a real CLI entry block

- **Observed:** During the `ci-release-gate` feature, library-only `.mjs` modules (exporting pure
  functions) were documented in `SKILL.md` and in a `ci.yml` comment as runnable CLIs
  (`node generate-ci.mjs --target …`, `node branch-protection.mjs …`). The CLI entry block
  (`if (process.argv[1] === fileURLToPath(import.meta.url))`) did not exist — following the docs was
  a silent no-op. Per-task review cannot see this seam; only the whole-feature adversary caught it.
  Precedent CLI pattern already exists: `scan-secrets-in-tree.mjs`.
- **Proposed change:** Add a rule to the executor/planner guidance: when a skill or comment
  documents `node <module>.mjs [args]` as a runnable command, the author must ensure the module has a
  real CLI entry block at the bottom (pattern: `if (process.argv[1] === fileURLToPath(import.meta.url))`).
  If the module is import-only, the doc must say "import and call `fn()`", never show a bash command.
  The compliance eye must verify CLI entry exists before freezing tests that invoke the module as a CLI.
- **Rationale:** A documented CLI with no entry block is an inert mechanism — all downstream
  integration (scripts, CI steps, SKILL.md examples) silently do nothing. This class of bug is
  invisible to per-task review and can survive a full test suite if tests import rather than spawn.

### 2026-06-27 — executor: test files in this repo must resolve paths via import.meta.url, never hardcoded

- **Observed:** Two executor-authored tests in the `ci-release-gate` feature hardcoded absolute paths
  (`/Users/robson/.../claude-harness/...`). They pass locally but FAIL in GitHub Actions (different
  checkout path). Because the dogfood CI runs the full suite, this would have reddened CI on merge.
- **Proposed change:** Add to the executor/test-author guidance for this repo (and embed in
  `creating-plans/SKILL.md` or the executor agent): "Tests that reference repo files must resolve
  paths via `resolve(dirname(fileURLToPath(import.meta.url)), '../...')`. Hardcoded absolute paths
  are forbidden in test files — they are undetectable locally and always fail in CI."
  The compliance eye should scan new test files for `/Users/` or `/home/` literals as part of gate.
- **Rationale:** Hardcoded home-dir paths are a silent CI killer. They always pass on the author's
  machine and always fail on any other machine (CI, peer review, cloud routine). A pattern grep in
  compliance is cheap and catches 100% of cases.

### 2026-06-27 — adversary/gates: verify empirically when rendered control-char regex looks suspicious

- **Observed:** The final-review adversary flagged `/[\n\r\x00-\x1f]/` as `/[\n\r -]/` because the
  Read tool renders the 0x00–0x1f range as a literal space-hyphen on screen. The adversary predicted
  all tests red. The empirical gate (529/529 green + successful CLI write) refuted the finding.
- **Proposed change:** Add a note to the adversary guidance: "When flagging a regex or escape
  sequence as malformed based on rendered output, always include a 'verify by running' hedge — never
  assert a test outcome from rendered text alone. The gate (not prose) is the arbiter." Also: the
  adversary finding was correctly marked HIGH and correctly included a verification path — the loop
  worked. This is a confirmation that the verify-hedge is already partially present; make it explicit.
- **Rationale:** Read-tool rendering can silently misrepresent binary/hex literals. An adversary that
  treats rendered output as ground truth will generate false HIGH findings that cost sniper cycles.
  The correct posture is: flag + hedge + gate. The gate settles it.

### 2026-07-05 — test-author: distinguish "preserve coverage" from "preserve assertions" on behavior-change tasks

- **Observed:** During `independent-pr-review` (cron-a-exit-done-fix), a task CHANGED behavior that
  existing tests pinned (the done-bug fix flips PR-exists → in-review instead of done). The default
  test-author brief ("preserve ALL existing tests unchanged") contradicts this: legacy tests assert
  the old behavior, new tests assert the new — the executor cannot make both green. The conflict only
  surfaced after a second reconcile dispatch (a wasted cycle).
- **Proposed change:** The `orchestrating-delivery` test-author step (or the test-author agent prompt)
  should distinguish "preserve coverage" (every previously-tested scenario still has a test) from
  "preserve assertions" (the exact old expected value). For a behavior-change task, the brief must
  instruct the test-author to UPDATE the specific legacy tests that pin the superseded behavior
  (keeping their still-valid sub-assertions) in the SAME dispatch. Detect trigger: task spec says
  "fix/change/replace <existing behavior>" AND `test_path` already exists → flag legacy-assertion
  reconciliation up front, before the first executor dispatch.
- **Rationale:** A test-author that blindly preserves assertions on a behavior-change task guarantees
  a contradiction the executor cannot resolve — costing a full reconcile cycle that a one-line brief
  addendum would have prevented.

### 2026-07-05 — test-author gotcha: `*/` inside a JSDoc `/** */` block breaks JS parse — needs a pre-freeze guard

- **Observed:** During `independent-pr-review`, a frozen test froze with a SyntaxError: its JSDoc
  header wrote a cron cadence literally as `0 */6`, and the `*/` sequence closed the `/** */` comment
  mid-sentence, so the file failed to parse (0 tests collected, error before any assertion). A
  parse-error freeze is the worst kind — it blocks the whole file and survives the freeze silently
  until the gate runs.
- **Proposed change:** (a) add a rule to test-author guidance: never write a cron string (or any
  string containing `*/`) literally inside a `/** */` block — use `//` line comments, escape, or
  rephrase (e.g. "every 6h" instead of "0 */6 * * *"); (b) add a cheap pre-freeze guard to
  `creating-plans`/the freeze tooling: run `node --check <test>` (or confirm the test file collects
  >0 tests) before committing the freeze — a file that fails to parse collects 0 tests and must never
  freeze as-is.
- **Rationale:** A frozen test that cannot even parse gives zero safety while looking green-adjacent
  in tooling that doesn't explicitly check test count. The guard is a one-line, near-zero-cost check
  that eliminates the whole failure class.

### 2026-07-05 — spawn-hand: version-check cache write is flagged as an out-of-scope violation (false positive)

- **Observed:** During `independent-pr-review`, the child `claude -p` hand session loads the
  project's `.claude/settings.json`, whose `SessionStart` hook `version-check.mjs` writes
  `.claude/.harness-version-check-cache` (gitignored) whenever the cache is stale (>6h ttl).
  spawn-hand's independent capture (`lsFilesAllOthers`, no `--exclude-standard`) correctly detects
  this as an out-of-scope gitignored write and marks the run-record `FAILED` with
  `scopeViolations=[.claude/.harness-version-check-cache]`, which `entry-gate.mjs` then hard-blocks —
  failing a genuinely correct, in-scope, frozen-test-green run and costing a wasted re-spawn.
- **Proposed change:** pick one — (a) spawn-hand/capture-hand excludes a small allowlist of known
  benign harness infra caches (`.claude/.harness-version-check-cache*`) from the out-of-scope
  gitignored sweep; (b) `version-check.mjs` no-ops when running inside a hand child session (detect
  via an env flag spawn-hand sets, e.g. `HARNESS_HAND_CHILD=1`); (c) spawn-hand pre-refreshes the
  cache's `cachedAt` to now before spawning so the child always finds it fresh and skips the write.
  (c) is the cheapest and was used as a manual workaround this run — worth making it the default.
- **Rationale:** A benign, deterministic, harness-owned infra write should never fail a hand's scope
  check. The false positive costs a full re-spawn cycle every time the 6h cache ttl expires mid-run.
- **DELIVERED by `scope-check-exclude-harness-cache` (branch `harness/84`):** option (a) shipped.
  `isHarnessInternalPath`/`excludeHarnessInternal` in `dispatch-hand.mjs` exclude the exact two
  literals (`.claude/.harness-version-check-cache` + `.tmp`) from `touchedPaths` before both the
  spawn-hand gate and capture-hand's independent capture run `evaluateRun`/scope-check — by EXACT
  match only, never prefix (closes the escape vector a naive `startsWith` would have opened). See
  `core/memory/dispatch-hand-contract.md` for the full contract note. Follow-up drift-guard proposal
  below.

### 2026-07-05 — spawn-hand: detect Ollama 429 usage-limit distinctly and short-circuit the fallback ceremony

- **Observed:** During `independent-pr-review`, the Ollama account hit its session usage limit
  (429 "session usage limit") partway through the run. Every subsequent spawn-hand returned an empty
  diff (`NOT_DONE`) because the child `claude -p --model <ollama>` got 429 on turn 1 — confirmed
  account-level (two different models failed identically), not a model issue. The K=1
  escalation-fallback correctly authorizes a main-loop Claude executor once an on-disk
  `NOT_DONE`/`FAILED` run-record + escalation-fallback ticket exist, but this meant every remaining
  task paid for one wasted ~3min 429-spawn purely to mint the authorizing record.
- **Proposed change:** when spawn-hand detects a 429 usage-limit response (distinct from a transient
  timeout), it should (a) surface it as an operator-facing infra notice, and (b) short-circuit the
  ceremony — either auto-authorize the Claude fallback for the rest of the run, or (in a headless-local
  run) let the orchestrator flip to Claude-executor mode without a wasted 429-spawn per task.
- **Rationale:** A 429 usage-limit is a known, detectable, account-level condition — not a fluke worth
  re-testing every task. Short-circuiting saves a wasted spawn per task for the remainder of the run
  and gives the operator an actionable signal (upgrade plan / wait for reset) sooner.

### 2026-07-05 — process/tooling: enforce frozen-test-GREEN + record-DONE before the impl-commit

- **Observed:** During `independent-pr-review` (compliance-diff-adapter), the impl was committed
  based on the executor's Note preview WITHOUT running the frozen test — a regex bug left the frozen
  test RED and the run-record `FAILED`. Committing moved HEAD off the freeze baseline, which then
  denied the Claude sniper (freeze≠HEAD dispatch gate), requiring a `git reset --mixed <freeze>` to
  recover before the sniper could run. `drive-verify.sh` already gates on `lockedTestExit`, but the
  step was skipped in favor of committing off prose. Compounding this in the same incident: the
  original `drive-freeze` scope had been narrowed to the two files the locked test touched
  (`adapter.mjs`, `adapter.test.mjs`), omitting `core/agents/compliance.md`, which WAS in the task's
  `scope_paths` — so a legitimate in-scope executor edit to `compliance.md` was recorded as a false
  scope violation, and the resulting `FAILED` record survived the later revert+fix, silently blocking
  every subsequent delivery-bash-gate command even though the delivered state was independently
  verified clean (2/2 green, only `adapter.mjs` touched, `compliance.md` reverted).
- **Proposed change:** (a) make `drive-verify.sh` (or equivalent) a **mandatory** step the shipper/
  orchestrator invokes right before the impl-commit — never commit from an agent's prose summary;
  (b) always pass the task's FULL `scope_paths` to `drive-freeze` (not just the files the locked test
  touches) so an in-scope write by the executor is never a false scope violation; (c) give the
  orchestrator (or a small CLI) a documented, audited way to prune/regenerate a stale `FAILED`
  run-record once the delivered state has been independently re-verified clean — today the only path
  is manual deletion with no tooling support, which is easy to get wrong under pressure.
- **Rationale:** These three gaps compounded into a single incident (premature commit → freeze
  desync → stale-record delivery block) that cost a manual recovery sequence. Each fix is cheap in
  isolation and closes a distinct step in the chain: verify-before-commit prevents the desync from
  happening; full-scope-freeze prevents the false violation that triggered the FAILED record in the
  first place; and a supported prune path removes the need for undocumented manual surgery when a
  stale record does slip through.

### 2026-07-05 — adversary/test-author: seam-mock-vs-production shape divergence is invisible to hermetic tests

- **Observed:** During `review-spawn-wiring`, the final-review adversary caught a HIGH that ALL
  hermetic per-task tests missed: `cron-review.mjs` reads `gh(["pr","diff", n, "--name-only"])`
  expecting a `string[]`, but the REAL `defaultGhExec` (`gh-exec.mjs`) only parses `--json` calls into
  arrays — a non-json `pr diff` call actually returned `{ok:true}` (an object). The bug was dormant
  under the old throwing `spawnReviewSession` stub and only became live once this feature wired the
  real actuator. Every frozen/task test injected a fake `gh` seam that returned an array directly for
  this call, so the mismatch between the seam's test-double shape and its production shape was never
  exercised — only the whole-feature adversary tracing a live call path caught it (`touchesGateMachinery({ok:true})`
  → `.some` on a non-array → `TypeError` every cron cycle, burning a `claude -p` spawn and never
  routing/recording, until the breaker trips).
- **Proposed change:** when a module consumes an injected seam whose PRODUCTION implementation
  returns a **different shape depending on call arguments** (e.g. json vs non-json vs raw-text calls
  to the same `gh` function), require at least one test that exercises the REAL seam's shape for each
  call variant the module makes (either call the real seam directly in an isolated unit test, or use a
  fixture that mirrors its actual per-variant return shape — not a single generic mock). Additionally,
  the final-review adversary's checklist should explicitly include "trace one live production call
  path per injected seam per feature" as a standing check, not an incidental catch.
- **Rationale:** Mock-vs-production shape divergence is a class of bug that hermetic per-task tests
  structurally cannot see — the test author controls both the caller and the fake seam, so they agree
  with each other by construction even when they disagree with reality. Only tracing (or fixture-
  mirroring) the real seam's behavior per call variant closes this blind spot, and doing it as a named
  standing check (rather than relying on an adversary catching it by chance) makes the safety net
  systematic instead of incidental.

### 2026-07-05 — RECURRENCE of "spawn-hand: detect Ollama 429 usage-limit distinctly" (see entry above, same date)

- **Observed:** `review-spawn-wiring` hit the identical pattern already logged above (Ollama account
  429 session-usage-limit on the FIRST dispatch, staying rate-limited for the whole run) — every one
  of the 5 tasks' executor/sniper dispatches paid the same wasted ~3min 429-spawn-to-generate-the-
  authorizing-NOT_DONE-record cost before the K=1 Claude-fallback correctly took over. Two independent
  runs on the same day hit this exact condition, which raises its priority from "worth fixing" to
  "worth fixing now" — it is not a one-off fluke.
- **Proposed change:** no new proposal — this reinforces the existing one (pre-flight cheap-hand
  health probe / first-failure short-circuit to Claude-executor mode). Bumping visibility: two
  same-day recurrences of the identical failure mode is a strong signal to prioritize this fix in the
  next harness iteration rather than let it sit in the outbox.
- **Rationale:** kaizen.md is the durable cross-run signal precisely so recurring patterns are visible
  across runs whose `findings.md` has already been deleted. Recording the recurrence (rather than a
  fresh duplicate proposal) keeps the outbox from accumulating near-identical entries while still
  surfacing the frequency signal to the human reviewer.

### 2026-07-05 — cross-family-review-actuator: transient cross-family failure indistinguishable from genuine BLOCKED (MUST fix before autoMergeEnabled)

- **Observed:** In the final dual review of `cross-family-review-actuator`, `deriveSecondFamilyVerdict`
  returns only a boolean-shaped verdict — the caller (`cron-review.mjs`) cannot distinguish "codex
  genuinely found issues" (real BLOCKED; correctly calls `recordReviewed` and parks the PR in
  `awaiting-merge` until the SHA changes) from "codex timed out / the full-patch fetch failed"
  (transient; should re-queue WITHOUT recording so the gate re-runs once codex recovers). Today both
  collapse to the same outcome and both call `recordReviewed`. Fail-safe today (a PR never
  wrong-merges, and `autoMergeEnabled` defaults OFF) but becomes a real throughput bug the moment an
  operator flips the flag — codex has documented high latency (minutes per exec) and this feature's
  own delivery already saw it time out live.
- **Proposed change:** have the residual-branch consumer read the crossfamily sibling artifact's
  `available` field directly instead of relying only on the folded boolean: `available === true`
  (both eyes actually ran and disagreed) → genuine BLOCKED → `recordReviewed`; `available === false`
  (codex didn't run / fetch failed) → transient → route to `awaiting-merge` WITHOUT recording, so the
  next cron pass re-attempts cross-family on the same SHA.
- **Rationale:** MUST land before flipping `autoMergeEnabled: true` in any real config — otherwise a
  transient codex hiccup can permanently strand an otherwise-good PR in `awaiting-merge` until a new
  push changes the SHA, which may never happen without manual intervention.

### 2026-07-05 — cross-family-review-actuator: codex spawn env hygiene + artifact identity hardening (2 low residuals)

- **Observed:** Final security review of `cross-family-review-actuator` found two low, non-blocking
  residuals: (1) `defaultHasCodex` invokes its login-status probe with `shell: true` on a hardcoded
  constant argument — not exploitable today, but `shell:true` on any spawn is a footgun the next edit
  could turn live by concatenating a variable in; (2) the new `review-<n>-<sha>.crossfamily.json`
  sibling artifact path is derived the same way as the canonical verdict artifact and could re-validate
  `pr.number`/`sha` identity before use as defense-in-depth — matching the pre-existing, already-tracked
  hardening gap on `review-verdict-source.mjs` (no path-traversal vector demonstrated).
- **Proposed change:** drop `shell: true` from `defaultHasCodex`'s spawn (argv array form instead); fold
  the crossfamily artifact path through the same `pr.number`/`sha` shape validation once
  `review-verdict-source.mjs` gets its own hardening pass — one fix covers both call sites.
- **Rationale:** Neither is reachable today, but both are cheap to close and remove a latent footgun
  before the codex spawn path sees more traffic under `autoMergeEnabled`.

### 2026-07-05 — cross-family-review-actuator: exact-match UNSAFE guard misses trailing-text codex verdicts (accepted low residual)

- **Observed:** During task-5's mandatory re-gate (grave HIGH fix), the case-insensitive UNSAFE guard
  added to close the false-CLEAN path does an exact (case-folded) match against the codex verdict
  string. A codex output like `"UNSAFE - XSS in handler"` (verdict + trailing rationale in the same
  field, instead of a clean enum value) would not match and would fall through as if SECURE. Requires a
  double deviation from codex (wrong enum shape AND inline rationale) to trigger; the
  severity/issues-array gate already catches the realistic case since a real UNSAFE verdict is normally
  accompanied by non-empty `issues`. Accepted as a residual by the virgin sonnet spot-check (zero
  blocking findings).
- **Proposed change:** loosen the guard to an `includes`/regex check (`/unsafe/i.test(verdict)`) instead
  of exact match, OR normalize codex's verdict field at the parse boundary (split on first
  whitespace/dash before comparing).
- **Rationale:** Low priority — the issues-array gate already covers the realistic failure mode; this
  closes the theoretical edge case cheaply whenever someone next touches this file.

### 2026-07-06 — RECURRENCE: codex-eye-nudge hang at runtime (see 2026-07-04 cross-family entry above, same fix)

- **Observed:** During `test-author-format-safety`, the `codex-eye-nudge` hook fired deterministically
  and `checkAvailability` returned ok, but the actual `codex` invocation HANGS at runtime (no working
  `OPENAI_API_KEY`) at every eye checkpoint — the orchestrator had to kill it manually each time
  (~90s wasted per checkpoint). Every eye correctly fell back to Claude-only per the fail-open
  contract; no gate was weakened. This is the same failure class as the 2026-07-04 entry above
  (codex times out / never returns a verdict), now observed as an outright hang rather than a
  240–420s timeout — same root cause (no bounded timeout in the cross-family driver), same proposed
  fix (bound the codex call with its own timeout budget and degrade to a Claude-only passthrough on
  timeout/hang, rather than relying on the orchestrator to notice and kill it).
- **Proposed change:** no new proposal — reinforces the existing one. Bumping visibility: this is the
  second distinct delivery (different feature, two days apart) to hit codex being unreachable at the
  eye checkpoint with no bounded timeout in the driver, which strengthens the case for prioritizing
  the timeout-budget fix in the next harness iteration.
- **Rationale:** Same rationale as the RECURRENCE convention used above — kaizen.md's job is to make
  cross-run recurrence visible once each run's `findings.md` is gone. A second occurrence of an
  already-logged proposal is a frequency signal, not a new proposal to draft.

### 2026-07-05 — RECURRENCE: cron-review 2nd-pass spawn still not re-gated by breakerTripped (pre-existing, now confirmed twice)

- **Observed:** First tracked as an open risk in `independent-pr-review-phase` (#132/#134); reconfirmed
  as explicitly out-of-scope during `cross-family-review-actuator` task-4's adversary pass.
  `breakerTripped` is checked once before the primary review spawn but is not re-checked before the
  HR-9 2nd-pass spawn on a gate-machinery PR — a single such PR can consume 2 breaker slots in one
  cycle, letting the session cap overrun by 1. Bounded and reversible (worst case is one extra session
  per breaker window, not an auto-merge safety issue), but two independent features have now flagged it
  as "should fix, out of this slice's scope."
- **Proposed change:** add a 3-line re-check of `breakerTripped` immediately before the 2nd-pass spawn;
  treat a trip there as `secondPassClean=false` (fail-closed), matching the primary-spawn behavior.
- **Rationale:** kaizen.md's job is to surface recurrence once `findings.md` is gone — a fix this small,
  flagged twice across separate delivery slices, is worth prioritizing rather than deferring a third
  time.

### 2026-07-06 — dispatch-hand: add a drift-guard test linking HARNESS_INTERNAL_PATHS to version-check.mjs's actual writer literals

- **Observed:** During `scope-check-exclude-harness-cache`, the final-review adversary flagged (LOW,
  fail-safe direction — never a bypass) that the two literals in `dispatch-hand.mjs`'s
  `HARNESS_INTERNAL_PATHS` (`.claude/.harness-version-check-cache` / `.tmp`) are hand-duplicated from
  `core/hooks/version-check.mjs::writeCacheToDisk`'s `finalPath`/`tmpPath`, with no shared import and
  no test asserting the two sides agree. The JSDoc says "grep-traceable" but nothing enforces it
  mechanically — a future rename of the cache path in `version-check.mjs` alone would silently
  resurrect the exact false-positive this feature just fixed, and no test would fail to catch it.
  Deferred from this PR because it requires editing the frozen locked-test file
  (`dispatch-hand.test.mjs`), which was out of scope for this task.
- **Proposed change:** add a small drift-guard test (in `dispatch-hand.test.mjs` or a sibling file)
  that reads `version-check.mjs` as text, extracts the writer's `finalPath`/`tmpPath` literals via a
  narrow regex (or imports `writeCacheToDisk`'s constants if refactored to export them), and asserts
  `HARNESS_INTERNAL_PATHS` deep-equals that pair — turning the JSDoc's "grep-traceable" claim into an
  executable invariant instead of a comment promise.
- **Rationale:** Two independently-authored literal lists that MUST stay in sync but have no test
  linking them is a silent-drift trap — cheap to close with one small test, and the cost of missing it
  is a full recurrence of the false-positive bug this feature exists to fix.

---

## cross-family as a HARD auto-merge precondition freezes the pipeline on a codex outage (deferred PR-2)

**Context:** automerge-hardening (#86) fixed the auto-merge undraft + gate-machinery carve-out + label
hygiene, but deliberately LEFT cross-family (Codex 2nd family) as a REQUIRED precondition of auto-merge.

**Problem observed live:** the Codex ChatGPT subscription hit its usage quota. `checkAvailability`
passed (auth valid) but every `codex exec` exited non-zero ("usage limit"), so `crossFamilyEligible`
was fail-closed BLOCKED for every PR → no PR ever auto-merged → the whole roadmap froze until the quota
reset, with no operator signal distinguishing "codex found a real problem (BLOCKED)" from "codex could
not run (quota/outage)".

**Proposed PR-2 (adversary-endorsed shape, NOT blanket fail-open):** make cross-family an OPTIONAL
enhancement for the auto-merge gate — fail-open ONLY for non-gate-machinery diffs when codex CANNOT RUN
(quota/timeout/unavailable, distinct from a real BLOCKED verdict), gated behind an explicit opt-in
config, emitting a LOUD operator notify each time it degrades to Claude-only. NEVER fail-open for
gate-machinery diffs (already manual-merge via the carve-out), never treat a real BLOCKED as absent,
never blanket. The adversary rejected blanket outage-fail-open (weakenable through the harness's own
gate, timeout-inducible bypass, silences the stall alarm). Until then: keep codex quota funded, or
manual-merge the queue.

### 2026-07-06 — spawn-hand: seed workspace trust in the ephemeral CLAUDE_CONFIG_DIR (headless `claude -p` stalls into the 9-min timeout)

- **Observed:** During `hand-429-escalation-shortcut`, the Ollama executor dispatch (deepseek-v4-pro
  — an id that is no longer dispatchable: since #361 only the approved ladder in
  `shared/lib/hand-model-ladder.mjs` may run as a hand — via `spawn-hand.mjs`) hit the 9-min
  wall-clock ceiling and returned `timedOut: true` → outcome
  FAILED — even though the independent capture confirmed the work was COMPLETE, in-scope, and the
  frozen test GREEN (37/37). The child's stderr revealed the cause: `"Ignoring 57 permissions.allow
  entries from .claude/settings.json: this workspace has not been trusted. Run Claude Code
  interactively here once and accept the trust dialog, or set projects[...].hasTrustDialogAccepted:
  true"`. The ephemeral `mkdtemp` CLAUDE_CONFIG_DIR that `spawn-hand` seeds does not mark the
  workspace trusted, so the headless `claude -p` child stalls (no interactive trust dialog can be
  answered) and runs its tools crippled / never exits cleanly → guaranteed timeout on this VPS. This
  made the cheap-hand path effectively non-functional for the whole run (executor AND any sniper), so
  the orchestrator had to accept the capture-verified work and apply the one surgical adversary fix
  directly rather than dispatch further Ollama hands that would all time out identically.
- **Proposed change:** when `spawn-hand.mjs` seeds the ephemeral CLAUDE_CONFIG_DIR, also write a
  minimal `.claude.json` (or the appropriate key) that marks the target workspace trusted
  (`projects["<cwd>"].hasTrustDialogAccepted: true`), so the headless child never stalls on the trust
  dialog. Without it, every cheap-hand dispatch on a non-pre-trusted machine burns the full timeout
  and reports a false FAILED — silently defeating cheap-hands and, ironically, forcing the exact
  wasteful behavior the 429-shortcut feature exists to avoid (but for timeouts, not 429s).
- **Rationale:** this is a systemic, deterministic failure of the cheap-hand path on any machine where
  the ephemeral config's workspace isn't pre-trusted — high leverage, small fix, and it invalidates
  the run-record's FAILED signal (a completed run mislabelled as a failure), which downstream
  escalation logic trusts.
- **2026-07-09 reconfirmation (`fleet-multi-repo`, #117), new symptom variant:** the same untrusted-
  ephemeral-workspace root cause also produces a DIFFERENT, quieter failure than the 9-min timeout
  above — a WEAKER hand (`hand_tiers.medium`, glm-5.2) exited quickly with `NOT_DONE` and an EMPTY diff
  (~0 output tokens) because it asked for permission and stopped, rather than stalling. This happened
  from INSIDE a git worktree, where the ephemeral `CLAUDE_CONFIG_DIR` reported the PRIMARY tree's path
  (not the worktree path) as untrusted. K=1 escalation to a STRONGER hand (`hand_tiers.high`,
  kimi-k2.7-code) routed around it and succeeded on the first try — so the failure mode is
  model-capability-dependent, not universal, and burns a full escalation step silently (a
  `NOT_DONE`/empty-diff outcome reads as "the hand tried and failed", not "the hand was never allowed to
  try"). Confirms the proposed fix (pre-seed `hasTrustDialogAccepted`) should target the WORKTREE path
  specifically, not just the primary tree.

### 2026-07-06 — 429-streak: add a TTL/session key + tier-dedup (accepted fail-safe-direction residuals from hand-429-escalation-shortcut)

- **Observed:** The final-review adversary flagged two residuals in the new consecutive-429 counter,
  both strictly in the fail-safe direction (they only OVER-route toward the Claude fallback — cost,
  never corruption or a block), so they were accepted for this PR:
  1. The streak is freeze-bounded, not time-bounded (no TTL/session key). A task re-queued at the SAME
     freeze inherits a persisted `count: 2` and shortcuts on the FIRST dispatch even after the Ollama
     quota has recovered — losing the cheap-hand savings for that task.
  2. The counter counts DISPATCHES, not TIERS: a transient re-dispatch of the same tier at the same
     freeze double-counts one tier's 429 (`count 1→2`) → premature shortcut.
- **Proposed change:** (1) persist a `ts` (or `session_id`) with the streak record and treat it as
  count 0 once older than a quota-reset window (e.g. ~15 min); (2) persist `lastModel` and only
  increment when `descriptor.model` differs from the last 429-attributed model, so a same-tier retry
  doesn't advance the counter but the real LOW→MEDIUM→HIGH progression still does.
- **Rationale:** both are cheap hardening that recover cheap-hand savings the current freeze-only
  anchor leaves on the table; neither is a correctness/safety defect, so deferring was safe, but the
  recurrence signal belongs here now that `findings.md` is gone.

### 2026-07-06 — 429 attribution: parse the `--output-format json` envelope instead of substring-scanning

- **Observed:** `isRateLimited` attributes a 429 by regex over the child stream. The stdout branch had
  to be hardened (`\berror\b`, drop `api`) because the single-line `claude -p --output-format json`
  envelope always carries `is_error` and `duration_api_ms`, which a naive marker matched on every
  line — collapsing the "strictly stronger than a bare \b429\b" guard back to a bare match. The regex
  fix works but is brittle: a benign `result` narrating a word-boundary "error" beside "429" still
  attributes (accepted, fail-safe).
- **Proposed change:** JSON.parse the stdout envelope and key 429 attribution off `is_error === true`
  plus the error/subtype field, instead of substring-scanning the `result` text; keep the raw-stderr
  429 check as the transport-channel fallback.
- **Rationale:** the robust parse removes the whole class of envelope-field false-positives and the
  narrated-"error" residual, and would also let attribution catch a rate-limit surfaced WITHOUT the
  literal 429 (e.g. `rate_limit_error`/"Overloaded") — a current blind spot.

### 2026-07-07 — codex-eye-nudge / obs-eye-append: align "main-loop only" guard to hasOwnProperty presence-check

- **Observed:** building `agent-idle-nudge.mjs` (#90), the adversary flagged that the payload contract
  for a PostToolUse[Agent] hook is: a **main-loop** Agent dispatch OMITS the `agent_id` key entirely; a
  **nested/subagent** dispatch INCLUDES it. The three gates that police this boundary
  (`entry-gate.mjs:749`, `stamp-triage.mjs`, `plan-write-gate.mjs`) correctly key "main-loop only" off
  `Object.prototype.hasOwnProperty.call(payload, 'agent_id')` — presence, not truthiness — so a
  falsy-but-present `agent_id` (`''` / `0`) is still read as a nested dispatch, per contract. The two
  existing sibling PostToolUse[Agent] hooks instead guard with plain truthiness —
  `codex-eye-nudge.mjs:79` (`if (payload.agent_id) return { action: 'none' }`) and
  `obs-eye-append.mjs:111` (same pattern) — which would silently misclassify a nested dispatch carrying
  a falsy-but-present `agent_id` as main-loop, and fire on it. `agent-idle-nudge.mjs` was built with the
  presence-check from the start to match the gate convention. Separately, `obs-eye-append.mjs:43` reads
  the report text as `payload.tool_response ?? payload.tool_output ?? ''` — `??` only falls through on
  `null`/`undefined`, so an empty-string `tool_response` (`''`) short-circuits and masks a real report
  sitting in `tool_output`. `agent-idle-nudge.mjs` closed the equivalent gap by treating a payload as
  idle only when BOTH fields independently trim to empty/absent.
- **Proposed change:** (1) change `codex-eye-nudge.mjs:79` and `obs-eye-append.mjs:111` from the
  truthiness guard to the presence-check (`hasOwnProperty`), matching the gate convention and
  `agent-idle-nudge.mjs`; (2) in `obs-eye-append.mjs:43`, replace the `??` chain with a symmetric
  "idle only if both fields are idle" check (or equivalent) so an empty-string `tool_response` cannot
  mask a real `tool_output` report.
- **Rationale:** both are narrow, low-risk fixes to two hooks already in production that share the
  exact defect class this feature just fixed once; leaving the inconsistency means three different
  "main-loop only" implementations coexist in the same hook family, one of them (fix #1) provably
  wrong on a falsy-but-present `agent_id`, and one (fix #2) able to silently swallow a real eye report.

### 2026-07-08 — orchestrating-delivery/sniper: consider broadening the frozen-test re-gate to ALL sniper fixes, not just adversary-suggested

- **Observed:** `sniper-frozen-test-gate` (issue source: m6 task-4's adversary-suggested `dedup_key` fix
  breaking a pinned fixture) scoped the new step-5 re-gate to **adversary-suggested** sniper fixes only
  — faithful to the source learning and the issue's ACs. Both the spec-adversary and the plan-reviewer
  independently flagged the same residual gap: the sniper actually applies a **batch** (the union of
  compliance + adversary + security + gate findings) in one reconciliation pass, and **compliance is
  equally blind** to sibling frozen fixtures (a compliance finding is generated with the same
  no-visibility-into-other-tasks constraint as an adversary finding). So a compliance-, security-, or
  gate-driven sniper fix to a file shared with a completed task's frozen fixture has the identical
  cross-task blind spot the whole feature was built to close, and today it is caught only by the
  Phase-3 all-configs backstop (after the fact, not before acceptance) rather than the new step-5 gate.
- **Proposed change:** broaden the step-5 deterministic re-gate's trigger condition from
  "adversary-suggested sniper fix" to "any sniper fix" (drop the source-of-finding filter). The gate
  criterion itself (already-green frozen tests of completed tasks) does not need to change — only the
  condition that decides whether the gate runs. The step-5 prose was deliberately written so this is a
  one-line scope change.
- **Rationale:** two independent eyes (spec-adversary + plan-reviewer) converged on the same gap in the
  same run, which is the systemic-signal bar this file exists for. The narrower scope was kept
  deliberately for THIS PR (faithful-to-issue, minimal delta) and the broadening is recorded here plus
  as an explicit open risk in `spec.md` for the human to decide at PR review — not a silent gap.

### 2026-07-08 — orchestrating-delivery: Phase 3 does not re-anchor the new step-5 frozen-test-gate block by name

- **Observed:** `sniper-frozen-test-gate` added a named, deterministic re-gate block to Phase 2 step 5.
  Phase 3 (final dual review) already delegates its own frozen-test handling to "same rules as step 5"
  in prose, but that delegation predates this feature and does not explicitly re-anchor the new block —
  a reader auditing Phase 3 in isolation has to infer that "same rules as step 5" now also covers the
  frozen-test re-gate, rather than seeing it named. Flagged by the final-review adversary; no functional
  gap (Phase 3's all-configs backstop still exercises every frozen test regardless), purely a
  documentation-clarity residual.
- **Proposed change:** in `core/skills/orchestrating-delivery/SKILL.md` Phase 3, add a one-clause
  explicit reference to the step-5 frozen-test re-gate by name (e.g. "...same rules as step 5,
  including the frozen-test re-gate added for adversary-suggested fixes") so the delegation is
  self-documenting rather than requiring the reader to trace it back.
- **Rationale:** low-cost, improves auditability of a prose pipeline where the only enforcement is the
  prose itself being followed correctly; worth a one-line fix next time Phase 3 is touched rather than
  a dedicated PR on its own.

### 2026-07-08 — test-author: harden the frozen `sniper-frozen-test-gate.test.mjs` vacuous-predicate discriminator beyond the `intersect` token

- **Observed:** to avoid an unsatisfiable broken-red (per `fidelity-gate-misses-broken-red`), the new
  frozen test's FORBID assertion discriminates the vacuous `frozen_paths`-intersection gate criterion by
  requiring the token `intersect` co-located with `frozen_paths` on the gate line, rather than a
  section-wide "must not contain `frozen_paths`" check (which would false-positive on Phase 2's
  legitimate uses of `frozen_paths` as a manifest field name). This is correct for the current prose, but
  the discriminator is narrow: a future edit that re-introduces the same vacuous criterion using a
  synonym key phrase (e.g. "frozen_paths overlap" or "frozen_paths intersection" reworded without the
  literal substring `intersect`) would not trip this specific guard.
- **Proposed change:** when this frozen test is next touched (never edit it now — freeze integrity), widen
  the FORBID discriminator to a small synonym set co-located with `frozen_paths` on the gate line (e.g.
  `intersect|overlap|shares? (a )?path`), still scoped to the single gate line, not the whole section.
- **Rationale:** low severity (no known live instance of the synonym gap), but a real hardening
  candidate cheap to apply the next time a test-author touches this file; flagged by final-review, not
  actioned now to preserve frozen-test integrity.

### 2026-07-09 — CI/local gate divergence: `package.json` `scripts.test` globs only `core/`, but CI also runs `modules/`

- **Observed:** during `vitest-fresh-response-mock` (#108), the final adversary confirmed
  `.github/workflows/ci.yml` runs `node --test "core/**/*.test.mjs" "modules/**/*.test.mjs"`, but
  `package.json`'s `scripts.test` only globs `"core/**/*.test.mjs"`. So `npm test` — the command every
  local run and this repo's own `harness-repo-constraints.md` memory documents as "the only gate" —
  never exercises `modules/`. Confirmed live: `driveCrossFamily: enabled but headless-no-key =>
  passthrough` (`modules/codex-adversary/references/cross-family.test.mjs:50`) fails deterministically
  on the base commit `43a8f55` (pre-existing, not introduced by this PR) under a scrubbed env, and
  nobody had noticed because the local/`npm test` gate structurally cannot see it.
- **Proposed change:** align `scripts.test` with the CI glob —
  `"node --test \"core/**/*.test.mjs\" \"modules/**/*.test.mjs\""` — so the local gate and CI cannot
  diverge. Separately (not part of this proposal, tracked only as an observation): the
  `cross-family.test.mjs:50` failure itself still needs a fix, out of scope for `vitest-fresh-response-mock`.
- **Rationale:** a local gate that is narrower than CI is worse than no local gate — it gives false
  confidence ("`npm test` is green" while a real regression sits unexercised in `modules/`) until CI
  catches it on the PR, or — as happened here — doesn't get caught for an unknown number of merges
  because nobody diffed the two commands.

### 2026-07-09 — operational: re-vendor `.claude/` after a `core/` rule/agent merge, or flag the drift

- **Observed:** during `vitest-fresh-response-mock` (#108), the final review noted this repo's own
  git-excluded dogfood copies (`.claude/rules/testing-unit.md`, `.claude/agents/test-author.md`) stay
  stale after a `core/` rule/agent change merges — they still teach the pre-fix anti-pattern to any
  LOCAL run in this repo until someone manually re-vendors. Downstream projects are unaffected (they
  vendor from `core/` on their own `init`/update cadence); this is specific to this repo's own
  dogfooding loop.
- **Proposed change:** either (a) add a re-vendor step (`updating-harness` / `vendor-core.mjs`) to this
  repo's own release ritual, run right after a `core/` merge that touches `agents/`, `skills/`,
  `rules/`, or `hooks/`; or (b) add a lightweight drift check (diff `core/<path>` against
  `.claude/<path>` for the `FRAMEWORK_OWNED` categories) that warns — not blocks, since `.claude/` is
  gitignored and not part of any PR diff — when the two have drifted.
- **Rationale:** a stale dogfood copy silently defeats the very fix just merged, for every LOCAL
  session in this repo until someone happens to re-vendor. Low severity (headless/cloud and downstream
  projects are unaffected, and PR review already catches the `core/` side), but a small process gap
  worth closing.
### 2026-07-09 — orchestrating-delivery: descriptor-emitter and spawn-hand MUST run in separate Bash calls

- **Observed:** the PreToolUse entry-gate evaluates a Bash command as a whole. Chaining
  `node .../descriptor-emitter.mjs … && node .../spawn-hand.mjs …` in a SINGLE Bash call gets the
  entire compound command blocked before the emitter runs; `spawn-hand.mjs` then reads whatever
  `descriptor.json` was already on disk from a prior dispatch. Observed live during #109: a re-emit
  intended to change `task_id` never executed, and the gate read the stale descriptor, denying the
  dispatch with a confusing "fidelity-pass not stamped for `<task>-sniper`" message. This is the same
  one-command-per-Bash class already documented for `mark.mjs`, but it is not called out for the
  descriptor-emitter → spawn-hand pair.
- **Proposed change:** in `core/skills/orchestrating-delivery/SKILL.md`, next to the descriptor-emitter
  CLI block and the spawn-hand runnable-command block, state that the two MUST run in **separate Bash
  calls** — never chained with `&&`/`;`/pipe. Optionally add a cheap runtime guard: `spawn-hand.mjs`
  asserts the descriptor's mtime is newer than its own process start and fails with a clear
  config-error reason otherwise, so a stale-descriptor read is caught even if the mistake recurs.
- **Rationale:** the failure mode is silent and misleading — the operator sees a fidelity-rail denial
  naming a task id that no longer exists in the file they just tried to rewrite.

### 2026-07-09 — orchestrating-delivery: the sniper's task_id must be the executor's exact literal string

- **Observed:** the entry-gate's fidelity rail keys its `fidelity_pass` allowlist on the literal
  `${feature_id}/${task_id}` stamped when the locked test went RED. During #109 a sniper descriptor was
  drafted with a `task-1-sniper` qualifier — a natural way to distinguish the sniper's dispatch from the
  executor's — and was denied for a missing fidelity-pass, because that qualified id is never stamped.
  The fix was to reuse `task-1` verbatim. SKILL.md says the sniper's descriptor "carries `feature_id` and
  `task_id`" (Capture rail; step 5) but never says it must be the SAME literal string as the task being
  fixed, not a derived variant.
- **Proposed change:** add one sentence to the sniper dispatch section (step 5): "the sniper's `task_id`
  MUST be the identical literal string as the task it is fixing (never a suffixed/derived variant like
  `<task-id>-sniper`) — the fidelity rail's allowlist is keyed on that exact string."
- **Rationale:** an orchestrator reasoning "this is a distinct dispatch, I should distinguish it" walks
  straight into the trap; the denial message names an id the orchestrator just invented, which reads
  like a harness bug rather than a naming rule.

### 2026-07-09 — frozen doc-slicing helpers should track code fences

- **Observed:** #109's frozen gate `core/__tests__/pool-workers-fixture-rule.test.mjs` slices markdown
  sections with `sliceSection`/`headings` helpers that treat any line starting with `#` as a heading.
  `core/agents/test-author.md` contains `##`/`###` lines INSIDE the fenced "Formato de resposta" block.
  Inert today (those pseudo-headings sit after every sliced region), but a future reordering — or moving
  the response-format block above step 4 — would make the slicer capture the wrong section and flip the
  assertions spuriously. It could NOT be fixed in-run: the test was already frozen, and editing it
  post-freeze is a manifest violation.
- **Proposed change:** when a doc-content-pinning frozen test is next authored or legitimately touched,
  have `headings()`/`sliceSection()` carry an `inFence` toggle that flips on a line whose trim starts
  with a triple backtick, skipping lines while inside a fence. Consider promoting the pair to a shared
  reference helper so every doc-pinning gate inherits the fix.

### 2026-07-09 — codex-adversary: `--role plan-reviewer` merge output emitted `planner_instructions` as an array of single characters

- **Observed:** during `fleet-multi-repo` (#117) plan-review round 1, the `cross-family.mjs --role
  plan-reviewer` merge output's `planner_instructions` field arrived as an array of single characters
  (consistent with a string having been spread/iterated as if it were an array of items — e.g.
  `Object.values(aString)` or `[...aString]`) rather than the plain string the field's own JSDoc
  contract promises. This made the field unusable by any downstream consumer expecting prose. The
  `--role adversary` route does not exhibit this bug. Static inspection during this harvest of
  `modules/codex-adversary/references/merge-verdicts.mjs`'s `mergeVerdicts` (the function that actually
  builds `planner_instructions`, via `[claudeVerdict.planner_instructions,
  codexVerdict.planner_instructions].filter(Boolean).join("\n---\n")`) and of
  `driveCrossFamilyVerdict` in `cross-family.mjs` found **no spread/iteration of a string** on this
  path — both look correct on paper. The root cause was NOT isolated in this run; it is likely in a
  downstream consumer (e.g. how the orchestrator or a shell/`jq` step re-handles the CLI's JSON stdout
  for the verdict shape specifically), not in `merge-verdicts.mjs` itself.
- **Proposed change:** reproduce with a live `--role plan-reviewer` invocation and trace the field from
  `cross-family.mjs`'s `process.stdout.write(JSON.stringify(result, null, 2))` through to wherever the
  orchestrator consumes it (`orchestrating-delivery`'s plan-review step), since the bug is not in the
  merge function itself. Add a unit test on `mergeVerdicts` asserting `planner_instructions` is a
  `string` (not just truthy) to lock in that the merge layer stays correct once the real site is found.
- **Rationale:** a verdict-shaped cross-family checkpoint whose whole value is the
  `planner_instructions` field guiding a REVISE is silently defeated if that field is unusable — the
  plan-reviewer eye still gates correctly (APPROVE/REVISE), but the human/planner-facing guidance is
  lost. Low severity this run (round 1 already had `--role adversary`-shaped guidance to compensate,
  and round 3 converged to APPROVE), but worth fixing before a REVISE with real prose guidance is lost
  on a task where it's the only signal.

### 2026-07-09 — orchestrating-delivery: SKILL.md step order lets the sniper dispatch onto an uncommitted executor diff, contradicting `spawn-hand`'s dirty-tree refusal

- **Observed:** during `fleet-multi-repo` (#117) task-1, dispatching the per-task sniper required the
  orchestrator to COMMIT the executor's implementation diff first — `spawn-hand.mjs`'s `runLiveDispatch`
  refuses to spawn onto a tree that is dirty relative to the freeze baseline (`core/skills/
  orchestrating-delivery/references/spawn-hand.mjs:588`, "working tree is dirty relative to the freeze
  baseline — refusing to spawn"), and the sniper is dispatched via the SAME runnable command as the
  executor. But `SKILL.md`'s own numbered steps put **5. sniper** BEFORE **6-commit. impl-commit** ("
  after the task's gates are GREEN... the orchestrator COMMITS the production diff") — read literally,
  the prose has the sniper firing on step 5 while the executor's own diff from steps 1d–4 is still
  uncommitted, which `runLiveDispatch`'s precondition (step "Git-universe reconciliation (mandatory
  pre-spawn)", line ~296) would refuse. The orchestrator had to commit the implementation out of the
  documented step order to unblock the sniper dispatch.
- **Proposed change:** in `core/skills/orchestrating-delivery/SKILL.md`, either (a) reorder so the
  impl-commit happens BEFORE step 5 (sniper) whenever the fan-out produced any mapped issue — i.e. split
  step 6 into "commit the executor's diff before sniper dispatch" (a precondition of step 5, not a
  step-6 action) and "record the final commit state after sniper fixes land", or (b) if the intent was
  always for the sniper's fix to be folded into ONE impl-commit alongside the executor's diff (no
  separate freeze/commit needed for the fix), state that explicitly and clarify how the sniper's
  dispatch satisfies the dirty-tree precondition without the impl-commit having happened yet — the
  current text supports neither reading unambiguously.
- **Rationale:** an orchestrator following the numbered steps literally hits a `runLiveDispatch` config
  error at the sniper dispatch (dirty tree), which routes to a critical exception/config-error path
  rather than the intended sniper fix — a documentation gap that turns a normal per-task fan-out finding
  into an unplanned recovery.

### 2026-07-09 — cross-family: two independently-caught defects this run are concrete evidence of its value, not ceremony

- **Observed:** during `fleet-multi-repo` (#117), the Codex peer caught two things the Claude eye did
  not, in the SAME run: (1) at plan-review, that `reconcileFleet` always writes `projects[]`, so
  "absent `config.projects`" was never the legacy case, making a planned synthesis path incoherent with
  `list-worktrees.mjs`'s bare `for...of` — Claude's spec-adversary pass missed this; (2) at final
  review, the duplicate-project-name last-wins defect (a `Map` overwriting on a repeated project name
  while `listWorktrees` enumerates every entry undeduped) was independently found by BOTH eyes, but
  Codex rated it HIGH where Claude rated it MEDIUM — the higher rating is what routed the finding to
  the mandatory strong-eye re-gate, which then found a further null-entry crash the first eye missed.
  Symmetrically, Claude caught something Codex did not (a dedup test at `install-crons.test.mjs:1091`
  that was NOT an inversion target — over-inclusion would have taught the executor a false "was red"),
  so the value is bidirectional, not one-family-strictly-better.
- **Proposed change:** no code/prose change — this entry is a **retained-evidence record**, not an
  action item. When the module's cost (Codex CLI usage, extra round-trip latency) is next weighed
  against dropping it or making it opt-in-only, cite this run: two real defects surfaced only because
  of the second family, one of which (the HIGH-vs-MEDIUM severity gap) is what triggered a
  delivery-blocking re-gate that caught an additional crash bug.
- **Rationale:** the module's ROI is easy to lose sight of between incidents (it is invisible when it
  finds nothing) — an evidence trail across runs is the only defense against it being quietly dropped
  as ceremony during a future cost-cutting pass. This is the second independently-dated evidence entry
  for cross-family's value (see 2026-07-04 above, a different angle — failure-mode robustness rather
  than catch-rate), reinforcing rather than duplicating it.
- **Rationale:** low severity (no live instance), but the harness now has several frozen tests that pin
  markdown by heading slice — the hazard is shared, and each new copy re-inherits it.

### 2026-07-09 — fidelity gate: require a paired positive control for negative locked tests on a destructive path

- **Observed:** `retention-sweep-delete-stale-topics` (#178) task 6 shipped TWO production-dead
  wirings that passed the fidelity gate green: (1) a frozen test injected a fake `listObsRuns` with
  events already attached, while the real `defaultListObsRuns` returned no `events` key at all,
  making the undelivered-critical guard pass vacuously in production; (2) a frozen test's own fixture
  wrote a `sharedThreadId` field that `install-crons.mjs` never actually emits, so the blocklist would
  have been empty in production. Both are the `test-real-composition-root-binding` trap (see
  `core/memory/test-real-composition-root-binding.md`). Both were caught only because a reviewer
  demanded a positive control over the SAME real fixture/composition-root binding, on top of the
  negative-case assertion — the fidelity gate itself does not require this pairing.
- **Proposed change:** in the fidelity-check step (compliance eye, pre-freeze), add an explicit rule:
  for any locked test guarding a destructive/irreversible path, the test suite must include at least
  one assertion that drives the REAL composition-root seam (not an injected fake) end-to-end and
  confirms it produces the shape the guard expects — a "positive control" proving the wiring is live,
  paired with the negative case proving the guard blocks correctly.
- **Rationale:** the fidelity gate today validates that a locked test encodes the stated invariant and
  goes red before the fix, but it does not check that the test's injected seam matches what the real
  composition root actually returns. Two dead wirings shipping green in one delivery, both caught only
  by reviewer instinct rather than gate mechanics, is exactly the kind of hole the deterministic rail
  exists to close.

### 2026-07-09 — spawn-hand: 9-minute ceiling may be too short for `complexity: high` composition-root tasks

- **Observed:** in `retention-sweep-delete-stale-topics` (#178) task 6 (`reaper-composition-root`,
  severity high, complexity high), the `hand_tiers.high` Ollama hand (kimi) hit the 9-minute
  wall-clock ceiling mid-task and left broken partial state; the on-disk `FAILED` run-record correctly
  authorized a K=1 Claude fallback, which completed the task cleanly. This is distinct from the
  already-tracked untrusted-workspace stall (see the 2026-07-06 entry above) — this task's workspace
  trust may or may not have been the cause; the composition-root wiring itself (touching 6+ files,
  wiring 8 seams) is also plausibly just large enough to need more wall-clock time on a cheap-hand
  model than a narrower task.
- **Proposed change:** before widening the ceiling globally (which raises the cost of every stuck
  dispatch), first confirm whether this instance was the already-tracked trust-stall recurring, or a
  genuine time-budget shortfall. If genuine, consider a size/complexity-aware ceiling — e.g. a longer
  wall-clock budget specifically for `complexity: high` tasks, or a `scope_paths`-count heuristic —
  rather than a blanket increase.
- **Rationale:** the K=1 Claude-fallback safety net worked as designed here, so this is not urgent, but
  a `complexity: high` task is exactly the category most likely to need more than 9 minutes on a
  cheap-hand model, and each timeout burns the full ceiling before falling back.

### 2026-07-09 — orchestrator/planner: a sniper brief carrying literal suggested code must be labeled a sketch, not a patch

- **Observed:** in the same delivery, an orchestrator-authored sniper brief included its own suggested
  guard code, and that suggestion was itself wrong (`Number.isFinite(0)` is `true`, so the sketch would
  not have caught the `retentionDays: 0`/`null`/`""` coercion bug it was meant to fix — see
  `core/memory/vps-retention-sweep-fail-closed-guards.md`). The sniper hand had to re-derive the
  correct fail-closed check itself rather than trust the brief's literal.
- **Proposed change:** when an orchestrator (or planner) brief hands a hand/sniper literal example
  code as part of the fix instructions, the brief must explicitly frame it as a SKETCH to be verified
  against the actual defect, never as a patch to be applied as-is. Add a one-line convention to the
  orchestrating-delivery sniper-dispatch section.
- **Rationale:** a cheap hand under time pressure is more likely to trust and apply a literal code
  block verbatim than to independently re-derive correctness; a wrong sketch in the brief is worse
  than no sketch, because it looks authoritative.

### 2026-07-09 — cross-family: instrument mid-session `available:false` degradation so it's visible in the run record

- **Observed:** in `retention-sweep-delete-stale-topics` (#178), the cross-family (Codex) eye returned
  `available:false` on the per-task adversary and its re-gate for one task, despite
  `HARNESS_CODEX_ADVERSARY=1` and `codex` on PATH — and was available again for the feature-wide final
  review shortly after. It was ALSO available for the spec-adversary and all three plan-review rounds
  earlier in the same session. This pattern (available at the start and end, unavailable in the
  middle) looks like transient quota/rate exhaustion, not a config problem, but nothing in the run
  record makes that visible without manually reading findings — the checkpoint just silently ran
  Claude-only, exactly as the fail-open design intends, with no distinguishing signal from "module
  correctly absent" or "genuinely unavailable all session".
- **Proposed change:** when a checkpoint's cross-family hook fires and the eye reports
  `available:false`, have the checkpoint record (in the run's descriptor/finding, not just log output)
  whether cross-family was available earlier in the SAME session — so a mid-session flicker (likely
  quota) is distinguishable at a glance from a session-wide absence (likely config/module).
- **Rationale:** this is the same operator-visibility gap the existing 2026-07-04 cross-family entry
  raises for the outage case ("timed out, ran Claude-only") — this is the narrower mid-session-flicker
  variant of the same problem, worth closing alongside it rather than separately re-discovering it.

### 2026-07-10 — entry-gate/spawn-hand: eye-finding fixes have no Claude-fallback path under Ollama quota exhaustion

- **Observed:** in `exit-reason-capture` (#240), a sniper fix for an EYE finding (security/adversary)
  KEEPS an already-green frozen test green (the fix corrects behavior the test already encodes as
  passing, e.g. hardening a guard that a happy-path test doesn't exercise the gap in). `spawn-hand`
  treats a green locked-test gate as VACUOUS → exit 2 (config error), which is NOT a genuine
  FAILED/NOT_DONE run-record → the entry-gate's hand-routing branch DENIES the Claude Agent(sniper)
  fallback (it requires a genuine spawn failure record). With Ollama weekly quota exhausted (429, no
  reset this session), there was no way to ever produce that genuine failure — the eye-finding fix
  deadlocked. Compounding: the sniper spawn also config-errors on a dirty tree (fallback executor's
  work uncommitted during the eyes→sniper window), so it never even reaches the vacuous-gate check.
  WORKAROUND used: convert the eye finding into a NEW test-pinned RED assertion in a frozen test, so
  the executor fallback path gets a genuine red gate → 429 → NOT_DONE record → authorized Claude
  fallback (and the fix becomes regression-tested as a side benefit).
- **Proposed change:** allow the entry-gate to authorize a Claude Agent(sniper) fallback for
  green-keeping eye-finding fixes WITHOUT requiring a genuine FAILED locked-test record — e.g. a
  `sniper-fallback` ticket gated on a recent 429/rateLimited run-record for the same feature (detected
  via the existing run-record `rateLimited` field), since a green-keeping fix can structurally never
  produce a FAILED gate to authorize on.
- **Rationale:** the workaround (manufacturing a new red test to route around the vacuous-gate check)
  is rule-compliant and even leaves better test coverage behind, but it is indirection that exists only
  because the fallback gate has no path for "fix doesn't change red/green state, hand-dispatch is
  itself unreachable due to quota." A quota-aware fallback path removes the need to invent a red test
  purely as an entry-gate unlock mechanism.

### 2026-07-10 — creating-plans/fidelity: cross-check a frozen locked_test's exact FORMAT against other locked resolved_judgments

- **Observed:** in `exit-reason-capture` (#240), producer task 1's test 4 pinned an EXACT 4-token
  command-string tokenization for a fallback path (bare, unquoted path). The executor, to satisfy that
  frozen assertion, dropped `shellQuoteSingle(CRON_A_EXIT_PATH)` — which VIOLATED the SAME plan's
  `precreate_failure_fallback: byte-identical` resolved judgment (the fallback command must match the
  pre-existing byte-identical legacy form, which IS quoted). The fidelity gate passed test 4 (it
  faithfully encoded the assertion as written), but the assertion itself silently conflicted with a
  different locked decision in the same plan. Root cause: the test-author pinned a FORMAT detail (token
  count from a naive `.split(" ")`) instead of the SEMANTIC invariant (byte-identical to the legacy
  command). Resolved via a maintenance edit to test 4 (require the quoted form, re-freeze red→green)
  plus a sniper re-quote — a light-path re-gate, no deadlock, but it shipped once before being caught.
- **Proposed change:** add a fidelity-gate (or plan-reviewer) cross-check step: when a plan has 2+
  `locked_tests`/`resolved_judgments` touching the SAME code path or output artifact, verify the
  assertions are mutually compatible — specifically, a test pinning an exact string/token-count FORMAT
  must be checked against any co-located judgment pinning "byte-identical to X" or similar structural
  invariants, not just checked for internal self-consistency.
- **Rationale:** the fidelity gate today only verifies a locked test encodes ITS OWN pinned assertion
  faithfully — it has no mechanism to catch two locked tests/judgments in the same plan that pin
  mutually exclusive requirements on the same output. This is a second recorded instance of a
  format-pinned test overconstraining implementation (see the 2026-06-12 "locked_test must pin the FULL
  invariant, not a happy-path example" entry above) — this run's variant is cross-test conflict rather
  than single-test under-specification, worth tracking as a related but distinct failure mode.

### 2026-07-10 — test-author: surface the secret-shaped-fixture-fragmentation convention proactively (not just reactively)

- **Observed:** in `exit-reason-capture` (#240), two test files planted literal secret-shaped fixture
  tokens (`ghp_`, `sk-proj-`, `github_pat_`) to exercise `scrubSecrets` redaction, and both tripped the
  repo's own `scan-secrets-in-tree` locked-2 meta-test (which scans the whole tracked tree for
  ZERO findings) — caught only after the fact, fixed by fragmenting each token into ≤16-char
  concatenated string literals (see `core/memory/secret-shaped-fixture-fragmentation.md`, newly added
  this run). This is the same shape of gap as the existing vitest-pool-config memory nudge: a
  test-infra convention the test-author needs BEFORE writing the fixture, not after a locked-2 failure.
- **Proposed change:** when a task's scope involves writing a test fixture with a secret-shaped literal
  (heuristic: task touches `scrubSecrets`/redaction/secret-scanning logic, or `locked_tests` mention
  tokens like `ghp_`/`sk-`/`github_pat_`/JWT), inject the fragmentation convention into the test-author's
  brief proactively — the same mechanism the orchestrator already uses to inject the vitest-pool memory
  for test-runner config.
- **Rationale:** reactive discovery (write the fixture, fail locked-2, fix it) costs an extra round-trip
  every time a test-author touches this surface; the convention is narrow, mechanical, and fully
  known — a good candidate for proactive injection rather than repeated rediscovery.

### 2026-07-11 — orchestrating-delivery: `plan-reviewed` checkpoint has the same positional defect just fixed for `spec-adversaried`

- **Observed:** `spec-adversary-checkpoint` (#260) fixed the new `spec-adversaried` deterministic
  checkpoint in `core/skills/orchestrating-delivery/SKILL.md` after the final dual review's
  cross-family (codex) adversary caught it positioned AFTER HARD-GATE 1's HEADLESS stop-and-report
  branch — a BLOCK verdict with an unresolvable issue could read as "stop before emitting the
  marker," exactly the silently-skipped-checkpoint class this feature exists to prevent (see
  `core/memory/checkpoint-position-before-branching.md`). The light-path re-gate spot-check on that
  fix independently found that Phase 1's existing `plan-reviewed` checkpoint (around the
  "Deterministic plan-review checkpoint" paragraph) is placed AFTER HARD-GATE 2's own HEADLESS "stop
  and open an issue" branch — the exact same structural defect. #260's spec explicitly forbade
  touching the existing `plan-reviewed` marker (scope discipline), so this was recorded, not fixed.
- **Proposed change:** move the `plan-reviewed` checkpoint instruction (and its
  `node .claude/hooks/mark.mjs plan-reviewed ...` command) to fire immediately after the
  plan-reviewer returns its verdict (end of step 3, before HARD-GATE 2's prose and its HEADLESS
  stop/proceed branch) — mirroring the fix already applied to `spec-adversaried` in Phase 0.
- **Rationale:** worth its own small follow-up issue rather than folding into an unrelated feature,
  since it touches the same file the byte budget is already tight against (see
  `core/memory/orchestrating-delivery-skillmd-byte-budget.md`).

### 2026-07-11 — entry-gate: `#ac-1.3` fail-open assertion is polluted by the real `process.env`

- **Observed:** `isRoutineSession(env = process.env)` in `core/hooks/entry-gate.mjs` uses a JS
  default parameter. The test `#ac-1.3: isRoutineSession is fail-open (undefined env → false →
  allow)` (`core/hooks/entry-gate.test.mjs`) calls `isRoutineSession(undefined)` intending to
  exercise the "no env at all" case — but passing `undefined` triggers default-parameter
  substitution, so the call actually evaluates against the REAL `process.env` of whatever process
  runs the test, not a true undefined-env case. In any environment where
  `HARNESS_OBSERVABILITY_RUN_PATH` / `HARNESS_NOTIFY_PROJECT` / `CLAUDE_CODE_REMOTE` happen to be
  set (e.g. this VPS cron session's own observability plumbing for #260's run), the test's premise
  is never exercised and it fails — confirmed unrelated to #260's diff (file not in `scope_paths`,
  fails identically on `main`).
- **Proposed change:** exercise the true "no env" case with an explicit empty-ish object that
  cannot collide with default-parameter substitution — e.g. keep `isRoutineSession({})` for the "no
  markers" case (already covered) and, for the "no env object provided" contract, either (a) assert
  the function signature accepts zero args without throwing rather than asserting a specific
  env-dependent outcome, or (b) inject a sanitized empty env object instead of `undefined` and drop
  the "undefined env" framing from the assertion name.
- **Rationale:** `undefined` can never deterministically mean "no env" once a default parameter is
  involved. Low urgency (environment-triggered, not diff-triggered) but worth fixing so CI-suite
  parity stops showing a false `allGreen:false` on unrelated PRs run from a polluted shell.

### 2026-07-11 — mark.mjs: `--findings` accepts absurdly large exponential-notation integers (cosmetic, non-blocking)

- **Observed:** the final-review security eye on `spec-adversary-checkpoint` (#260) found that
  `mark.mjs`'s `spec-adversaried` validation (`Number.isInteger(n) && n >= 0`) accepts a literal
  like `--findings 1e21` — `Number("1e21")` is a mathematically whole number so `Number.isInteger`
  returns true, and it renders in exponential notation wherever the count is displayed/logged. No
  injection vector (internally-produced value only, escaped, any downstream string truncated to 80
  chars) — pure cosmetic annoyance, not fixed in #260 (low value/cost ratio, non-blocking SECURE
  verdict).
- **Proposed change:** tighten the bound with an upper ceiling sanity check (e.g. `n <= 10000`) or
  reject non-finite-safe integers (`Number.isSafeInteger` instead of `Number.isInteger`). The same
  pattern likely applies to any other marker taking a numeric `--n`/`--total`/`--findings` flag.
- **Rationale:** low priority — bundle with the next `mark.mjs` touch rather than a dedicated fix.

### 2026-07-12 — oc gate-state: `mergeGateStatePatch` validates dual-fields over the WHOLE merged state (self-brick risk when dual_status persistence is wired)

- **Observed:** while resolving PR #269 against a `main` broken by #270, the OC consumers
  (`core/opencode/plugin/lib/gate-state.mjs`, `loop-guard.ts`, `gate-state.test.mjs`) still imported the
  removed `applyGateStatePatch` — a broken ESM import → 4 red tests on `main` (the CI does not run on
  push-to-main, only on PRs, so #270's merge landed the break silently). Fixed by renaming the 3
  consumers to the new `mergeGateStatePatch`. Adversarial review confirmed no live call-site hits the
  OLD-vs-NEW semantic divergences (invalid-patch `{ok}` flip, non-marker array union-vs-replace,
  `dual_completed`/`dual_status` strict validation) — all callers pass scalars, marker arrays, or
  integer counters only.
- **Latent risk (not fixed — no live trigger today):** `mergeGateStatePatch` runs
  `validateGateStateDualFields` over `base ∪ patch`, i.e. the ENTIRE merged state read from disk. If any
  OC code ever persists `dual_completed` or an invalid `dual_status` into a gate-state file, then EVERY
  later merge — even a loop-counter increment or a fidelity stamp — begins returning `{ok:false}` and
  denies. Today unreachable: `dual-enforcement.mjs` only READS dual fields; nothing writes them via
  `mergeGateState`.
- **Proposed change:** when dual_status persistence is wired, force the write path through
  `dualStatusGatePatch` (enum-only) and never let a raw `dual_status`/`dual_completed` reach a
  gate-state file, or scope `validateGateStateDualFields` to the patch delta rather than the whole state.
- **Process gap:** add a `push: [main]` trigger (or a required merge-queue check) to `ci.yml` so a
  non-squash merge / direct push can't land a red `main` unseen — this is how #270 broke it.
