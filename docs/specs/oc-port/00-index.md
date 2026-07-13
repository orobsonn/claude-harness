# OC Port — Index (constitution)

**Status:** approved for implementation tracking  
**Date:** 2026-07-10  
**Audience:** implementing agents (LLM) and operator  
**Scope:** port the Claude Code delivery harness to OpenCode with a shared pure core; dual-runtime source layout; project vendoring; VPS headless later.

---

## 1. Why

The harness must not be locked to Anthropic/Claude Code. OpenCode is provider-agnostic. Motivation is **provider independence**, not cost reduction.

Headless reality for this operator: **VPS crons** (not Claude cloud routines). `core/vps/` is the autonomous engine.

---

## 2. Non-negotiable invariants

1. **`shared/` never throws** — returns `{ ok, decision, reason }` (or equivalent). Claude hooks are fail-open; OC plugins fail-closed via `throw`. Shared must not pick a failure direction.
2. **Cheap hand = external subprocess + independent capture** — never trust hand prose or process exit code. Oracle = git freeze + re-run locked tests + reset on FAILED.
3. **No plugin/hook reads hand auth tokens** — OC plugins run in-process with full env.
4. **Gate state on disk** — not in-process `Map` (survives restart).
5. **Routing is a table** — `harness.routing.json` generates runtime config; operator default = Grok motor + OpenAI eyes; users may reconfigure via skill.

---

## 3. Source layout (target)

```
core/
  shared/           # pure libs, agnostic rules/knowledge/schemas
  claude-code/      # Claude runtime shell (today's core/ agents-hooks-skills)
  opencode/         # OpenCode runtime shell (versioned; NOT ~/.config/opencode)
  vps/              # headless engine (phase 2 for OC session driver)
```

Vendor: `--target claude` → `.claude/` · `--target opencode` → `.opencode/` (+ project config files OC loads).

Global `~/.config/opencode` harness **dies at cutover** (see `10-cutover-global.md`).

---

## 4. Default model routing (operator)

| Role | Default | Notes |
|---|---|---|
| Session / `build` | `xai/grok-4.3` | 1M context orchestration |
| planner | `xai/grok-4.5` | critical |
| plan-reviewer | `xai/grok-4.5` | **always** dual + OpenAI |
| adversary | `xai/grok-4.5` | **always** dual + OpenAI |
| compliance / security | `openai/gpt-5.5` | evaluator family |
| executor/sniper low | `xai/grok-build-0.1` | |
| medium | `xai/grok-4.3` | |
| high | `xai/grok-4.5` | |
| harvester / shipper | `xai/grok-build-0.1` | |

No Ollama in default. Cross-family always on plan-reviewer + adversary (mirrors CC Opus + codex at key posts).

Full detail: `02-routing.md`.

---

## 5. Document map (read protocol for implementers)

| Doc | Topic | Phase |
|---|---|---|
| [00-index.md](./00-index.md) | This file — order, DoD, links | always |
| [01-architecture.md](./01-architecture.md) | Folders, vendor targets, paths, phases | 1 |
| [02-routing.md](./02-routing.md) | Models, dual-eye, routing schema, config skill | 1 |
| [03-shared-lib.md](./03-shared-lib.md) | Public API of pure modules + tests | 1 |
| [04-agents-and-skills.md](./04-agents-and-skills.md) | Roles, skills BOTH/OC, build protocol | 1 |
| [05-gates-plugins.md](./05-gates-plugins.md) | Hooks ↔ plugins, disk state, fail directions | 1 |
| [06-cheap-hands.md](./06-cheap-hands.md) | Spawn adapters, freeze, capture oracle | 1 |
| [07-cross-family.md](./07-cross-family.md) | Dual task, merge policy B, key posts | 1 |
| [08-vendor-cli.md](./08-vendor-cli.md) | init --target, non-clobber, parity CI | 1 |
| [09-vps-headless.md](./09-vps-headless.md) | VPS OC driver, NDJSON, auto-merge block | 2 |
| [10-cutover-global.md](./10-cutover-global.md) | Empty global OC harness | 1 (end) |
| [IMPLEMENTATION-TRACK.md](./IMPLEMENTATION-TRACK.md) | Live checklist — update as you ship | always |
| [inventory/full-map.md](./inventory/full-map.md) | Exhaustive CC→destination map | reference |
| [inventory/probe-results-2026-07-10.md](./inventory/probe-results-2026-07-10.md) | Live OC 1.17.18 evidence | reference |
| [decisions/](./decisions/) | ADRs (locked product/engineering choices) | reference |

### Implementer protocol (mandatory)

```
For each implementation task:
1. Read 00-index.md (order + phase DoD)
2. Read IMPLEMENTATION-TRACK.md (what is done / next)
3. Read ONLY the contract doc(s) listed on that track item
4. Read inventory/ only if the contract links a section
5. Implement only that item's DoD
6. Update IMPLEMENTATION-TRACK.md (checkboxes + date + notes)
7. Run tests listed on the contract
8. STOP — do not start the next item without a new task brief
```

**Forbidden:** inventing scope outside the active contract; "finishing the whole port" in one task; reading phase-2 docs to implement phase-1 code.

---

## 6. Dependency graph (build order)

```
T0  01-architecture          → folder skeleton in repo
T1  02-routing + ADR         → harness.routing.json + schema validate (shared)
T2  03 feature-id + paths    → shared lib
T3  03 validate-plan         → shared lib
T4  03 severity + merge      → shared lib (cross-family pure)
T5  05 gates MVP             → entry-gate + plan-gate + classify + disk state
T5b 03+OC tool               → complexity-scorer shared + OC tool
T6  04 agents/skills         → agents + skills + build prose (dual protocol text only)
T7  06 cheap-hands           → spawn OC + capture (see P2: CLI hand agents are mode primary)
T8  07 cross-family wiring   → dual task + merge + fail-open (runtime wiring)
T9  08 vendor-cli            → init --target opencode
T11 parity CI                → manifesto tests (before cutover)
T10 10 cutover               → global empty + docs (after T11)
---- phase 2 ----
T12 09 NDJSON session parser → shared/VPS oracle (exit code is not success)
T13 09 VPS spawn opencode    → cron session driver
T14 09 auto-merge gate       → gated-by-precondition (fail-closed gate ocAutoMergeGateOpen)
```

---

## 7. Phase 1 Definition of Done

- [ ] `core/shared`, `core/claude-code`, `core/opencode` exist and are the source of truth (not `~/.config/opencode`)
- [ ] Default routing Grok+OpenAI committed; dual always on plan-reviewer + adversary
- [ ] Shared pure libs tested; never throw
- [ ] OC plugins enforce entry + plan gates; state on disk
- [ ] Cheap hand path has independent capture (not prose-only)
- [ ] `init --target opencode` vendors project `.opencode/`
- [ ] Parity manifesto CI green (or explicit skip list)
- [ ] Global OC harness removed / cutover checklist complete
- [ ] IMPLEMENTATION-TRACK fully checked for phase 1

Phase 2 (VPS OC) is **not** required for phase 1 DoD.

---

## 8. Related legacy specs

- Branch `feat/opencode-harness-port` — older single-file spec (superseded by this folder for structure; keep for probe history)
- `docs/specs/2026-06-12-eyes-strong-hands-cheap.md` — capture philosophy
- `docs/specs/2026-06-11-deterministic-entry-gate.md` — gate philosophy

---

## 9. Language

- Specs, code, JSON: **English**
- Operator-facing messages in product: **pt-br**
