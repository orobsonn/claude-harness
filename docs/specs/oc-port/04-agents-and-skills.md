# 04 — Agents and skills

**Phase:** 1  
**Depends on:** 02-routing, 01-architecture  
**Implements:** OC agent set, skill set, build dual protocol  
**Out of scope:** plugin enforcement (05), spawn capture (06), vendor (08)

---

## 1. Principles

- Agent **bodies** are runtime-specific (**BOTH**): vocabulary `task` vs `Agent`, paths `.opencode` vs `.claude`.  
- Do **not** put agent markdown in `shared/`.  
- Models come from routing (02); frontmatter must match `harness.routing.json`.  
- Invalid `subagent_type` on OC 1.17.18 returns **explicit error** (not silent generic fallback). Still use exact tier names; do not rely on fuzzy match.

---

## 2. OpenCode agents (required)

| Agent file | mode | Default model (routing) | dual |
|---|---|---|---|
| `build.md` | primary | grok-4.3 | — |
| `planner.md` | subagent | grok-4.5 | — |
| `plan-reviewer.md` | subagent | grok-4.5 | + openai agent |
| `plan-reviewer-openai.md` OR generic second eye | subagent | gpt-5.5 | pair |
| `adversary.md` | subagent | grok-4.5 | + openai agent |
| `adversary-openai.md` OR second eye | subagent | gpt-5.5 | pair |
| `compliance.md` | subagent | gpt-5.5 | — |
| `security.md` | subagent | gpt-5.5 | — |
| `executor-low.md` / `medium` / `high` | subagent | build / 4.3 / 4.5 | — |
| `sniper-low.md` / `medium` / `high` | subagent | same ladder | — |
| `test-author.md` | subagent | grok-build-0.1 | **restore** (old OC port dropped it) |
| `harvester.md` | subagent | build | — |
| `shipper.md` | subagent | build | — |

**Alternative to dual agent files:** one eye agent + orchestrator passes model if runtime supports it. Probe: **task tool has no model field** → **dual agent files (or generated copies) are the reliable approach**.

### build.md obligations

1. Load `triaging-requests` then `brainstorming` for LIGHT/FULL (skills, not inline paraphrase only).  
2. On plan-reviewer and adversary dispatches: **always** run dual (primary + openai eye), then merge via shared (07).  
3. Never implement code; dispatch only.  
4. Write plans/shared_context via bash if edit denied.  
5. Product language pt-br to operator.

### Permissions

- Eyes: `edit: deny`, `bash: deny` (read-only).  
- Hands: scoped; prefer `task: false` on hand agents (probe: subagents already deny nested task by default).  
- build: `edit: deny`, `bash: allow`.

---


### CLI spawn hands vs in-session `task` hands (probe P2)

OpenCode rejects `mode: subagent` for `opencode run --agent <name>` (falls back to default primary).

| Invocation | Required `mode` | Use |
|---|---|---|
| `task(subagent_type: ...)` inside build | `subagent` | normal loop dispatch |
| `opencode run --agent <hand>` cheap-hand adapter (06) | **`primary`** | external subprocess hand |

**Contract:** either (a) dedicated spawn agents e.g. `executor-high-spawn.md` with `mode: primary` + same body/model as subagent twin, or (b) single agent file `mode: primary` used only via CLI spawn while loop uses different subagent files. Document the chosen pattern in T7 DoD. **Do not** call `opencode run --agent executor-high` if that file is `mode: subagent`.

## 3. Skills

### Required on OC (loop)

| Skill | Notes |
|---|---|
| triaging-requests | entry; calls classify tool |
| brainstorming | elicit; primary only |
| grill | pre-implementation PRD interview; local-only (refuses headless); runs in `plan`, writes `docs/prd/<slug>.md` |
| orchestrating-delivery | LIGHT/FULL loop |
| recording-findings | harvest |
| distilling-learnings | harvest |
| proposing-improvements | harvest |
| surveying-codebase | cold memory |
| committing-changes | QUICK |
| releasing-versions | release |
| canonical-critical-classes | knowledge carrier |
| authoring-rules | nested AGENTS |
| configuring-model-routing | **new** — 02 |
| importing-claude-memory | optional one-shot |

### Claude-only or later
Final decisions on porting status are documented in [full-map.md](./inventory/full-map.md).

| Skill | Notes |

| Skill | Notes |
|---|---|
| creating-plans | CC; OC may keep schema inline in planner |
| initializing-projects / updating-harness | CLI multi-target (08) |
| measuring-cost | adapt to NDJSON costs |
| reviewing-pull-requests | VPS phase 2 |
| creating-issues | optional |

### Never vendor as harness

blog-post, quiz, copy, cloudflare stack skills — personal/global only.

---

## 3b. Mode mapping (triage → full plan)

| Triage / stub mode | Full plan `mode` |
|---|---|
| `LIGHT` | `light` |
| `FULL` | `full` |
| `QUICK` / `no-ceremony` | no full plan (QUICK path) |

Planner and build must never write a full plan with uppercase triage modes.

## 4. Porting rules (CC → OC prose)

| CC-ism | OC |
|---|---|
| `Agent(executor)` | `task(subagent_type: "executor-high")` |
| AskUserQuestion | text multiple-choice; end turn |
| `~/.claude` paths | project MEMORY / `.opencode` |
| haiku/sonnet/opus | low/medium/high + slugs |
| Skill tool name | `skill({ name })` |

---

## 5. DoD (T6)

T6 = **artifacts + prose only**. Runtime dual merge wiring is **T8**.

- [x] All required agents exist under `core/opencode/agents` with routing-aligned models  
- [x] test-author present  
- [x] dual eye agent pair files present for plan-reviewer + adversary  
- [x] skills listed as required present under `core/opencode/skills`  
- [x] build.md **states** dual-always protocol in prose (implementation of merge/fail-open = T8)  
- [x] Spawn/primary vs subagent pattern documented for hands (P2)  
- [x] IMPLEMENTATION-TRACK T6 done  

---

## 6. References

- 02-routing, 07-cross-family  
- inventory/full-map agents/skills  
- probe: invalid agent error; dual task success  
