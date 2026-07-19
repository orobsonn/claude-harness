# AGENTS.md — OpenCode Delivery Harness (project-vendored)

Native top-of-tree rules for this OpenCode harness when vendored into a project
(`.opencode/` + project root). Written in English (harness convention);
operator-facing messages are **pt-br** (see Language convention).

Models come from `harness.routing.json`.
Do not invent role models in prose that disagree with that file.

**Human operator guide (pt-br):** `.opencode/docs/OPERATOR-GUIDE.md` (source: `core/opencode/docs/OPERATOR-GUIDE.md`).
Skills catalog, plan vs build, routing, ship rails, how to update the harness — load when the operator asks how to use OpenCode or is lost on config skills.

---

## Entry policy — read this FIRST (top-level `build` only)

**This section governs the top-level `build` session only.** If you were spawned
as a hand or eye via the `task` tool (executor / sniper / test-author / planner /
plan-reviewer / adversary / compliance / security / harvester / shipper) — or you
are any agent other than `build` — **skip this section entirely**. You are one
step inside a pipeline that already triaged. Follow your brief only. **Never**
call `classify`, load `triaging-requests`, or start ceremony.

On the **first request of every top-level `build` session**, the primary agent runs this
order before anything else. These are real **skills it loads and follows**:

1. **`triaging-requests`** — classify into **no-ceremony / QUICK / LIGHT / FULL**.
2. **`brainstorming`** (LIGHT/FULL only) — elicit operator decisions; HARD-GATE on approved design.
3. **`planner`** — only after the spec is approved.

Both entry skills run **inside `build` (primary)** — never in a Task child / hand / eye.
Host rails deny `classify` on child sessions and on any agent other than `build`.
The full per-task delivery loop lives in the `orchestrating-delivery` skill.

### Harness lifecycle lane

An interactive operator request exclusively to install/update/synchronize the harness is routed by
`triaging-requests` directly to `updating-harness`. It does not call `classify`, create a spec, or enter
the delivery loop. It is denied for headless/relayed input and ends with a mandatory session restart.

### Conversational Plan lane

The `plan` primary agent is a separate read-only discovery lane. It is exempt from
the `build` entry policy: no triage, classify, ceremony markers, implementation, or
delivery. It may inspect the project, research the web, load only the conversational
branch of `brainstorming`, and invoke only the read-only `discussion-adversary`.
Its terminal artifact is a `## Build Spec` in the shared session conversation. The
operator switches to `build` with Tab when they want that approved spec implemented;
`build` then applies its normal entry policy.

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
| build | `openai/gpt-5.6-sol` |
| planner | `openai/gpt-5.6-sol` |
| plan-reviewer | required family 1 `openai/gpt-5.6-sol` + optional family 2 `ollama-cloud/kimi-k2.7-code` |
| adversary | required family 1 `openai/gpt-5.6-sol` + optional family 2 `ollama-cloud/kimi-k2.7-code` |
| compliance | `openai/gpt-5.5` |
| security | `openai/gpt-5.5` |
| executor/sniper low | `ollama-cloud/gemma4:31b` |
| executor/sniper medium | `ollama-cloud/glm-5.2` |
| executor/sniper high | `ollama-cloud/kimi-k2.7-code` |
| test-author | `ollama-cloud/glm-5.2` |
| harvester / shipper | `openai/gpt-5.5` |

**Family 1 is mandatory; family 2 is optional and fail-open** on plan-reviewer and adversary (two `task` dispatches + shared merge when available).
Default hands use the Ollama Cloud ladder. Reconfigure via skill `configuring-model-routing`.

---

## 9. Hands vs eyes

- **Eyes** (read-only): planner, plan-reviewer*, adversary*, compliance, security.
- **Hands** (write): executor-*, sniper-*, test-author.
- CLI cheap hands use `*-spawn` agents (`mode: primary`, `tools.task: false`) — see `docs/SPAWN-PATTERN.md`.
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

**HARD:** never use `.claude/hooks/classify.mjs` or `.claude/hooks/mark.mjs` in an OC session. Use the native `classify` tool and the `mark` tool registered by `marker-authority.ts`; `mark-gate.mjs` is observability-only.

**Marker threat boundary:** marker authority binds the runtime before-hook's exact `args` object to session, call, feature, and operation, then consumes it before mutation. Process-instance HMAC seals make direct filesystem writes and markers minted by another process semantically invalid to host gates. It blocks model Bash/import, clones, replay, concurrent reuse, and child-process authority forgery. It does not protect against a compromised OpenCode host/plugin running in the authority process. A host restart rotates the in-memory secret and fails closed for existing privileged markers; durable restart recovery belongs to #340.

## 11. Folder law — .opencode/ (OpenCode vendored harness)

- Plans, gate-state, hand-records under `.opencode/plans/` and `.opencode/plans/.state/` are run-ephemeral (deleted at harvest); only execution-plan.json and shared_context.md (pre-delete) live in the feature subdir.
- Edit source under `core/opencode/` (agents, skills, AGENTS.md); `.opencode/` at project root is the vendored runtime copy (do not edit directly in a vendored project).
- Harvest-guard checks for presence of root `findings.md` before allowing harvest step.

See also: core/opencode/skills/orchestrating-delivery/SKILL.md (runtime paths), core/opencode/plugin/harvest-guard.ts


### Folder router (law of one folder)

| Folder | What lives there | See |
|--------|------------------|-----|
| .opencode/ | OC vendored agents/skills/plugins + runtime state (ephemeral plans) | core/opencode/AGENTS.md (source) + this section |
