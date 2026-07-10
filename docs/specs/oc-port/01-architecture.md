# 01 — Architecture

**Phase:** 1  
**Depends on:** 00-index  
**Implements:** source layout, vendor targets, runtime paths, phase boundaries  
**Out of scope:** function APIs (03), agent prose (04), plugin code (05)

---

## 1. Target source tree

```
core/
  shared/
    lib/           # pure .mjs modules (never throw)
    rules/         # agnostic markdown rules
    knowledge/     # memory model, critical-classes body, seeds
    schemas/       # plan schema samples, routing schema
    github/        # ISSUE_TEMPLATE
  claude-code/
    agents/
    skills/
    hooks/
    settings.json
    CLAUDE.md
  opencode/
    agents/
    skills/
    plugin/
    tools/
    AGENTS.md
    opencode.json.example   # no secrets
    harness.routing.json    # default operator routing
  vps/             # existing engine; phase-2 OC session driver
```

Migration note: today's flat `core/agents|skills|hooks|...` becomes `core/claude-code/` (move, not rewrite behavior in T0).

---

## 2. What vendors where

| Source | Vendor destination | When |
|---|---|---|
| `core/claude-code/**` + selected `shared/**` | project `.claude/` | `init --target claude` |
| `core/opencode/**` + selected `shared/**` | project `.opencode/` (+ root files OC loads) | `init --target opencode` |
| `core/vps/**` | **not** vendored into app repos | VPS engine install only |
| `shared/rules`, `shared/knowledge` seeds | both targets as appropriate | non-clobber where accumulated |

### OC load paths (verified 1.17.18)

OpenCode merges config from multiple places, including:

- `~/.config/opencode/opencode.json` (global — must be empty of harness after cutover)
- `<project>/opencode.json`
- `<project>/.opencode/opencode.json`
- project agents/skills under `.opencode/`

**Implication:** vendoring only `.opencode/` while global still has harness plugins = global still runs (probe). Cutover is mandatory (10).

Prefer project registration:

```json
"plugin": ["./.opencode/plugin/entry-gate.ts", "./.opencode/plugin/plan-gate.ts", ...]
```

Relative paths only — never absolute home paths in committed config.

---

## 3. Runtime path contract

| Concept | Claude | OpenCode |
|---|---|---|
| Plans | `.claude/plans/<feature_id>/` | `.opencode/plans/<sessionID>-<feature_id>/` |
| Gate state | `.claude/plans/.state/<session_id>/` | `.opencode/plans/.state/<session_id>/` |
| Hand records | `.claude/plans/.state/hand-records/<feature>/<task>.json` | `.opencode/plans/.state/hand-records/<feature>/<sessionId>/<task>.json` |
| shared_context | under plan dir | under plan dir |
| findings buffer | project root `findings.md` | project root `findings.md` |
| Durable memory | `.claude/memory/` | project root `MEMORY.md` (current OC convention) |
| Entry policy file | `.claude/CLAUDE.md` | `AGENTS.md` |
| Runtime config | `.claude/settings.json` | `opencode.json` / `.opencode/opencode.json` |

Shared path helpers MUST take `runtime: "claude" | "opencode"` (or root dirname) — no hardcoded single runtime inside pure lib.

---

## 4. Framework-owned vs accumulated (vendor semantics)

Same spirit as current `vendor-core.mjs`:

| Class | Behavior |
|---|---|
| Framework-owned | Overwritten on update (agents, skills, hooks/plugins, tools, shared copies) |
| Accumulated | Seed if absent only (MEMORY/kaizen) |
| Merge markers | Entry policy block between harness markers |
| Non-clobber config | If settings/opencode.json exists → write `*.harness.json` for manual merge |
| Secrets | Never vendor real tokens; examples only |

---

## 5. Phases

### Phase 1 — Local pipeline on both targets

Triage → brainstorm → plan → per-task loop → dual review → demo → harvest → ship  
on OpenCode with Grok+OpenAI defaults, vendored per project.

### Phase 2 — VPS drives OpenCode sessions

Crons spawn `opencode run`; NDJSON result oracle; auto-merge only after oracle proven.  
See `09-vps-headless.md`. **Do not implement phase 2 in phase 1 tasks.**

---

## 6. Explicit non-goals (phase 1)

- Deprecating Claude Code target  
- Renaming npm package `@orobsonn/claude-harness`  
- Porting full VPS auto-merge to OC  
- Using Ollama as default hands  
- Promoting `~/.config/opencode` as source of truth  

---

## 7. DoD for architecture task (T0)

- [ ] Directories `core/shared/{lib,rules,knowledge,schemas,github}`, `core/claude-code`, `core/opencode` exist  
- [ ] Documented move plan for existing `core/agents|skills|hooks|rules` → `claude-code` (may be mechanical move in same PR as T0 or immediately after)  
- [ ] No runtime behavior change required in T0 beyond structure  
- [ ] IMPLEMENTATION-TRACK T0 → done  

---

## 8. References

- inventory/full-map.md  
- inventory/probe-results-2026-07-10.md (config merge + relative plugins)  
- ADR-002 shared never throws  
