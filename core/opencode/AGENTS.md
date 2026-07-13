# AGENTS.md — OpenCode Delivery Harness (project-vendored)

Native top-of-tree rules for this OpenCode harness when vendored into a project
(`.opencode/` + project root). Written in English (harness convention);
operator-facing messages are **pt-br** (see Language convention).

Models come from `harness.routing.json` (default: Grok motor + OpenAI eyes).
Do not invent role models in prose that disagree with that file.

---

## Entry policy — read this FIRST (every session)

On the **first request of every session**, the `build` (primary) agent runs this
order before anything else. These are real **skills it loads and follows**:

1. **`triaging-requests`** — classify into **no-ceremony / QUICK / LIGHT / FULL**.
2. **`brainstorming`** (LIGHT/FULL only) — elicit operator decisions; HARD-GATE on approved design.
3. **`planner`** — only after the spec is approved.

Both entry skills run **inside `build` (primary)** — never in a headless subagent.
The full per-task delivery loop lives in the `orchestrating-delivery` skill.

---

## 1. Operator profile

- The operator may be a **product manager, not a developer**.
- Every decision surfaced is a **PRODUCT decision** — impact, tradeoffs, user behavior.
- Engineering problems are resolved **inside the system** (retry, tier bump, sniper).

---

## 2. Language convention

- Harness artifacts (agents, skills, JSON, internal reasoning): **English**.
- Operator-facing messages: **pt-br, product-language**.

---

## 3. Communication (terse)

- Short, direct. No preamble, no conclusion, no summary.
- Show results, not intentions. Short lists > paragraphs.

---

## 4. Git rules

- **Conventional Commits**: `<type>: <descrição curta em pt-br>`, header ≤72 chars.
- **Never commit directly to `main`** — branch + PR.
- **Selective stage** — never `git add .` / `git add -A` blindly.
- **NEVER** force-push to `main`, `--no-verify`, or amend already-pushed commits.
- **NEVER** add a `Co-Authored-By` trailer.
- PR body: **Summary** + **Test plan**. Default merge = squash.

---

## 5. Security rules

- No hardcoded secrets. Runtime secrets via env / secret store.
- Sanitize errors to clients. Validate all external input at the boundary (Zod).
- Never log tokens/JWTs/passwords. Parameterized queries only.
- CORS allowlist on credentialed endpoints. `fetch` with timeout.

---

## 6. Code-quality rules

- Atomic functions; DRY with limit; TypeScript strict (no `any`).
- Comments only for WHY. JSDoc `/** @description ... */` on every new `.ts`/`.tsx`.
- Forbidden generic files: `helpers.ts`, `utils.ts`, `misc.ts`, `common.ts`.
- Full law also lives under `.opencode/rules/` (git, security, testing, architecture) — load when relevant; AGENTS is the summary.

---

## 7. Sensitive-path allowlist (forces FULL)

```
**/auth/**
**/payment/**
**/billing/**
**/*.sql
**/migrations/**
**/.env*
**/package.json   (when adding or upgrading deps)
```

Any match in plan `scope_paths` forces FULL mode.

---

## 8. Model routing (operator default)

| Role | Model |
|---|---|
| build | `xai/grok-4.3` |
| planner | `xai/grok-4.5` |
| plan-reviewer | `xai/grok-4.5` + dual `openai/gpt-5.5` |
| adversary | `xai/grok-4.5` + dual `openai/gpt-5.5` |
| compliance / security | `openai/gpt-5.5` |
| executor/sniper low | `xai/grok-build-0.1` |
| executor/sniper medium | `xai/grok-4.3` |
| executor/sniper high | `xai/grok-4.5` |
| test-author / harvester / shipper | `xai/grok-build-0.1` |

**Dual-always** on plan-reviewer and adversary (two `task` dispatches + shared merge).
No Ollama in default map. Reconfigure via skill `configuring-model-routing`.

---

## 9. Hands vs eyes

- **Eyes** (read-only): planner, plan-reviewer*, adversary*, compliance, security.
- **Hands** (write): executor-*, sniper-*, test-author.
- CLI cheap hands use `*-spawn` agents (`mode: primary`, `tools.task: false`) — see `agents/SPAWN-PATTERN.md`.
- test-author is **fidelity-exempt** (creates the locked test); executor is blocked until fidelity-pass.

---

## 10. Runtime paths (OpenCode)

| Concept | Path |
|---|---|
| Plans | `.opencode/plans/<sessionID>-<feature_id>/` |
| Gate state | `.opencode/plans/.state/<session_id>/` |
| Hand records | `.opencode/plans/.state/hand-records/<feature>/<sessionId>/<task>.json` |
| Findings buffer | project root `findings.md` (ephemeral) |
| Durable memory | project root `MEMORY.md` |
| Routing | `harness.routing.json` / `.opencode/harness.routing.json` |

**HARD:** never use `.claude/hooks/classify.mjs` or `.claude/hooks/mark.mjs` in an OC session — they do not write OC gate-state. Use the `classify` tool + `node .opencode/plugin/lib/mark-gate.mjs`.

## 11. Folder law — .opencode/ (OpenCode vendored harness)

- Plans, gate-state, hand-records under `.opencode/plans/` and `.opencode/plans/.state/` are run-ephemeral (deleted at harvest); only execution-plan.json and shared_context.md (pre-delete) live in the feature subdir.
- Edit source under `core/opencode/` (agents, skills, AGENTS.md); `.opencode/` at project root is the vendored runtime copy (do not edit directly in a vendored project).
- Harvest-guard checks for presence of root `findings.md` before allowing harvest step.

See also: core/opencode/skills/orchestrating-delivery/SKILL.md (runtime paths), core/opencode/plugin/harvest-guard.ts


### Folder router (law of one folder)

| Folder | What lives there | See |
|--------|------------------|-----|
| .opencode/ | OC vendored agents/skills/plugins + runtime state (ephemeral plans) | core/opencode/AGENTS.md (source) + this section |

