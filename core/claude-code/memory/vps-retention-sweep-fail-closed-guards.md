---
name: vps-retention-sweep-fail-closed-guards
description: "[RETIRED ENGINE] Fail-closed guard patterns first paid for in the retired VPS retention sweep (#807 deleted the engine) — the five traps generalize to ANY destructive/irreversible sweep: numeric config coercion, opts propagation, ambiguous-empty seam results, unreadable-vs-empty readers, and positional-index invalidation on truncate."
metadata:
  type: project
---

**Why:** `retention-sweep-delete-stale-topics` (#178) added the first Telegram-`deleteForumTopic`
irreversible path in the VPS reaper. Five distinct fail-OPEN defects were found and fixed across
review rounds, all in the same shape: a value or a seam result that reads as "safe to proceed" in
the exact case where the real answer is unknown. That reaper was **[RETIRED ENGINE]** — `core/vps/`
was deleted in #807 (see `docs/vps-retirement.md`) — but the five traps are properties of values and
seams, not of that codebase: any future destructive/irreversible path (a delete, a purge, a
bulk-archive, an auto-merge) re-derives them unless they are checked explicitly.

**How to apply:**

- **A destructuring default only substitutes for `undefined`.** `Number(null) === 0` and
  `Number("") === 0` are both finite and non-negative, so `function f({ retentionDays = 7 } = {})`
  does NOT catch `retentionDays: null` or `retentionDays: ""` — they pass through as `0`, collapsing
  a 7-day retention window to "delete anything closed at all". Any numeric value that arrives from
  config/CLI/persisted-JSON on a destructive path must be validated explicitly (`typeof === 'number'
  && Number.isFinite(x) && x >= 0`) and reject `null`/`""`/non-numeric text/`NaN` — never rely on a
  destructuring default alone. An invalid guard value must KEEP the gate closed (tighten), never
  relax it.
- **Pass the RESOLVED options object to every helper, never the raw caller-supplied `opts`.** In this
  feature the entry function destructured defaults into locals, but `isDeletable`/`deleteCandidate`
  re-destructured from the raw `opts` — so an omitted `retentionDays` never reached the locally-computed
  default at all. Build one `resolvedOpts` object after validation and thread that object everywhere;
  never let a downstream function re-read the original unvalidated input. Locked tests that always
  inject explicit values hide this class of bug — a test omitting the optional field, on the exact
  destructive branch, is the only way to catch it.
- **A normalized `gh`-wrapping seam (`gh-exec.mjs:normalizeGhResult`) returns `[]` for a `--json` call
  on BOTH a `gh` outage and a genuine empty result.** No probe built on that normalized seam can ever
  distinguish "nothing to report" from "could not ask" — so it can never authorize a destructive
  action. Any destructive-path probe over `gh` must use the RAW spawn seam (which exposes
  `status`/`error`) and fail OPEN (treat "could not ask" as "assume yes, don't delete") on that path.
  See `mainReaper`'s `makeDefaultPrOpen`/`makeDefaultPrOpenViaGh` for the concrete precedent (that
  precedent lived in the retired engine; the RULE — a destructive probe must read a seam that can say
  "could not ask" — is what carries over): production never injected the `gh`-based probe, so it
  always fell through to the raw-spawn default.
- **A log/events reader that returns `[]` for "unreadable" and `[]` for "genuinely empty" makes both
  ambiguous downstream.** `readEvents` returning `[]` for a corrupted/unreadable events log vacuously
  satisfies both an "all criticals acknowledged" guard and a "drain cursor caught up" guard — an
  unreadable log looked identical to a fully-drained one. On a destructive path, an unreadable log
  must drop the candidate (skip, do not delete), not fall through to the empty-array happy path.
- **A positional-index field (`meta.criticalSent` holding indices into an events JSONL) is invalidated
  by any truncate of that log.** Any code path that truncates/rotates the log must reset the
  positional-index field in the SAME logical operation, and the truncate must happen BEFORE the
  meta write that reflects the reset — a concurrent process reading the reset meta against the
  still-intact old log will re-derive stale (now-wrong) indices and can re-send or re-suppress
  events it shouldn't. See `createRun`'s `awaiting-review` reuse branch in
  `core/shared/lib/obs-outbox.mjs`.
