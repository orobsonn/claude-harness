# OC Port — Implementation track

**How to use:** After finishing any track item, the implementing agent MUST update this file: set status, date (ISO), short note, and link commit/PR if any.  
**Source of truth for progress:** this file (not chat memory).

Statuses: `pending` | `in_progress` | `done` | `blocked` | `skipped`

---

## Phase 0 — Spec pack (documentation)

| ID | Item | Status | Date | Notes |
|---|---|---|---|---|
| D0 | `00-index.md` constitution | done | 2026-07-10 | Created |
| D1 | `01-architecture.md` | done | 2026-07-10 | Created |
| D2 | `02-routing.md` | done | 2026-07-10 | Created |
| D3 | `03-shared-lib.md` | done | 2026-07-10 | Created |
| D4 | `04-agents-and-skills.md` | done | 2026-07-10 | Created |
| D5 | `05-gates-plugins.md` | done | 2026-07-10 | Created |
| D6 | `06-cheap-hands.md` | done | 2026-07-10 | Created |
| D7 | `07-cross-family.md` | done | 2026-07-10 | Created |
| D8 | `08-vendor-cli.md` | done | 2026-07-10 | Created |
| D9 | `09-vps-headless.md` | done | 2026-07-10 | Created (phase 2 stub) |
| D10 | `10-cutover-global.md` | done | 2026-07-10 | Created |
| D11 | `inventory/full-map.md` | done | 2026-07-10 | Created |
| D12 | `inventory/probe-results-2026-07-10.md` | done | 2026-07-10 | Created |
| D13 | ADRs 001–003 | done | 2026-07-10 | Created |
| D14 | Virgin Grok 4.5 review of spec pack | done | 2026-07-10 | Multi-pass: REVISE→fixes→APPROVE (final virgin Grok 4.5) |

---

## Phase 1 — Implementation

| ID | Item | Contract docs | Status | Date | Notes |
|---|---|---|---|---|---|
| T0 | Repo folder skeleton `shared/` `claude-code/` `opencode/` | 01 | pending | | No behavior change yet |
| T1 | `harness.routing.json` + shared routing validate | 02, 03 | pending | | Default Grok+OpenAI |
| T2 | shared `feature-id` + `path-helpers` | 03 | pending | | Parametrize .claude vs .opencode |
| T3 | shared `validate-plan` | 03 | pending | | Port from creating-plans |
| T4 | shared severity + merge-findings/verdicts | 03, 07 | pending | | Family-agnostic names |
| T5 | Gates MVP: entry + plan + classify + disk + fidelity rail + loop-guard counters | 05, 03 | pending | | shared; no Map; test-author exempt from fidelity-pass |
| T5c | Optional polish: reinject, version-check, harvest-guard | 05 | pending | | not blocking T5 MVP |
| T5b | complexity-scorer shared + OC tool | 03 | pending | | bands low/med/high/max/split |
| T6 | OC agents + skills + build dual **prose** | 04, 02 | pending | | Restore test-author; P2 spawn agents; dual wiring = T8 |
| T7 | Cheap hand OC spawn + capture oracle | 06, 03 | pending | | mode primary spawn; closed outcomes; no Ollama default |
| T8 | Cross-family dual **runtime** wiring + merge | 07, 03 | pending | | dual_status enum; fail-open primary_only_failopen |
| T9 | Vendor CLI `--target opencode` | 08 | pending | | Non-clobber memory/kaizen |
| T10 | Cutover global OC harness | 10 | pending | | After T9 works |
| T11 | Parity manifesto CI | 08, 00 | pending | | |

---

## Phase 2 — VPS OpenCode (blocked until phase 1 DoD)

| ID | Item | Contract docs | Status | Date | Notes |
|---|---|---|---|---|---|
| T12 | NDJSON session result parser | 09, 03 | pending | | Exit code is not oracle |
| T13 | VPS spawn `opencode run` | 09 | pending | | |
| T14 | Auto-merge only after T12+T13 proven | 09 | pending | | **Do not enable early** |

---

## Blockers log

| Date | Item | Blocker | Resolution |
|---|---|---|---|
| 2026-07-10 | Dual real OpenAI | OpenAI not authenticated on operator machine (probe) | Login ChatGPT/OpenAI in OC before T8 live dual |
| 2026-07-10 | Auto-merge OC | `opencode run` exits 0 even when gate denies | T12 required |

---

## Change log (spec pack)

| Date | Change |
|---|---|
| 2026-07-10 | Initial spec pack created from conversation + live OC 1.17.18 probes |
| 2026-07-10 | Virgin Grok 4.5 review → REVISE; applied B1–B6 (P2 spawn, fidelity rail, outcome enum, classify/complexity track, PathResult API, graph T12–T14) |
| 2026-07-10 | Second virgin pass APPROVE; applied N1–N4 polish (outcome diagram, P16 id, T5c, band→tier map) |
| 2026-07-10 | Third virgin REVISE: stub vs full plan, dual_status enum, parity OC tiers, safe sessionId, deferred inventory |
| 2026-07-10 | Fourth/fifth virgin REVISE: isSafeSessionId API + handRecordPath canonical + validate expect tests |
| 2026-07-10 | Final virgin Grok 4.5 → **APPROVE** (N1–N5 non-blocking only) |
| 2026-07-10 | OpenAI terra REVISE applied to 03/05/06/07 (worktree, RMW lock, dual error policy, locked_tests, session-scoped hand records) |
| 2026-07-10 | Terra loop pass 2: no_tests boolean, lock ownership token, quarantine gate owner |
| 2026-07-10 | OpenAI gpt-5.6-terra virgin loop → **APPROVE** |
| 2026-07-10 | Virgin OpenAI `gpt-5.6-terra` → REVISE (non-auth dual error policy, concurrent gate-state RMW, NOT_DONE worktree quarantine, handRecord session scope) — follow-ups for T5/T7/T8, not blocking pack publish |
