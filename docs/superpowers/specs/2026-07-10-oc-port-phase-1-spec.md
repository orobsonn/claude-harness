# Spec — OC Port Phase 1

**Status:** approved (post-adversary revise 2026-07-10)  
**Date:** 2026-07-10  
**Feature id:** oc-port-phase-1  
**Mode:** full  
**Technical contracts:** docs/specs/oc-port/ (00–08, 10, IMPLEMENTATION-TRACK, ADRs 001–003)

---

## User journeys

### #uj-1 — Dual-runtime source of truth
As the harness maintainer, I have `core/shared`, `core/claude-code`, and `core/opencode` as the only source of truth for harness code (not `~/.config/opencode` during development), so both Claude and OpenCode targets can be vendored from the repo.

### #uj-2 — Default routing Grok + OpenAI
As the operator, default model routing uses Grok for motor/hands and OpenAI for evaluator eyes, with dual always on plan-reviewer and adversary, without Ollama in the default map.

### #uj-3 — Shared pure core
As an implementer of gates/plugins, I call pure shared libs that never throw and return Decision/ValidationResult shapes, so Claude (fail-open) and OC (fail-closed) adapters can choose failure direction.

### #uj-4 — Gates on disk
As the operator running OC sessions, entry and plan gates enforce ceremony with state on disk (survives restart), ownership-token locks for RMW, and no in-process Map as sole state.

### #uj-5 — Cheap hands with independent capture
As the orchestrator, cheap hands run as external subprocesses with independent capture oracle (not prose, not exit code alone), and plugins never read hand auth tokens.

### #uj-6 — Project vendoring + global cutover
As a project user, `init --target opencode` vendors `.opencode/` into the project; after phase 1 cutover, the global OC harness is emptied so only project-vendored harness runs — only after independent proof.

### #uj-7 — Parity CI
As CI, a parity manifesto verifies required OC artifacts exist (or explicit skip list), so the port cannot silently drop roles/skills.

---

## Acceptance criteria

### Milestone M1 — T0 + T1
- #ac-1.1 T0: `core/shared/`, `core/claude-code/`, `core/opencode/` exist per `01-architecture.md`; existing flat `core/agents|skills|hooks|…` moved under `core/claude-code/` without behavior rewrite; `core/vps/` stays put.
- #ac-1.2 T0: imports/paths/tests that referenced old flat layout are updated so existing Claude harness tests still pass. Tests may be adjusted **only for source paths**, not to weaken runtime assertions.
- #ac-1.3 T0: `package.json` bin/files (and any npm-published paths) updated in the **same commit** as the move, OR compatibility shims preserve resolution. M1 includes CLI resolution smoke for package entrypoint.
- #ac-1.4 T0: Vendored Claude-target smoke: after move, `.claude/settings.json` (or equivalent) still points to working hooks under new layout.
- #ac-1.5 T1: `core/opencode/harness.routing.json` committed with default Grok motor + OpenAI eyes; dual always on plan-reviewer and adversary; no Ollama default (ADR-001).
- #ac-1.6 T1: shared routing schema validate module under `core/shared/`; validates routing JSON without throwing (returns ValidationResult).

### Milestone M2 — T2 + T3 + T4
- #ac-2.1 T2: shared `feature-id` + path helpers parametrize `claude` vs `opencode` roots (plans, gate state, hand records per `01`/`03`).
- #ac-2.2 T2: path helpers include safe sessionId checks (reject `..` etc.) per contract.
- #ac-2.3 T3: shared `validate-plan` ported from creating-plans logic; pure; never throws; tests cover expect cases from contract.
- #ac-2.4 T4: shared severity + merge-findings/verdicts (family-agnostic names) per `03`/`07`; pure; never throws; tests green.

### Milestone M3 — T5 + T5b + T5c (locked order)
- #ac-3.1 T5: entry-gate + plan-gate + classify + disk state + fidelity rail + loop-guard counters per `05`; no Map-only state; lock with ownership token (RMW).
- #ac-3.2 T5: test-author exempt from fidelity-pass per contract.
- #ac-3.3 T5b: complexity-scorer shared + OC tool; bands low/med/high/max/split.
- #ac-3.4 T5c: reinject, version-check, harvest-guard polish plugins/hooks per `05`.

### Milestone M4 — T6 + T7 + T8
- #ac-4.1 T6: OC agents + skills + build dual **prose** per `04`/`02`; restore test-author; P2 spawn agents; dual wiring deferred to T8.
- #ac-4.2 T7: cheap hand OC spawn + capture oracle per `06`; mode primary spawn; closed outcomes; no Ollama default; session-scoped hand records; worktree cleanup self-contained.
- #ac-4.3 T8: cross-family dual **runtime** wiring + merge per `07`; dual_status enum; fail-open `primary_only_failopen` when secondary unavailable.

### Milestone M5 — T9 + T11 + T10 (cutover LAST)
- #ac-5.1 T9: vendor CLI `init --target opencode` per `08`; non-clobber memory/kaizen; relative plugin paths only.
- #ac-5.2 T11: parity manifesto CI green or explicit skip list per `08`/`00`. **Must pass before T10.**
- #ac-5.3 T11: new-clone / project-vendored smoke proves harness works **without** relying on global `~/.config/opencode`.
- #ac-5.4 T10: real cutover of global `~/.config/opencode` **only after** #ac-5.2 and #ac-5.3 pass; backup/rollback path documented; active delivery must already run from project-vendored `.opencode` only.
- #ac-5.5 T10: cutover script/checklist applied; global emptied per `10`.

### Cross-cutting
- #ac-6.1 IMPLEMENTATION-TRACK updated after each item (status, ISO date, note). Order in TRACK must match locked order (T5→T5b→T5c; T9→T11→T10).
- #ac-6.2 Phase 2 docs/code not implemented.
- #ac-6.3 shared/ never throws (ADR-002).
- #ac-6.4 Dual always on plan-reviewer + adversary (ADR-003).
- #ac-6.5 Virgin OpenAI review after each milestone using authoritative slug **`openai/gpt-5.5`** only (not terra/sol aliases). Record APPROVE/REVISE on TRACK.
- #ac-6.6 Delivery via feature branches + PRs (never direct main); Conventional Commits pt-br; one PR per milestone.
- #ac-6.7 After all milestones: minor release (release-please / releasing-versions skill).

---

## Constraints

1. Implementer protocol from `00-index.md` §5 — one track item at a time.
2. **Locked order:** T0 → T1 → T2 → T3 → T4 → T5 → T5b → T5c → T6 → T7 → T8 → T9 → T11 → T10.
3. Invariants from `00-index.md` §2.
4. Known blocker: OpenAI may be unauthenticated for live dual (T8) — use contract fail-open policy; do not invent auth.
5. Do not expand into T12–T14.
6. Milestone virgin review model: **`openai/gpt-5.5`** only.

---

## Locked decisions (operator + post-adversary)

| id | decision | operator_resolution |
|---|---|---|
| D1 | Git packaging | One PR per milestone (5 PRs) |
| D2 | T5c | Include in phase 1; order after T5b |
| D3 | T10 cutover | Real cutover **after** T11 parity + project-vendored smoke; last step of M5 |
| D4 | Execution | Single FULL plan; sequential T*; commits per item; PRs at milestones |
| D5 | Phase 2 | Out of scope |
| D6 | Technical authority | docs/specs/oc-port/ pack |
| D7 | Review model | openai/gpt-5.5 only for virgin milestone reviews |
| D8 | T0 package entrypoint | package.json bin/files or shims in same commit as move |
| D9 | M3 order | T5 → T5b → T5c (TRACK must match) |
| D10 | Release | minor release after phase 1 DoD |

---

## Demo

- type: markdown
- scenarios_from_refs: #uj-1, #uj-2, #uj-4, #uj-6, #ac-1.1, #ac-1.5, #ac-3.1, #ac-5.1, #ac-5.2, #ac-5.4
- Operator verifies TRACK all done, folder layout, routing defaults, gates present, vendor CLI, parity CI, cutover applied last, minor release published.
