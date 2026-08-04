# RESERVED — `mark delivery-complete` autonomy stop (not implemented)

**Status:** reserved alternative — **do not implement** unless the minimal idle-stop
(`final_review_done` → `decideAutonomyContinuation` returns `none`) proves insufficient in production.

**Date:** 2026-08-04  
**Context:** infinite autonomy tick after LIGHT/FULL runs (victor-bot lead-frio / rita; gestao).

---

## What shipped instead (minimal)

Idle motor stops when gate-state already has `final_review_done: true`.  
no-ceremony / QUICK never enter the multi-phase idle loop.  
Stuck `autonomy_continuation` claims are cleared when decide is `none`.  
Harvest/ship remain same-turn prose after `mark final-review`.

See: `core/opencode/plugin/lib/autonomy-controller.mjs` (`decideAutonomyContinuation`).

---

## Reserved design (operator proposal)

If the minimal stop fails (e.g. model consistently idles after final-review without harvest/ship,
and operator follow-up is not acceptable), revive this shape:

1. New privileged `mark` action: `delivery-complete` (zero extra args; identity from envelope).
2. Host checklist = **existing** gate ticks only (mode-aware):
   - classified + mode
   - LIGHT/FULL ceremony: `brainstormed`, `adversary_fired` when applicable
   - `planner_status === usable` + `plan_review_verdict === APPROVE` when plan path applies
   - every plan task in `hand_finished` + `capture_verified`
   - unmatched `regate_pending` cleared
   - `final_review_done` when required
3. On pass: stamp **`autonomy_directive: "completed"`** (do **not** overload retention
   `session_status: "completed"` — that field races with `session.updated` reopen and 7d cleanup).
4. On fail: `ok:false` + missing ticks; agent repairs and retries. No auto-stop on idle alone.
5. Prose: call only after harvest + authorized ship (or accept early-stop residual).
6. build-only (same pattern as `capture-verified`); clear `autonomy_continuation` on success;
   refuse when `product_decision_pending`; do not re-enable completed via casual autonomy phrases
   without an explicit reopen directive.

### Adversarial constraints (must keep if revived)

- Do not claim Phase 5 (harvest/ship) is host-enforced unless a durable tick is added.
- Share pure helper with `terminalDeliveryProof` or accept divergence and document it.
- `session.updated` must not clear the autonomy stop latch.
- no-ceremony / QUICK still need an exit that does not require planner usable.

### Principle

Strong models + prose; determinism only at the high-leverage stop latch.  
No second workflow engine.

---

## Why reserved, not shipped

The phase ticks already work. The production bug was **eternal `delivery-close` re-prompt after
`final_review_done`**, not missing checklist infrastructure. Minimal fix reuses the last host stamp
the pipeline already writes.
