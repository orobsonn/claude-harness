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
