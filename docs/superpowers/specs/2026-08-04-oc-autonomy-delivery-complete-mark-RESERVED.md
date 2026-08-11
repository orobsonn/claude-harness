# RETIRED — `mark delivery-complete` idle-autonomy design

**Status:** historical design; **do not implement**. The idle-continuation controller was removed because it
formed a second workflow engine that could override a legitimate stop for a product decision. OpenCode now
uses the same prompt-level delegation model as Claude Code.

**Date:** 2026-08-04  
**Context:** infinite autonomy tick after LIGHT/FULL runs (victor-bot lead-frio / rita; gestao).

---

## Former reserved design (operator proposal)

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
3. The former design proposed a dedicated completion stamp; it is deliberately not revived.
4. On fail: `ok:false` + missing ticks; agent repairs and retries. No auto-stop on idle alone.
5. Prose: call only after harvest + authorized ship (or accept early-stop residual).
6. A future proposal must not reintroduce a host-side prompt/reopen loop.

### Historical adversarial constraints

- Do not claim Phase 5 (harvest/ship) is host-enforced unless a durable tick is added.
- Share pure helper with `terminalDeliveryProof` or accept divergence and document it.
- `session.updated` must not clear the autonomy stop latch.
- no-ceremony / QUICK still need an exit that does not require planner usable.

### Principle

Strong models + prose; determinism only at high-leverage delivery gates. No second workflow engine.

---

## Why it remains retired

The phase ticks already work. Reintroducing a host-side idle loop would again force work after the model
properly surfaced an unresolved decision.
