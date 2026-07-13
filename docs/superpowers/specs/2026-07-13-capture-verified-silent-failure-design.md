# Spec — capture-verified silent failure (#291)

**feature_id:** `capture-verified-silent-failure`  
**mode:** light  
**issue:** #291  
**date:** 2026-07-13  
**status:** revised after dual-adversary primary (ADV-291-01/02/03)

## Product outcome (honest framing)

Make every **non-success** path of `mark.mjs capture-verified` **loud but non-blocking**,
with **correct remediation text** — so maintainers are not left in 100% silence, and the
orchestrator is not told to re-run a command that cannot heal.

When both preconditions hold (hand_finished + real hand-record), the stamp continues to
persist a sha-qualified entry (happy path already works on main — regression-documented,
not the primary ship claim).

**Not claimed by this fix:** unblocking delivery when guards correctly fire (missing
hand_finished / missing hand-record). That remains fail-closed by design. Structural
delivery safety for green captures is already `#89` `capturedVerifiedAt` on the run-record
(real-file rail); this marker is the session-array belt.

## User journeys

- **#uj-1 (regression belt):** given real hand-record + task in `hand_finished`,
  `mark.mjs capture-verified` with a realistic PostToolUse payload still lands a
  **sha-qualified** `capture_verified` entry when HEAD sha is available.
- **#uj-2 (primary ship):** if stamp does not land, maintainer sees **why** with
  **actionable** remediation (not “re-run capture-verified” when preconditions failed).

## Acceptance criteria

- **#ac-1.1 (happy-path regression):** given real hand-record + id in `hand_finished`,
  realistic object-shaped `tool_response.stdout` payload → when `headShaFn` returns a sha,
  `gate-state.capture_verified` contains `<feature>/<task>@<sha>`. When HEAD unavailable,
  either unqualified fallback or no absolution is **documented as fail-safe** (does **not**
  clear delivery via `matchesAbsolution`) — not claimed as “delivery unblocked”.
- **#ac-1.2:** regression test(s) that **fail on current main** and **pass after** fix —
  pin silent no-op / silent catch root causes (R1+R2).
- **#ac-1.3:** CLI `catch` around `handle(payload)` emits non-blocking stderr diagnostic;
  exit 0 preserved (fail-open).
- **#ac-1.4:** fail-closed preserved — forged capture-verified (no hand_finished and/or no
  hand-record) still does **not** stamp; entry-gate / real-file rail untouched.
- **#ac-1.5 (new — ADV-291-01):** precondition failures MUST NOT return `{ readBackOk: false }`
  and MUST NOT trigger the generic “read-back failed… Re-run mark.mjs” nudge. Distinct
  return shape + distinct diagnostic/nudge text with real remediation.

## Investigation evidence (file:line)

### Decide path
- `stamp-triage.mjs:503-522` — decide capture-verified; qualifies `feature/task`.
- `stamp-triage.mjs:254-257` — main-loop only.
- `stamp-triage.mjs:67-74` — unwrapStdout string | `{stdout,stderr}`.

### Handle path (unique dual guards)
- `stamp-triage.mjs:930-965`:
  1. no-op if not in `hand_finished` (936-937) — **silent** today
  2. no-op if `readHandRecord === null` (943-944) — **silent** today
  3. markCapturedFn + sha-qualified merge + read-back

### CLI entry
- `stamp-triage.mjs:1070-1075` — empty catch around handle — **silent** today
- `stamp-triage.mjs:1100-1107` — read-back-failed nudge only on `readBackOk === false`
  (text assumes a write was attempted — unsafe to overload for guards)

### Paths
- Producer `spawn-hand.mjs:755-757` and consumer `gate-lib.mjs:126-130` match
  `hand-records/<feature>/<task>.json`.

### Controlled repro (main)
| Case | Result |
|---|---|
| both guards + string/object payload | stamp lands |
| missing hand_finished / hand-record | silent no-op |
| forced throw in CLI handle | exit 0, empty stderr |

## Root-cause ranking

| Rank | Hypothesis | Pins |
|---|---|---|
| **R1** | Silent intentional no-op guards (unique to capture-verified) | #uj-2, #ac-1.2 |
| **R2** | Silent CLI catch | #ac-1.3, #ac-1.2 |
| **R3** | Happy path already works when guards pass | #ac-1.1 regression only |

## Design (minimal) — revised after ADV-291-01/02/03

### Code (`stamp-triage.mjs` only)

1. **CLI catch diagnostic (#ac-1.3)**  
   Tiny helper `failOpenDiag(scope, err)` → `console.error` one line. CLI catch calls it.
   Keep `process.exit(0)`. Do **not** mass-annotate every catch (#297 anti-pattern).

2. **capture-verified precondition failures (#uj-2, #ac-1.5)**  
   When guard 1 or 2 fails:
   - stderr: reason + qualified id + **real remediation**  
     - no-hand-finished → `stamp hand-finished first for <id>; do not re-run capture-verified alone`  
     - no-hand-record → `no hand-record on disk for <id> (dispatch never wrote run-record); capture-verified cannot authorize`
   - return **distinct** shape: `{ ok: false, reason: 'no-hand-finished' | 'no-hand-record' }`  
     **NOT** `{ readBackOk: false }` (that stays write-failure-only).
   - CLI nudge branch: if `handleResult?.ok === false && handleResult.reason`, emit
     **precondition** additionalContext (remediation above) — separate from read-back-failed.
   - **Do not stamp.** Fail-closed preserved.

3. **readBackOk:false** remains only for real post-write presence / durable-stamp failures
   (existing path at 959-964).

4. Non-goals unchanged: no entry-gate edit, no guard removal, no #297 reapply.

### Tests (`stamp-triage.test.mjs`)

| Test | Fails on main? | AC |
|---|---|---|
| handle: no hand-record → no stamp + `{ok:false, reason:'no-hand-record'}` (not readBackOk:false) | YES | #ac-1.2, #ac-1.5 |
| handle: no hand_finished → no stamp + `{ok:false, reason:'no-hand-finished'}` | YES | #ac-1.2, #ac-1.5 |
| CLI/unit: failOpenDiag / catch path emits stderr, exit 0 | YES | #ac-1.3 |
| CLI: precondition result does **not** emit “Re-run the mark.mjs” read-back text | YES (after wiring) | #ac-1.5 |
| happy path + headShaFn → sha-qualified entry | documents #ac-1.1 | #ac-1.1 |
| forged still no stamp (existing) | green | #ac-1.4 |

### Implementation note for #ac-1.3 RED
Export or unit-test `failOpenDiag` + a thin `runCliHandle(payload, { handleFn, writeStderr })`
used by CLI entry so tests inject `handleFn: () => { throw new Error('boom') }` without
subprocess monkeypatch. Prefer minimal extract over source-string asserts.

## Demo
1. Both guards + sha → entry lands sha-qualified  
2. Missing hand_finished → no stamp + precondition diagnostic (not re-run text)  
3. Missing hand-record → no stamp + precondition diagnostic  
4. Forged still denied (#ac-1.4)  
5. Forced throw → stderr diagnostic, fail-open  
6. `node --test core/claude-code/hooks/stamp-triage.test.mjs` green  

## Adversary primary findings disposition
- **ADV-291-01 (critical):** ACCEPTED — design revised: distinct return + nudge (#ac-1.5)
- **ADV-291-02 (high):** ACCEPTED — product framing corrected; #ac-1.1 is regression belt
- **ADV-291-03 (medium):** ACCEPTED — #ac-1.1 split; unqualified = fail-safe not success

## Non-goals
- Re-apply PR #297; weaken entry-gate; OC rewrite; #282/#268/#128/#79; remove guards

## Dual adversary disposition (final)

| Finding | Family | Severity | Disposition |
|---|---|---|---|
| ADV-291-01 readBackOk overload → retry thrash | primary | critical | **fixed in design** (#ac-1.5) |
| ADV-291-02 product overclaim | primary | high | **fixed in design** (honest framing) |
| ADV-291-03 unqualified ≠ delivery clear | primary | medium | **fixed in design** (#ac-1.1 split) |
| ADV-OAI-291-01 any-record not DONE-only | secondary | high | **residual accepted** — pre-existing; #291 scope is silent failure diagnostics, not tightening DONE precondition. Separate issue if desired. |

**dual_status:** both  
**spec gate:** CLEAN with residual ADV-OAI-291-01 accepted (honest, out of S-scope)
