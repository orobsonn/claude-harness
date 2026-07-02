# Spec — Capture-verified gate hardening (real files over stamped memory)

**Date:** 2026-07-01
**Mode:** LIGHT (hardens existing hooks; no new subsystem)
**Status:** implemented on `docs/capture-verified-gate-hardening-spec`, tests green (392/392) —
awaiting operator sign-off on the "Known limitation" section below before PR/push

## Problem

`hand_finished` / `capture_verified` are the anti-self-certification rail for cheap-hand
(Ollama executor/sniper) dispatches: no delivery command may run while a finished hand's
output has not been independently captured. Today both markers are **manually stamped** by
the orchestrator via `mark.mjs`, in prose-instructed steps (`SKILL.md`), and only
cross-checked at the very last moment — `git push` / `gh pr create` / `gh pr merge`
(`entry-gate.mjs`, `decideBash`, `isDeliveryCommand`).

### Trigger incident (victor-pipeline-dados-bot, `m4-fup-pipeline`, 2026-07-01)

The orchestrator dispatched 5 cheap-hand runs via `spawn-hand.mjs`. It stamped
`hand-finished` for 1 of 5 and never stamped `capture-verified` for any of them. The push
gate caught the gap only because the 5th dispatch happened to have `hand-finished` without
`capture-verified` — if that 5th stamp had also been skipped, the array-diff check
(`hand_finished` vs `capture_verified`) would have found **nothing to flag**, because
`gate-state.json` would never have known those dispatches existed at all. By the time the
gap surfaced, HEAD had advanced past every dispatch's `freeze_commit_sha`, so
`capture-hand.mjs` (which requires `HEAD === freezeCommitSha`) could no longer run
retroactively. Resolved via explicit operator sign-off (`AskUserQuestion`) + manual backfill
of the markers, documented in that project's `.claude/kaizen.md` (commit `2af9662`) as a
"proposed" structural gap.

### Two compounding gaps

1. **The producer marker (`hand-finished`) has no other consumer and is 100% prose-driven.**
   Nothing in the codebase writes it except the orchestrator remembering a CLI call. A
   session where it's never stamped leaves `gate-state.json` blind to that dispatch — the
   delivery gate has nothing to diff against.
2. **The consumer check only fires at delivery time**, not at each commit. By the time it
   denies a push, HEAD has typically moved many commits past the point where independent
   capture was still technically possible, forcing a human escalation instead of a clean,
   mechanical block-and-fix.

## Scope

**In:** `entry-gate.mjs` delivery-gate hardening, `gate-lib.mjs` hand-record path
reorganization + new read helpers, `stamp-triage.mjs` cross-validation of the
`capture-verified` marker against the real on-disk run-record before it writes anything
permanent.

**Out:** a consolidated run/cost SQLite store (raw ingredients — `cost.ndjson`,
`derisk-metrics.mjs` — already exist per-dispatch but are discarded; persisting them across
runs for analysis is a separate, larger initiative and gets its own brainstorm/spec. Also
out: any change to the live-dispatch security model (token handling, redaction,
`dispatchHand`) — untouched by this spec.

## Adversarial review summary

A devil's-advocate pass (mandatory per `core/CLAUDE.md` § Adversarial posture) attacked the
first draft of this design, which proposed deriving `hand-finished`/`capture-verified`
automatically by having a `PostToolUse[Bash]` hook parse `spawn-hand.mjs`'s stdout. That
draft is **rejected**. Findings:

1. **Forgeable, and worse than the status quo.** Any Bash command whose *text* resembles a
   `spawn-hand.mjs --descriptor ...` invocation, echoing a plausible JSON blob, would trip
   the same auto-stamp — collapsing two independently-guarded markers into one forgeable
   event, and (in the draft's proposal to also write the permanent run-record) letting a
   forged Bash command **fabricate permanent audit evidence for a dispatch that never ran**.
   This is exactly the self-certification failure mode the whole rail exists to prevent, and
   contradicts the codebase's own established pattern for load-bearing checks: read the real
   file (`readHandRecordFn`, already used for the K=1 escalation gate), never trust echoed
   text.
2. **No distinction between "FAILED because the test didn't pass" and "FAILED because the
   hand wrote outside its scope."** Auto-stamping either the same way removes the one place a
   human currently (in principle) looks at scope/frozen violations before proceeding.
3. **Confirmed parsing bug, not just a risk.** `spawn-hand.mjs` pretty-prints its JSON
   (multi-line); `stamp-triage.mjs`'s existing parser reads one JSON object per line. The
   auto-stamp draft would not have worked as written.
4. **Unbounded directory + per-commit `git merge-base` calls scale badly.**
   `hand-records/` is never archived; gating on every `git commit` (not just delivery
   commands) multiplies a growing, un-scoped glob by every commit in the session.
5. Gating every `git commit` (vs. only delivery commands) has a much larger blast radius for
   false positives — it can stall an entire session, not just the final push, with no
   documented escape valve once the manual marker path is deprecated.

**Verdict:** keep the manual marker as the human checkpoint (it is not the failure mode that
needs fixing), but stop trusting it blindly, and stop relying on it being the *only* signal
the delivery gate has. Read the same non-forgeable file the K=1 escalation gate already
trusts. Fixes below reflect this.

## Design

### 1. Hand-records get a home

Today: flat `.claude/plans/.state/hand-records/<feature_id>__<task_id>.json`, never
archived (one project already has 34 loose files, one 1.1 MB). New layout:

```
.claude/plans/.state/hand-records/<feature_id>/<task_id>.json
```

`gate-lib.mjs`'s `handRecordPathFor(qualifiedId)` changes to build this nested path; a new
`listHandRecordsForFeature(featureId)` helper lists only that feature's directory (bounded,
not a repo-wide glob). Old flat files from already-vendored projects are left in place,
untouched and unread by the new code — no migration needed for correctness (they're inert
once nothing reads that path shape), and can be swept manually.

### 2. Delivery gate reads the real file, not just the session stamp

`decideBash`'s existing push/PR/merge check keeps the `hand_finished`/`capture_verified`
array-diff (cheap, already correct when the markers exist) and **adds** a second,
independent check: for the current feature (resolved via `gate-state.json`'s `feature_id`
field — already stamped on every classify/reclassify by `resetGateState`, not `triage.json`,
which `decideBash` does not read today), list its hand-records; for each one whose `outcome.status === "DONE"` and whose `freezeCommitSha` is
an ancestor-or-equal of current HEAD (`git merge-base --is-ancestor`, scoping out abandoned
branches so old work never false-positives a later, unrelated feature), require a
`capturedVerifiedAt` field on that same file (see #5). Missing it → deny, same message
family as today's `capture_verified` denial. This closes gap #1: even a dispatch whose
`hand-finished` stamp was **never written at all** is still caught, because the run-record's
mere existence (written unconditionally by `spawn-hand.mjs`, independent of any manual step)
is what's being checked — not a manually-populated array.

### 3. Scope/frozen violations are a hard stop, never a silent pass

`evaluateRun`'s `FAILED` outcome can mean "the locked test didn't pass" or "the hand wrote
outside `scope_paths`/touched a frozen path" (`scopeViolations`/`frozenViolations` non-empty).
The delivery-gate deny message for a record carrying non-empty violations is a **distinct,
explicit message** ("independent capture found the hand wrote outside its permitted scope —
this requires a human decision, not a re-run") — never folded into the generic
"needs capture-verified" wording, and never satisfiable by simply stamping
`capture-verified` after the fact.

### 4. Earlier detection without gating every commit

Rejected: gating every `git commit` (adversarial finding #4/#5 — blast radius too large, no
escape valve). Instead, the same real-file check from #2 also runs as a best-effort trigger
on the next `spawn-hand.mjs` dispatch's freeze-commit (a git commit whose message matches
`test(...): freeze locked tests for ...`) — string-matched, so it's advisory-early, not
authoritative. The push/PR/merge gate in #2 remains the single **mandatory** enforcement
point; the freeze-commit trigger is a convenience that, when it fires, catches the gap one
task sooner instead of five.

### 5. The manual marker stays, but stops being blindly trusted

`mark.mjs capture-verified` keeps its documented, prose-instructed role — it is the
operator-facing checkpoint, not the thing being replaced. What changes is `stamp-triage.mjs`:
today it appends the qualified id to `gate-state.json`'s `capture_verified` array purely
from the echoed marker text (guarded only by `hand_finished` already containing that id).
It now **also** reads the real hand-record file for that qualified id
(`readHandRecordFn`) before writing anything, and:
- if the file doesn't exist → the marker is a no-op (same "never pre-authorize" spirit as
  the existing `hand_finished` guard) — a forged `mark.mjs capture-verified` echo with no
  real dispatch behind it writes nothing.
- if it exists → stamps `capturedVerifiedAt: <ISO timestamp>` directly onto that permanent
  file (in addition to the existing session-scoped array append), so the audit trail survives
  session restarts/compaction — closing the session-scoped vs. permanent-scoped asymmetry
  that made the original incident hard to recover from mid-session.

## User journeys

- **#uj-1 (happy path):** orchestrator dispatches executor, later runs `capture-hand.mjs` +
  `mark.mjs capture-verified` as documented. `stamp-triage.mjs` cross-checks the real record,
  finds it, stamps `capturedVerifiedAt`. Push gate passes on the first check (array-diff).
- **#uj-2 (forgotten marker, caught early):** orchestrator dispatches, forgets both markers,
  and later commits the next task's freeze-commit. The freeze-commit trigger (#4) fires,
  denies with a clear reason naming the specific `feature/task`, HEAD is still one commit
  away from the freeze baseline — recoverable without escalation.
- **#uj-3 (forgotten marker, missed until push):** same as #uj-2 but the freeze-commit
  trigger's string-match didn't fire (e.g. a non-standard commit message). The push gate's
  real-file check (#2) still denies — `hand_finished` was never even stamped, but the
  hand-record's existence alone is enough to deny. Operator escalates (as today), but now
  with a precise, code-verified list of exactly which tasks are unresolved, from a source
  that cannot itself have been skipped by omission.
- **#uj-4 (scope violation):** a hand writes outside `scope_paths`. The record shows
  `scopeViolations` non-empty. The push gate denies with the distinct hard-stop message from
  #3, never resolvable by re-stamping `capture-verified`.
- **#uj-5 (forged marker attempt):** an untrusted Bash command echoes text resembling a
  `mark.mjs capture-verified` marker for a `feature/task` that never actually dispatched.
  `stamp-triage.mjs` finds no real hand-record file for that id and writes nothing —
  the forgery has no effect.

## Acceptance criteria

- **#ac-1** `handRecordPathFor` and the writer in `spawn-hand.mjs` use the nested
  `<feature_id>/<task_id>.json` layout. `gate-lib.mjs` exposes
  `listHandRecordsForFeature(featureId)`.
- **#ac-2** `decideBash`'s delivery-command branch denies when any hand-record for the
  current feature has `outcome.status === "DONE"`, `freezeCommitSha` an ancestor-or-equal of
  HEAD, and no `capturedVerifiedAt` — independent of whether `hand_finished`/
  `capture_verified` arrays exist at all in `gate-state.json`.
- **#ac-3** A hand-record with non-empty `scopeViolations` or `frozenViolations` produces a
  distinct deny message and is never satisfied merely by a later `capture-verified` stamp.
- **#ac-4** A `git commit` whose message matches the freeze-commit convention triggers the
  same real-file check as #ac-2, best-effort (string-match, not authoritative — #ac-2 remains
  the mandatory gate).
- **#ac-5** `stamp-triage.mjs`'s `capture-verified` handler reads the real hand-record file
  before writing; a missing file is a no-op (writes nothing to `gate-state.json` or the
  hand-record); an existing file gets `capturedVerifiedAt` written onto it, in addition to
  today's `gate-state.json` array append.
- **#ac-6** Any infra error in the new checks (unreadable dir, git probe failure, malformed
  JSON) fails open on the *new* branch only — the existing array-diff check (already fail-
  open-safe) is untouched and still runs.
- **#ac-7** Old flat `<feature_id>__<task_id>.json` records from already-vendored projects
  are never read by the new path builder and never cause a false positive or a crash.

## Resolved product decisions

- **No stdout-parsing automation.** Rejected after adversarial review — forgeable, and
  contaminates permanent evidence. (this spec)
- **Not gating every `git commit`.** Rejected — blast radius too large, no escape valve.
  Freeze-commit is a best-effort early trigger; push/PR/merge stays the mandatory gate.
  (this spec)
- **Manual `mark.mjs capture-verified` step stays in the documented protocol** as the
  operator-facing checkpoint — it is cross-validated against real files now, not removed.
  (this spec, adversarial finding #6)
- **Run/cost SQLite analytics is a separate initiative**, not bundled into this fix — gets
  its own brainstorm and spec. (operator, this session — sequencing default; operator did not
  respond to the explicit sequencing question within the session, so this default proceeds
  per auto-mode guidance and can be revisited)

## Constraints

- All new logic in `core/hooks/` and `core/skills/orchestrating-delivery/references/`: Node,
  no external deps, fail-open on infra error / fail-closed on gate decision (existing
  convention).
- Harness language convention: English artifacts; operator-facing messages stay pt-br
  product-language (unaffected — these are deny-reason strings read by the orchestrator
  model, in English like the rest of the gate's messages).
- No change to the live-dispatch security model (token handling, redaction, capture logic
  itself) — this spec only changes *who reads what, when* for the verification stamp.

## Affected artifacts

- Edit: `core/hooks/lib/gate-lib.mjs` (`handRecordPathFor` nested path,
  `listHandRecordsForFeature`), `core/hooks/entry-gate.mjs` (`decideBash` real-file check +
  scope-violation hard-stop + freeze-commit trigger), `core/hooks/stamp-triage.mjs`
  (`capture-verified` handler cross-validates against real file, writes
  `capturedVerifiedAt`), `core/skills/orchestrating-delivery/references/spawn-hand.mjs`
  (write to nested path).
- Docs: `core/skills/orchestrating-delivery/SKILL.md` (reflect that `capture-verified` is now
  cross-validated, not blindly trusted; note the freeze-commit early trigger).

## Known limitation (found by post-implementation adversarial review — NOT closed by this spec)

A second adversarial pass, run against the actual implementation (not just the design), found
and **proved with a working PoC** that the "real on-disk run-record" this spec relies on as the
non-forgeable source of truth is **itself forgeable** — by the same actor (the orchestrator) that
could already forge the old marker-echo, using the same missing control: **nothing gates the Bash
tool from writing directly into `.claude/plans/.state/hand-records/**`.** `plan-write-gate.mjs`
denies the `Write`/`Edit` tools from touching that path, but has no Bash-tool equivalent, and the
settings baseline already allows `Bash(cat:*)`, `Bash(echo:*)`, `Bash(tee:*)`, `Bash(cp:*)`,
`Bash(mv:*)`, `Bash(sed:*)` without a permission prompt — any of which can write a JSON file with
the right shape (`outcome.status: "DONE"`, empty violation arrays, a `capturedVerifiedAt`, and a
`freezeCommitSha` equal to current HEAD) and the delivery gate allows it through, with **zero**
genuine `spawn-hand.mjs` dispatch ever having run.

**What this spec still achieves despite this:** the original incident was the orchestrator
**forgetting** to stamp anything — an accidental omission, not deliberate forgery. Before this
change, that omission left `gate-state.json` with no record of the dispatch at all, and the
delivery gate had nothing to compare against. After this change, the delivery gate always has
*something* to check (the run-record's mere existence, from every genuine dispatch, unconditional)
— raising the bar from "do nothing and the gate has nothing to catch" to "actively fabricate a
plausible multi-field JSON file naming the right feature/task/SHA," which is a categorically
different (and far less likely to happen by accident) failure mode. **What it does NOT achieve:**
protection against a deliberately adversarial or confused orchestrator choosing to fabricate that
evidence on purpose. That property was never actually true of the pre-existing marker-based rail
either (the old `stamp-triage.mjs` marker-echo was equally forgeable by the same actor via the same
missing Bash write-gate) — this spec does not make that pre-existing gap worse, but it also does not
close it, despite some of this spec's own language ("the marker alone is not authoritative")
reading as if it does.

**Recommended follow-up (separate spec, not bundled here):** closing this for real requires either
(a) a Bash-tool write-gate for `.claude/plans/.state/**` analogous to `plan-write-gate.mjs` — hard
to do robustly by pattern-matching Bash command text (arbitrarily many ways to write a file via
shell), or (b) a cryptographic approach — e.g. `spawn-hand.mjs` HMAC-signs the run-record with a
key that never reaches the model's context (env-only, like the Ollama token), and the gate verifies
the signature on read, so a Bash-written file without the correct signature is inert regardless of
its JSON shape. This is a genuinely harder, higher-stakes design question than the rest of this
spec and deserves its own dedicated brainstorm + adversarial review before implementation.

## Follow-up (parked, not in this spec)

- **Run/cost consolidated analytics.** `cost.ndjson` (per-dispatch, ephemeral) and
  `derisk-metrics.mjs` (pure parser, output currently discarded) are the existing raw
  ingredients. Operator wants this persisted locally (SQLite or similar) across runs for
  consolidated analysis (time per task, cost per tier, error rates) to inform model-tier
  decisions over time. Needs its own brainstorm: where the store lives (per-project vs.
  global), schema, write trigger (per-dispatch vs. end-of-run), retention.
