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
call `classify`, load `oc-triaging-requests`, or start ceremony.

On the **first request of every top-level `build` session**, the primary agent runs this
order before anything else. These are real **skills it loads and follows**:

1. **`oc-triaging-requests`** — classify into **no-ceremony / QUICK / LIGHT / FULL**.
2. **`oc-brainstorming`** (LIGHT/FULL only) — elicit operator decisions; HARD-GATE on approved design.
3. **`planner`** — only after the spec is approved.

Both entry skills run **inside `build` (primary)** — never in a Task child / hand / eye.
Host rails deny `classify` on child sessions and on any agent other than `build`.
The full per-task delivery loop lives in the `oc-orchestrating-delivery` skill.

### Harness lifecycle lane

Administering the harness — installing/updating it, or reconfiguring which models the roles use — runs
in the `harness-config` primary agent, not in `build`. The operator reaches it by typing
`/updating-harness` or `/configuring-model-routing`; the command switches the session agent, and the
lane's frontmatter denies `classify`, ceremony markers, `task`, `edit`, and every skill except the two
lifecycle ones. It does not call `classify`, create a spec, or enter the delivery loop. It is denied for
headless/relayed input. After a successful write it **ships to `main` via PR** in the same session
(branch → selective stage → squash-merge), then ends with a mandatory session restart.

### Conversational Plan lane

The `plan` primary agent is a separate discovery lane, read-only except for one narrow
write carve-out. It is exempt from
the `build` entry policy: no triage, classify, ceremony markers, implementation, or
delivery. It may inspect the project, research the web, load only the conversational
branch of `oc-brainstorming` or the `oc-grill` interview skill, and invoke only the read-only
`discussion-adversary`. Its single permitted write is the `oc-grill` PRD artifact under
`docs/prd/` (frontmatter `permission.edit` denies `*` and allows only `docs/prd/*.md`);
`bash` stays denied.
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
| build | `openai/gpt-5.6-terra` |
| planner | `openai/gpt-5.6-sol` |
| plan-reviewer | `openai/gpt-5.6-sol` |
| adversary | `openai/gpt-5.6-sol` |
| compliance | `openai/gpt-5.6-sol` |
| security | `openai/gpt-5.6-sol` |
| executor/sniper low | `openai/gpt-5.6-luna` |
| executor/sniper medium | `openai/gpt-5.6-luna` |
| executor/sniper high | `openai/gpt-5.6-terra` |
| test-author | `openai/gpt-5.6-terra` |
| harvester / shipper | `openai/gpt-5.6-luna` |

**Single evaluator** on plan-reviewer and adversary. Optional `secondEyeModel` (absent by default) is fail-open — never blocks delivery.
Default hands use the OpenAI Luna → Terra ladder. Reconfigure by typing the `/configuring-model-routing` command.


---

## 9. Hands vs eyes

- **Eyes** (read-only): planner, plan-reviewer*, adversary*, compliance, security.
- **Hands** (write): executor-*, sniper-*, test-author.
- CLI cheap hands use the same `mode: all` agents as in-session dispatch, with `tools.task: false` — see `docs/SPAWN-PATTERN.md`.
- test-author is **fidelity-exempt** (creates the locked test); executor is blocked until fidelity-pass.

---

## 10. Runtime paths (OpenCode)

| Concept | Path |
|---|---|
| Plans | `.opencode/plans/<feature_id>/execution-plan.json` |
| Gate state | `.opencode/plans/.state/<session_id>/` |
| Hand records | `.opencode/plans/.state/hand-records/<feature>/<sessionId>/<task>.json` |
| Findings buffer | project root `findings.md` (ephemeral) |
| Durable memory | project root `MEMORY.md` |
| Routing | `harness.routing.json` / `.opencode/harness.routing.json` |

**HARD:** never use `.claude/hooks/classify.mjs` or `.claude/hooks/mark.mjs` in an OC session. Use the native `classify` tool and the `mark` tool registered by `marker-authority.ts`.

**Marker threat boundary:** marker authority's WeakMap identity and ordering bind only the native `mark` invocation's exact `args` object to session, call, feature, and action, then consume it before mutation. This blocks direct execute, structural clones, replay, concurrent reuse, and runtime-binding mismatch for that invocation. Downstream R10 accepts plain persisted `brainstormed` / `adversary_fired` booleans plus the classified feature match; those values carry no on-disk provenance or OS isolation. Same-user filesystem/Bash writes or a compromised OpenCode host/plugin can forge them. The official path remains the native `mark` tool; direct gate-state edits are forbidden by convention and permission friction, not by a provenance proof. There is no ceremony sidecar, artifact receipt, HMAC, or recovery coordinator.

**Fix-mode authority boundary:** the fleet dispatcher freezes reviewed SHA + exact changed-file scope in
`HARNESS_FIX_SCOPE_JSON`; the OC host accepts it only for a classified LIGHT/FULL sniper dispatch,
checks SHA ancestry, and binds it to the exact session/feature/task/call record. Root, directory,
traversal, duplicate, oversized, malformed, and stale scopes fail closed. This prevents model prose
from widening the reviewed scope inside the dispatched host. It is not OS isolation: a separate
same-user OpenCode process can supply its own environment, and a compromised host/plugin can forge
the envelope. Closing that boundary requires a sandbox or external IPC authority, not another
marker/state sidecar.

## 11. Folder law — .opencode/ (OpenCode vendored harness)

- The stable execution plan lives under `.opencode/plans/<feature_id>/`; gate-state and hand-records under `.opencode/plans/.state/` are session-ephemeral.
- Edit source under `core/opencode/` (agents, skills, AGENTS.md); `.opencode/` at project root is the vendored runtime copy (do not edit directly in a vendored project).

See also: core/opencode/skills/orchestrating-delivery/SKILL.md (runtime paths)


### Folder router (law of one folder)

| Folder | What lives there | See |
|--------|------------------|-----|
| .opencode/ | OC vendored agents/skills/plugins + runtime state (ephemeral plans) | core/opencode/AGENTS.md (source) + this section |

## 12. Plugin dispatch chain order

OpenCode auto-globs `core/opencode/plugin/*.{ts,js}` with no sort (upstream node-glob,
`nosort`) — there is no explicit loader/index that lists plugins in order. For a Task
dispatch, the first plugin to `throw` wins, so **discovery order decides which gate the
operator actually sees deny**. The chain that gates a real Task dispatch runs, in order:

```
plan-gate → obs-hand → entry-gate
```

Note `entry-gate.ts` — the plugin usually thought of as "the gate" — runs **last**. A rename
that changes any of these files' relative alphabetical position silently reorders the
chain. `plugin-dispatch-order.test.mjs` locks this sequence as a regression tripwire; update
this section and that test together, only after confirming a reorder is intentional.

**Decided (2026-07-26):** regression test only for now, no rename/explicit loader. Revisit a
numeric prefix or a single loader once tracks touching these files land, or a 6th plugin
joins the chain — whichever comes first.
