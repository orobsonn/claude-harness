# Spec — oc-entry-gate-sessionid-ceremony (issue #298) — REV1

**feature_id:** `oc-entry-gate-sessionid-ceremony`  
**mode:** full  
**priority:** P0  
**source:** GitHub #298  
**revision:** REV1 after dual adversary (both NEEDS_REVISION → design deltas applied)

## Product outcome

Under OpenCode, after classify + brainstorm + spec-adversary are already on disk, dispatching the **planner** must **not** die with a false "ceremony missing". If the real problem is a missing `sessionId`, the error must **name sessionId** — never mask it as ceremony.

## User journeys

- **#uj-1:** operator classifies FULL, marks brainstorm + spec-adversary, dispatches planner → planner **runs** (not blocked by false ceremony missing).
- **#uj-2:** if the task hook has no sessionID, the error **names sessionId missing**, not generic ceremony missing.

## Acceptance criteria

- **#ac-1.1:** gate-state with `classified: true`, `mode: FULL`, `brainstormed: true`, `adversary_fired: true` → `decideEntryTask` for planner → **allow** (not deny ceremony).
- **#ac-1.2:** entry-gate with `sessionId` null/empty on a delivery role (task **or** delivery bash) → reason contains contiguous token **`sessionId`** and does **not** use generic "ceremony missing".
- **#ac-1.3:** classify wrote state under sessionId S1 and task hook receives the same S1 → load resolves correct path and reads `classified: true`; planner allow.
- **#ac-1.4:** missing sessionId → **explicit fail** with reason containing `sessionId` — **never** silent empty state that becomes ceremony missing. (mtime is a non-goal.)
- **#ac-1.5:** regression tests: full ceremony under S1 + hook S1 + planner → allow; sessionId null → deny with sessionId reason (not ceremony); true empty ceremony under valid S1 + planner → still ceremony/brainstorm deny (fail-closed).

## Locked decisions

1. fail-closed remains: without real ceremony for the **bound** session, delivery role still deny.
2. generic "ceremony missing" **only** when a deterministic, bound session path was successfully resolved and the state is empty/incomplete (including missing `gate-state.json` treated as empty ceremony).
3. sessionId missing = **distinct** reason; every session-binding deny string must include contiguous token `sessionId` (not "session id" with a space).
4. **No mtime fallback** (cross-session leak). Update JSDoc on `loadGateStateFromDisk` to match code.
5. **Trust model for ceremony session bind (operator-locked after dual adversary):**
   1. Framework hook fields only: `input.sessionID` and safe aliases on the **hook input** (`sessionId`, nested documented OC shapes) — **never** model-controlled `toolArgs.session_id` / `sessionId` for ceremony load.
   2. **No env fallback** for ceremony binding in this fix (env often empty or stale; spoof/cross-session risk). Env may appear in obs logs only.
   3. If unbound after trusted extraction → explicit fail with `sessionId` reason.
6. **Single resolve per hook invocation:** resolve sessionId once at top of `tool.execute.before`; pass the same value into load + dual enforcement. Dual must not re-bind from toolArgs when caller already supplied the bound id (including explicit `null` meaning unbound).
7. instrumentation: log/obs fail-open with sessionId + path + present keys — never throw from obs.

## Root-cause hypothesis (with evidence)

### Bug A — load failure masked as empty ceremony (primary)

`core/opencode/plugin/entry-gate.ts` ~209–224:

```ts
const loaded = loadGateStateFromDisk(projectRoot, { sessionId: sid })
const gateState = loaded.ok ? loaded.state : {}  // MASK
throwIfEntryDenied(decideEntryTask({ subagentType, gateState, ... }))
```

When load returns `{ ok: false, reason: "sessionId required..." }`, shell substitutes `{}` → `decideEntryTask` emits generic **ceremony missing**. Field false-positive.

### Bug B — JSDoc promises mtime; code hard-fails

`dual-enforcement.mjs` ~534–536 vs ~589. Decision: keep explicit fail; fix comment.

### Bug C — bash path loses sessionId reason

Bash uses `gateStateLoadOk: false` + empty state → generic "readable gate-state", not `sessionId`. Task and bash must share one reason contract for load failure.

### Bug D — dual re-resolves session via toolArgs

`enforceDualFromDiskOrThrow` falls back to `extractSessionId(toolArgs)` when sessionId null. Entry must pass a single bound id and dual must honor "caller bound" (including unbound → fail with same reason class). Minimal change: entry always passes the resolved sid (string or undefined); when unbound, entry throws **before** dual for delivery ceremony roles so dual is not reached with a divergent bind. For executor dual path after ceremony allow, pass the same sid.

### What already works

- Valid sessionId + complete gate-state → load OK.
- Pure `decideEntryTask` + full ceremony → planner allow.
- Missing file under known sessionId → `{ ok: true, state: {} }` (true empty ceremony).

## Proposed fix (design REV1)

### T1 — `loadGateStateFromDisk` contract

- Prefer safe sessionId → read `.opencode/plans/.state/<sessionId>/gate-state.json`.
- Missing/empty sessionId → `{ ok: false, reason }` containing contiguous `sessionId` (keep/adjust existing reason string if needed so tests can match `/sessionId/`).
- Unsafe sessionId → reason must include `sessionId` (e.g. `unsafe sessionId`).
- Update JSDoc: remove mtime promise; document explicit fail + anti cross-session rationale.
- No behavior change to successful load / missing-file-as-empty.

### T2 — `entry-gate.ts` + extract helpers

1. **`extractHookTaskContext`:** also accept trusted hook-input aliases (`sessionID`, `sessionId`) only — still **not** toolArgs.
2. Resolve once: `sid` from trusted hook fields; empty/unsafe → treat as unbound.
3. **Task path:** load with sid. If `!loaded.ok` and delivery role (or always before decide for task delivery): throw `[entry-gate] …` + `loaded.reason` (must include `sessionId` when that is the cause). **Never** pass `{}` into `decideEntryTask` on load failure.
4. If `loaded.ok`: pass `loaded.state` to `decideEntryTask` (true empty → ceremony missing OK).
5. **Bash delivery path:** after forge check, if delivery command and `!loaded.ok`, throw with `loaded.reason` (sessionId-named) — do not call `decideBashDelivery` with masked empty state for the unreadable case. Non-delivery bash unchanged (no throw on missing session).
6. Pass the **same** `sid` into `enforceDualFromDiskOrThrow`. When sid unbound, ceremony throw happens first for delivery roles that need state.
7. Obs fail-open: sessionId, path, keys — never throw.

### T3 — regression tests

| Test | Expect |
|---|---|
| pure decideEntryTask planner + full ceremony | allow (#ac-1.1) |
| entry-gate task planner + full ceremony under S1 + hook sessionID S1 | no throw (#ac-1.1/#ac-1.3/#ac-1.5) |
| entry-gate task planner + null sessionID | throw matches `/sessionId/` and not `/ceremony missing/` (#ac-1.2/#ac-1.4/#ac-1.5) |
| entry-gate delivery bash + null sessionID | throw matches `/sessionId/` not ceremony (#ac-1.2) |
| entry-gate planner + valid S1 + empty/missing state file | ceremony or brainstorm deny (fail-closed) (#ac-1.5) |
| loadGateStateFromDisk without sessionId | ok false, reason `/sessionId/` |
| toolArgs carries foreign sessionId but hook has S1 | load uses S1 only (no toolArgs bind) |
| toolArgs carries foreign session with full ceremony, hook missing sessionID | deny sessionId — **not** allow via toolArgs |

## Non-goals

- Claude Code pipeline
- delivery skills, agents, model routing
- mtime fallback
- env-based ceremony bind
- toolArgs-based ceremony bind
- broad rewrite of bash-decide pure API (prefer throw in shell before decide when load fails)
- changing dual_status / ADR-003 rules beyond single-bind pass-through
- plan-gate full rewrite (note residual; only touch if shared helper is extracted and plan-gate imports it without behavior expansion)

## Scope paths

- `core/opencode/plugin/entry-gate.ts`
- `core/opencode/plugin/lib/dual-enforcement.mjs` (load JSDoc + extractHookTaskContext aliases; dual caller-bind clarity if needed)
- `core/opencode/plugin/lib/entry-decide.mjs` only if pure helper needed (prefer not)
- tests: `entry-gate.test.mjs`, `dual-enforcement.test.mjs`

## Security / fail-closed

- Never allow delivery without real ceremony for the **hook-bound** session.
- Never bind ceremony from model toolArgs or stale env.
- Never mtime-scan other sessions.
- Unsafe sessionId segments still deny with `sessionId` token.
- Obs: keys only, no secrets, never throw.

## Dual adversary disposition (REV1)

| Finding | Disposition |
|---|---|
| toolArgs/env ceremony bypass (H) | **Accepted** — removed from design; hook-only bind |
| env wrong session (H) | **Accepted** — no env ceremony bind |
| bash reason divergence (H) | **Accepted** — throw loaded.reason on delivery bash load fail |
| #uj-1 may need real hook shape (M) | **Accepted** — expand trusted hook aliases only; no toolArgs/env |
| reason token sessionId (M) | **Accepted** — contiguous `sessionId` locked |
| dual vs entry re-bind (M) | **Accepted** — single resolve; pass same sid |
| AC-1.4 mtime wording (L) | **Accepted** — explicit fail only |
| plan-gate residual (L) | **Accepted risk** — out of scope note |

## Demo (from UJs)

1. Fixture gate-state complete + sessionId S1 → planner allow.
2. sessionId null → deny reason mentions `sessionId`, not ceremony.
3. Targeted `node --test` green.
