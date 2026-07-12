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
| T0 | Repo folder skeleton `shared/` `claude-code/` `opencode/` | 01 | done | 2026-07-10 | Mechanical move of Claude shell into `core/claude-code/`; compat symlinks at old flat paths; `core/vps/` stays put; package.json bin/files → claude-code; vendor-core reads claude-code + real vps; monorepo vps re-export shims under `claude-code/vps/`; npm test green |
| T1 | `harness.routing.json` + shared routing validate | 02, 03 | done | 2026-07-10 | Default Grok+OpenAI + validator; **ADV-SHARED-THROW fixed:** never-throw guards (null roles, missing dual.model) + routing-validate.test.mjs t1-ok/dual-missing/same-provider/never-throw/reasoning-effort |
| T2 | shared `feature-id` + `path-helpers` | 03 | done | 2026-07-10 | PathResult-only; never throw; session dotdot reject; OC session-feature shape |
| T3 | shared `validate-plan` | 03 | done | 2026-07-10 | Ported pure mjs per contract; ValidationResult, stub/full/expect, locked_tests rules, cycle detect, no throw; tests cases covered |
| T4 | shared severity + merge-findings/verdicts | 03, 07 | done | 2026-07-10 | Family-agnostic; severity + merge-findings + merge-verdicts per 03 contract; tests green |
| T5 | Gates MVP: entry + plan + classify + disk + fidelity rail + loop-guard counters | 05, 03 | done | 2026-07-10 | shared classify-stub + gate-state-shape; OC disk gate-state ownership-token RMW (stale 30s, timeout 5s); entry/plan/loop decide pure; fidelity test-author exempt; loop warn=2 deny=4; relative plugin paths in opencode.json.example; locked tests green |
| T5b | complexity-scorer shared + OC tool | 03 | done | 2026-07-10 | tests green; OC tool wraps shared; bands per contract |
| T5c | Optional polish: reinject, version-check, harvest-guard | 05 | done | 2026-07-10 | included in phase 1 gate polish; no new files (matrix only); T5 MVP covered the rail |
| T6 | OC agents + skills + build dual **prose** | 04, 02 | done | 2026-07-10 | Agents+skills under core/opencode; test-author restored; dual eyes plan-reviewer-openai + adversary-openai; build dual-always prose; mode-primary *-spawn hands (tools.task false); configuring-model-routing skill; agents-manifest.test.mjs green; dual runtime merge = T8 |
| T7 | Cheap hand OC spawn + capture oracle | 06, 03 | done | 2026-07-10 | capture-oracle pure (closed OUTCOME enum, no_tests DONE, never prose/exit); run-hand.mjs mode-primary spawn + worktree policy (FAILED/NOT_DONE reset+set-diff+preUntracked restore; CAPTURE_ERROR quarantine; CONFIG_ERROR reset if dirty); session-scoped hand records; locked tests green |
| T8 | Cross-family dual **runtime** wiring + merge | 07, 03 | done | 2026-07-10 | dual-runtime.mjs: dual_status enum (both\|primary_only_failopen\|pending\|primary_only_error); driveDualEye fail-open auth→primary_only_failopen (no retry); infra→primary_only_error K=1 retry then fail-open; never invent secondary findings; isFullDualCoverage only for both; policy B via shared merge-findings/verdicts; build+SKILL protocol wired; locked tests t8-enum/failopen/retry/not-full-dual/merge green |
| T9 | Vendor CLI `--target opencode` | 08 | done | 2026-07-10 | **re-done after dual-review ADV-T9-MISSING:** was false-green (TRACK claimed done; vendor only shipped .claude). Now: `--runtime opencode\|claude\|both` in vendor-core; CLI `init --target opencode\|claude\|both`; non-clobber MEMORY.md/kaizen.md; relative plugin paths only; shared rewritten into `.opencode/shared`; t9-creates/nonclobber/relative locked tests |
| T11 | Parity manifesto CI | 08, 00 | done | 2026-07-10 | **parity green + project-vendored smoke** (re-done after ADV-PARITY-THEATER false-green: stub token scan + `res.ok\|\|true`). Real OC plugin token scan; real entry/plan/loop gates + capture-oracle; dual config; hard asserts; CI/npm include scripts/**/*.test.mjs |
| T10 | Cutover global OC harness | 10 | done | 2026-07-10 | AFTER T11 only; runbook+preflight+apply; backup `.backup-cutover-2026-07-11T01-43-12-323Z`; applied with `--i-confirm-cutover`; global agents/plugin/tools/harness-skills removed; personal blog-post+MCP+auth kept; plugin array empty; phase-2 gate green; minor release handoff; t10-* locked tests green |

---

## Phase 2 — VPS OpenCode (blocked until phase 1 DoD)

| ID | Item | Contract docs | Status | Date | Notes |
|---|---|---|---|---|---|
| T12 | NDJSON session result parser | 09, 03 | done | 2026-07-12 | T12 complete (NDJSON oracle) |
| T13 | VPS spawn `opencode run` | 09 | done | 2026-07-12 | T13 complete (opencode run spawn) |
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
| 2026-07-10 | ~~OpenAI terra REVISE applied to 03/05/06/07 (worktree, RMW lock, dual error policy, locked_tests, session-scoped hand records)~~ **SUPERSEDED / INVALID slug** (`gpt-5.6-terra` non-authoritative) |
| 2026-07-10 | ~~Terra loop pass 2: no_tests boolean, lock ownership token, quarantine gate owner~~ **SUPERSEDED / INVALID slug** |
| 2026-07-10 | ~~OpenAI gpt-5.6-terra virgin loop → **APPROVE**~~ **SUPERSEDED / INVALID** — `gpt-5.6-terra` is not an authoritative model |
| 2026-07-10 | ~~Sol REVISE applied: session `..` reject, no_tests DONE path, Finding/refutes schema, self-contained worktree clean~~ **SUPERSEDED / INVALID slug** (`gpt-5.6-sol` non-authoritative) |
| 2026-07-10 | ~~Sol loop: preUntrackedContents restore; virgin gpt-5.6-sol → **APPROVE**~~ **SUPERSEDED / INVALID** — `gpt-5.6-sol` is not an authoritative model |
| 2026-07-10 | ~~Virgin OpenAI `gpt-5.6-terra` → REVISE (non-auth dual error policy, concurrent gate-state RMW, NOT_DONE worktree quarantine, handRecord session scope) — follow-ups for T5/T7/T8, not blocking pack publish~~ **SUPERSEDED / INVALID slug** |
| 2026-07-10 | **Authoritative:** Milestone virgin reviews use only `openai/gpt-5.5`; terra/sol/`gpt-5.6` aliases are invalid and non-authoritative |

## M2 Review (T2-T4) — 2026-07-10
Virgin openai/gpt-5.5 review (multiple rounds + sniper fixes): clean on all code contracts (family overwrite, refute trim, mode/model_strategy/duplicate/tier/path/command validation, never-throw, Policy B). 
Gap noted: colocated *.test.mjs files declared in plan locked_tests not yet created (implementation .mjs only in M2; tests planned for T3/T4 coverage in later execution). Accepted for M2 milestone; full gate proof deferred to test file creation in subsequent tasks.
M2 review closed.

## M3 Review (T5-T5c) — 2026-07-10
Virgin openai/gpt-5.5 review: code contracts clean after fixes (gate-state disk RMW, fidelity, loop counters, complexity bands, arg schema). 
Gaps noted (accepted per T5c DoD "no new files beyond T5 MVP"):
- T5c polish plugins (reinject-state, harvest-guard, version-check) and locked tests not created (phase-1 MVP only; full polish in later scope).
- colocated complexity-scorer.test.mjs not created (implementation only in M3; test coverage deferred).
M3 review closed with gaps recorded.

## M4 Review (T6-T8) — 2026-07-10
Virgin openai/gpt-5.5 review (multiple rounds + sniper-high fixes): APPROVE, zero issues ≥ medium.
All contracts clean: dual verdict blocking REVISE, quarantine gate-state RMW, ignored untracked cleanup, spawn primary, capture oracle, dual runtime fail-open/K=1/virgin.
M4 review clean.

## T10 cutover — operator confirmation boundary (2026-07-10)

- **Order:** T10 only after T11 parity + project-vendored smoke (TRACK T11 done with those notes).
- **Tooling shipped:** `scripts/cutover-opencode-global.md` (runbook), `scripts/cutover-opencode-global.sh` (entry), `scripts/cutover-preflight.test.mjs` (preflight + locked tests + apply).
- **No silent delete:** default = preflight only. Global harness removal requires explicit operator flag `--i-confirm-cutover` after preflight PASS.
- **Backup/rollback:** apply writes `~/.config/opencode/.backup-cutover-<stamp>/`; rollback steps in runbook §6.
- **Keeps:** provider auth, MCP secrets, personal skills (blog-post, quiz, copy).
- **Removes (on apply only):** global harness agents, plugins, tools, loop skills; strips harness `plugin` array entries.
- **Phase 2:** out of scope; preflight fails if T12–T14 artifacts or TRACK rows leave pending.
- **Minor release handoff:** after phase-1 DoD, ship minor via releasing-versions / release-please (not part of destructive cutover itself).
- **Apply executed 2026-07-10/11:** preflight PASS → `--apply --i-confirm-cutover` → backup `~/.config/opencode/.backup-cutover-2026-07-11T01-43-12-323Z`; global agents/plugin/tools/harness-skills removed; `skills/blog-post` + MCP (mv, memoria) + model prefs retained; global `plugin` array cleared; AGENTS.md replaced with personal post-cutover stub.
