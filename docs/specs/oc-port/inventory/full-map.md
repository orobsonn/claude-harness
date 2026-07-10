# Full inventory map — Claude harness → destinations

**Date:** 2026-07-10  
**Legend:** SHARED | CC | OC | BOTH | VPS | SEED | DROP | PKG  
**Phase:** 1 local | 2 VPS OC  

This is the exhaustive reference. Implementation contracts live in `../0x-*.md`.

**Rule:** items marked SHARED phase 1 without a section in `03-shared-lib.md` and a TRACK owner are **deferred** — do not invent APIs. Only 03+TRACK items are implementable in T0–T11.


---

## Agents (`core/agents` today → `claude-code/agents` + `opencode/agents`)

| Item | Dest | Phase | Notes |
|---|---|---|---|
| planner.md | BOTH | 1 | OC model grok-4.5 |
| plan-reviewer.md | BOTH | 1 | OC dual + openai |
| executor.md | BOTH | 1 | OC tier files or routing |
| sniper.md | BOTH | 1 | same |
| compliance.md | BOTH | 1 | OC openai |
| adversary.md | BOTH | 1 | OC dual always |
| security.md | BOTH | 1 | OC openai |
| harvester.md | BOTH | 1 | |
| shipper.md | BOTH | 1 | |
| test-author.md | BOTH | 1 | restore on OC |
| build.md | OC | 1 | primary orchestrator |
| *-openai.md dual eyes | OC | 1 | |

---

## Skills

| Item | Dest | Phase | Notes |
|---|---|---|---|
| triaging-requests | BOTH | 1 | |
| brainstorming | BOTH | 1 | |
| orchestrating-delivery | BOTH | 1 | |
| creating-plans | CC (+ schema shared) | 1 | OC inline ok |
| recording-findings | BOTH | 1 | |
| distilling-learnings | BOTH | 1 | |
| proposing-improvements | BOTH | 1 | |
| surveying-codebase | BOTH | 1 | |
| committing-changes | BOTH | 1 | |
| releasing-versions | BOTH | 1 | |
| canonical-critical-classes | SHARED knowledge + BOTH thin | 1 | |
| authoring-rules | BOTH | 1 | |
| initializing-projects | PKG | 1 | multi-target |
| updating-harness | BOTH/PKG | 1 | |
| creating-issues | BOTH optional | 1 | |
| measuring-cost | BOTH | 1–2 | NDJSON on OC |
| reviewing-pull-requests | VPS | 2 | |
| configuring-model-routing | OC | 1 | new |
| importing-claude-memory | OC | 1 | |
| personal domain skills | DROP vendor | — | |

### Skill references (code)

| Item | Dest | Phase |
|---|---|---|
| validate-plan.mjs | SHARED | 1 |
| complexity-scorer.mjs | SHARED + OC tool | 1 |
| example-plan.json | SHARED schemas | 1 |
| capture-hand.mjs pure parts | SHARED | 1 |
| dispatch-hand pure checks | SHARED | 1 |
| spawn-hand / runLiveDispatch | CC + OC adapters | 1 |
| brief-serializer, descriptor-emitter | SHARED **deferred** (T7 adapter may inline until extracted) | 1–later |
| cli-flags | CC | 1 |
| eye-tier | DROP as separate module — replaced by harness.routing.json (02) | 1 |
| ci-test-commands, derisk-metrics | SHARED **deferred** (not T0–T11 blockers; extract when first consumer needs) | later |
| hand-config/* | CC | 1 |
| vendor-core, cli, setup-vps | PKG / VPS | 1–2 |
| detect-stack/secrets/generate-ci/branch-protection/scan-secrets | PKG/SHARED | 1 |
| cost-report | BOTH adapters | 1–2 |
| compliance-diff-adapter | VPS | 2 |

---

## Hooks → plugins

| Item | Dest | Phase |
|---|---|---|
| entry-gate.mjs | CC; OC plugin | 1 |
| plan-write-gate.mjs | CC; OC plan-gate | 1 |
| classify.mjs / stamp-triage.mjs | CC; OC classify tool | 1 |
| mark.mjs | CC; OC disk markers | 1 |
| reinject-state.mjs | CC; OC chat.message | 1 |
| version-check.mjs | CC; OC advisory | 1 |
| codex-eye-nudge.mjs | CC only | 1 |
| agent-idle-nudge.mjs | CC; OC loop-guard | 1 |
| obs-eye-append / obs-plan-write | CC; optional OC | 1–2 |
| gate-lib.mjs | SHARED (+ fs in shells) | 1 |
| loop-guard / harvest-guard | OC | 1 |
| feature-id.ts (OC) | merge SHARED | 1 |
| operator-origin.ts | OC | 1 |

---

## Rules & policy files

| Item | Dest | Phase |
|---|---|---|
| rules/*.md (all 9) | SHARED | 1 |
| CLAUDE.md | CC | 1 |
| AGENTS.md | OC | 1 |
| CLAUDE-HARNESS-MEMORY-MODEL.md | SHARED knowledge | 1 |
| settings.json | CC | 1 |
| opencode.json.example | OC | 1 |
| harness.routing.json | OC | 1 |
| kaizen seed | SEED | 1 |
| memory/MEMORY.md seed | SEED | 1 |
| core/memory/* harness notes | DROP vendor | — |
| dev.vars.example | SEED | 1 |
| github ISSUE_TEMPLATE | SHARED→repo | 1 |

---

## VPS (`core/vps`)

All modules stay **VPS**. Phase 2 adds OC spawn + NDJSON parser.  
Pure candidates to extract if duplicated: verdict-block, parts of review-verdict-source, merge already in shared.

| Item | Phase OC work |
|---|---|
| cron-a-*, cron-review, review-*, reaper, drain, notify, engine-update, install-crons, gh-exec, scoped-env, run-lock, list-worktrees, chain-*, cron-state | 2 adapt spawn only where needed |
| spawn-review-session | 2 rewrite success detection |
| auto-merge | 2 blocked until NDJSON oracle |

---

## Modules

| Item | Dest | Phase |
|---|---|---|
| codex-adversary drivers | CC | 1 |
| merge-findings / merge-verdicts | SHARED generalized | 1 |
| rtk | CC optional / DROP OC | — |
| mv README | personal MCP | — |

---

## Runtime paths

See 01-architecture §3.

---

## OC global today → monorepo

| Global path | Action |
|---|---|
| agents, skills loop, plugin, tools | Rebuild under core/opencode; do not copy blindly as SoT |
| blog-post skill | keep personal only |
| opencode.json secrets | never commit |
| Map-based loop state | fix to disk in core/opencode |

---

## Coverage statement

Every path under `core/agents`, `core/skills` (incl. refs listed), `core/hooks`, `core/rules`, `core/vps` (module list), `core/memory` (seed vs drop), `core/github`, root core policy files, and `modules/*` has a destination class above.  
If a new file is added to core/, update this inventory in the same PR.
