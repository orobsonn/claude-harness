# Spec — oc-gate-parity-scope-eyes-ceremony (issue #299) — REV1

**feature_id:** `oc-gate-parity-scope-eyes-ceremony`  
**mode:** full  
**priority:** P0  
**source:** GitHub #299  
**size:** M  
**revision:** REV1 after dual adversary (primary + openai; merge policy B)

## Product outcome

Close three OC containment gaps so OpenCode is not a weaker surface than Claude Code on the **same technical rails that this issue can ship inside its file allowlist**:

1. **Write-scope rail consumer** — when `gate-state.active_dispatch` is present and well-formed, executor/sniper Write|Edit outside scope is denied by pure decide + plan-write-gate (not prose).
2. **Eyes tool lockdown** — listed eye agents structurally deny webfetch/websearch/task at agent frontmatter.
3. **QUICK / no-ceremony backstop** — compliance/security/harvester/shipper cannot dispatch under those modes merely because a mode stamp exists.

### Honest residual (dual-adversary, accepted)

| Residual | Why accepted for #299 |
|---|---|
| **No `active_dispatch` producer in OC** | File allowlist has no mark-gate/stamp-triage. Rail **fail-opens** without stamp (same as CC when rail off). ACs inject `active_dispatch`. Production arming = follow-up issue (stamp on hand dispatch). PR must not claim "always denies out-of-scope in live OC" without stamp. |
| **Bash write bypass** | Executors have `bash: allow`; scope rail is Write\|Edit only. Bash wall is issue **#300**. Residual risk documented; #uj-1 closed for Write\|Edit path only. |
| **T3 is four roles, not full CC Gate 1** | Issue #ac-1.4 locks compliance\|security\|harvester\|shipper only. QUICK still allows executor (intentional QUICK craft path). Not full CC parity on every delivery role. |

## User journeys (scoped)

- **#uj-1:** given armed `active_dispatch`, executor/sniper **Write|Edit** outside `scope_paths` → technical deny; inside → allow.
- **#uj-2:** eye agents cannot use webfetch/websearch/task even if project default allows.
- **#uj-3:** under QUICK / no-ceremony, compliance/security/harvester/shipper dispatch → deny.

## Acceptance criteria

- **#ac-1.1:** `active_dispatch.scope_paths = ["src/a.ts"]`, executor write `src/b.ts` → deny; reason cites out-of-scope path.
- **#ac-1.2:** same state, write `src/a.ts` → allow.
- **#ac-1.3:** listed eyes deny webfetch/websearch/task at agent permission (static frontmatter contract).
- **#ac-1.4:** mode QUICK or no-ceremony + compliance|security|harvester|shipper → `decideEntryTask` deny.
- **#ac-1.5:** mode FULL + full ceremony → those four roles still allow.
- **#ac-1.6:** ≥3 new regression tests fail-before / pass-after.

## Locked decisions

1. fail_closed only — tighten; never loosen existing denies.
2. CC behavioral reference; OC shape = hooks `.ts` + pure decide `.mjs`.
3. eyes: adversary, adversary-openai, plan-reviewer, plan-reviewer-openai, security, planner, compliance — not hands.
4. Scope rail subjects: executor/sniper family (tiered names). **Role match = family** via `isExecutorRole` / `isSniperRole` on both acting role and `active_dispatch.role` (not exact string equality).
5. `active_dispatch` **stamping out of file allowlist** — rail fail-opens when incomplete; tests inject state.
6. Out of scope: `core/claude-code/**` write, dual-enforcement (#298), bash delivery wall (#300), permanent model-routing redesign.
7. **scopeContains:** exact match always; directory prefix only when scope entry is a directory (trailing `/` OR no file extension). File entry `src/a.ts` must **deny** `src/a.ts/evil.ts`.
8. **Mode normalize:** `String(mode).trim().toLowerCase()`; QUICK set = `quick` | `no-ceremony`.
9. **PlanWriteGate factory** must accept `{ directory, worktree }` and resolve projectRoot like entry-gate (so live load can work when stamp exists later).
10. **Anti-forge first, fail-closed:** anti-forge path must not be swallowed by a broad catch that returns allow; scope-rail errors may fail-open.
11. **Permission precedence assumption:** OC agent-level `deny` overrides project `allow` for the same tool — structural AC is frontmatter; document residual if runtime merge differs.

## Root-cause (unchanged evidence)

### Gap 1 — scope rail missing
- OC `plan-write-decide.mjs` `decide()` ~170–209: anti-forge only, then allow.
- CC `checkScopeRail` ~64–106: technical deny outside scope for hand subagents.

### Gap 2 — eyes tools open
- Eye frontmatter: only edit(/bash) denies; no webfetch/websearch/task deny.
- `opencode.json.example` allows those tools project-wide.

### Gap 3 — QUICK stamp unlocks four roles
- `entry-decide.mjs` ~69–80: hasModeStamp includes QUICK/no-ceremony → fall-through allow for compliance/security/harvester/shipper.
- CC Gate 1: mode must be LIGHT|FULL for delivery.

## Design REV1

### T1 — Scope write rail (`plan-write-decide.mjs` + `plan-write-gate.ts`)

Pure `decide(payload, opts?)`:

1. Extract path; missing path → deny (existing).
2. Anti-forge oracles (existing) — fail-closed; keep outside soft catch.
3. Scope rail (new), only if all hold:
   - `opts.gateState` or payload-provided gateState has `active_dispatch` object
   - `active_dispatch.scope_paths` non-empty array of strings
   - acting role present and is executor|sniper family
   - `active_dispatch.role` same family as acting (family match)
   - subagent context flag true when available; if OC cannot prove subagent, **fail-open** (document; tests pass `isSubagent: true`)
4. If path not in scope_paths ∪ allowed_writes (scopeContains) → deny with reason naming path + scope list.
5. Else allow.

`scopeContains(file, scopeEntry)`:
- normalize both (posix, lower, strip `..` escape → outside)
- exact match → true
- if scopeEntry is directory (ends with `/` OR `path.extname(entry) === ''`) → prefix `entry/` 
- else file entry → exact only

Hook `plan-write-gate.ts`:
- Factory: `async ({ directory, worktree }) => createPlanWriteGateHooks(root)`
- On write/edit: extract path; load gate-state if sessionId safe; extract acting role best-effort from input (agent, agent_type, etc.); call decide with opts; throwIfDenied.
- Missing session/role/state → rail off; anti-forge still runs.

Tests: #ac-1.1, #ac-1.2, directory allow, file-not-prefix (`src/a.ts` denies `src/a.ts/evil.ts`), family match executor-high + ad.role executor, role mismatch fail-open, no active_dispatch fail-open, anti-forge still denies gate-state even if "in scope".

### T2 — Eyes lockdown (7 agent files)

Frontmatter permission add:
```yaml
webfetch: deny
websearch: deny
task: deny
```
Preserve existing edit/bash. compliance keeps bash: allow.

Test: parse each eye file frontmatter; assert three denies present.

Optional one-line note in example config is non-blocking; agent deny is the AC.

### T3 — QUICK/no-ceremony backstop (`entry-decide.mjs`, optional `roles.mjs`)

After ceremony-present, before planner/adversary special cases (or immediately after ceremony check):

```
const mode = normalizeMode(gs.mode)
if ((mode === 'quick' || mode === 'no-ceremony') && isQuickCeremonyBlockedRole(sub))
  → deny
```

`isQuickCeremonyBlockedRole`: compliance | security | harvester | shipper only.

FULL + classified + (for planner: brainstormed+adversary_fired) → four roles allow (#ac-1.5).

Do not change fidelity rail or planner ceremony.

Tests: each of 4 roles × QUICK and no-ceremony deny; FULL allow for each; existing ceremony-missing still deny.

### T4 — Regression pack

≥3 new tests covering the three gaps (may live in existing test files).

## Non-goals

- active_dispatch stamp producer
- bash scope rail (#300)
- full CC Gate 1 for all delivery roles under QUICK
- dual-enforcement / sessionId (#298)
- committing Ollama session model patches

## Demo

1. Pure decide: out-of-scope deny / in-scope allow with fixture active_dispatch
2. Eye frontmatter denies webfetch/websearch/task
3. QUICK+compliance deny; FULL+ceremony allow for four roles
4. Targeted node --test green

## Dual-adversary disposition (REV1)

| Finding | Disposition |
|---|---|
| High: inert production rail without stamp | Accept residual; honest UJ; ACs fixture-based; factory+load ready for future stamp |
| High: bash bypass | Accept residual; #300; UJ scoped to Write\|Edit |
| Medium: T3 four roles vs full CC | Locked by #ac-1.4; document intentional |
| Medium: role family match | Fixed in locked #4 |
| Medium: PlanWriteGate directory | Fixed in locked #9 |
| Medium: eyes runtime merge | Frontmatter AC; document precedence assumption |
| Medium: file-as-directory prefix | Fixed in locked #7 |
| Low: mode normalize | Fixed in locked #8 |
| Low: catch fail-open | Fixed in locked #10 |

**Spec adversary gate:** highs reframed as accepted residual with product honesty — not silent false allow of the AC surface. Proceed to plan.
