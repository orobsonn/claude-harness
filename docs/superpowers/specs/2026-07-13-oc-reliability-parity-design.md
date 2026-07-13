# Spec — oc-reliability-parity (issue #302)

**feature_id:** `oc-reliability-parity`  
**Mode:** light  
**Priority:** P1 · Size S  
**Labels:** harness:ready  
**Spec dual:** adversary + adversary-openai merged (policy B) — design tightened below.

## Product outcome

OC runtime matches CC reliability on two operator-visible gaps:

1. **Main-loop idle nudge** — when a main-loop Task/agent (no nested-agent identity key) finishes without a structured report, OC emits a nudge in the same *observable signal class* as CC `agent-idle-nudge` / OC dual-nudge (`output.metadata` and/or obs event). Issue #ac-4.1 explicitly allows event/obs or hookSpecificOutput.
2. **Reaper `oc-data-*` cleanup** — crashed/blocked/orphan/terminal OC sessions must not leave `oc-data-<issueNumber>` forever under stateDir; reaper removes them with the same fail-closed basename guard as `cron-a-exit`.

## User journeys

- **#uj-1:** main-loop agent idles without report → OC emits nudge (metadata/obs class, dual-nudge carrier precedent).
- **#uj-2:** `oc-data-<issueNumber>` for blocked/terminal/orphan crash path → reaper removes dir with guard `/oc-data-\d+$/`.

## Acceptance criteria

- **#ac-4.1:** main-loop Task (no nested identity key) idle → nudge emitted (metadata and/or obs; same class as dual_nudge / CC additionalContext family).
- **#ac-4.2:** blocked or terminal without graceful exit → reaper removes `oc-data-<n>` (crashRecover blocked, completed-cleaned, orphan-cleaned).
- **#ac-4.3:** ready/local under retry ceiling → `oc-data-<n>` **NOT** removed.
- **#ac-4.4:** regression tests fail-before / pass-after (idle + cleanup + non-delete).

## Locked decisions

- **nao_duplicar_codex_nudge** — main-loop only; dual-eye path untouched.
- **referencia_cc** — `core/claude-code/hooks/agent-idle-nudge.mjs` decide/isIdleReport semantics.
- **referencia_cleanup** — `core/vps/cron-a-exit.mjs:220-224` guard + rmSync.
- **presence_not_truthiness** — nested if ANY of `agent_id` | `agentId` | `agentID` key is present (`Object.hasOwn` / hasOwnProperty), including falsy values.
- **oc_native_context** — inject text must NOT copy CC "SendMessage"/"Agent tool"; use OC task/agent re-prompt wording.
- **four_plugin_surfaces** — register on example + root opencode.json + defaultOcPluginPaths + CANONICAL_OC_PLUGINS (cron-a-dispatch list only; not prepareOpencodeDataHome).
- **signal_class** — `output.metadata.agent_idle_nudge` (mirror dual_nudge) is the primary OC carrier; optional obs append; #ac-4.1 allows this class (not a silent downgrade).

## Evidence (before) — root-cause

### A) Idle nudge gap

| File | Lines | Finding |
|---|---|---|
| CC `agent-idle-nudge.mjs` | 39–93 | pure decide; agent_id presence; dual-field idle; single inject + no-loop |
| OC `dual-nudge.mjs` / `obs-eye.ts` | dual only | eyes cross-family — not main-loop idle |
| plugin registration | example, root, vendor-core, CANONICAL_OC_PLUGINS | no agent-idle-nudge |

### B) Reaper oc-data gap

| File | Lines | Finding |
|---|---|---|
| `cron-a-dispatch.mjs` | 373–381, ~1132 | creates oc-data (do not change create) |
| `cron-a-exit.mjs` | 218–227 | graceful guard+rm (reference) |
| `reaper.mjs` | 198–204, 244–275, 412–415, 301–376 | rmOutputLog only; orphan-cleaned/completed no oc-data rm |

## Design (post dual-adversary)

### Gap A — main-loop idle nudge

1. **Pure** `core/opencode/plugin/lib/agent-idle-nudge.mjs`
   - `isIdleReport`: BOTH tool_response AND tool_output idle (null/undefined/blank string); non-string non-null = report. Do **not** pre-collapse via extractResponse before decide.
   - `decide(payload)`:
     - invalid payload / missing tool_input object → none
     - nested if `Object.hasOwn(payload,'agent_id') || Object.hasOwn(payload,'agentId') || Object.hasOwn(payload,'agentID')` → none
     - tool_name is Task family: `task` | `agent` | endsWith `.task` | `.agent` (case-insensitive) — OC `isTaskTool` parity
     - idle → inject
   - Context (OC-native): single re-prompt of the same task agent to extract report; do not re-dispatch task/agent; if still no report → UNRESOLVED, do not loop.
   - Never throws.

2. **Thin plugin** `core/opencode/plugin/agent-idle-nudge.ts`
   - `tool.execute.after` only; fail-open.
   - Map platform `input` only for nested keys (agent_id/agentId/agentID) — never from spoofable args.
   - Map tool_response and tool_output from **distinct** output fields when present (not single extractResponse collapse).
   - On inject: `output.metadata.agent_idle_nudge = context` (dual_nudge carrier precedent). Never call applyDualNudge / dual_status.
   - Optional: obsAppend event type if allowlisted cheaply; not required for #ac-4.1.

3. **Registration — FOUR surfaces in lockstep**
   - `core/opencode/opencode.json.example`
   - root `opencode.json`
   - `defaultOcPluginPaths()` in vendor-core.mjs
   - `CANONICAL_OC_PLUGINS` in `cron-a-dispatch.mjs` (list only — **not** prepareOpencodeDataHome / create path)
   - Tests: all four include `agent-idle-nudge.ts` (extend vendor-core + seed tests)

4. **Tests** `agent-idle-nudge.test.mjs` (+ plugin mapper tests)
   - main-loop idle → inject
   - nested agent_id / agentId / agentID present (incl. `''`/`0`/`null`) → none
   - non-empty report; empty response + real tool_output → none
   - malformed → none; fail-open
   - context matches OC-native wording (no SendMessage requirement)

### Gap B — reaper oc-data cleanup

1. **`defaultRmOcDataHome(stateDir, issueNumber)`**
   - path = `join(stateDir, \`oc-data-${issueNumber}\`)`
   - strip trailing slashes; require `/\/oc-data-\d+$/` before `rmSync(path, { recursive: true, force: true })`
   - never delete `oc-data-42-backup` etc.
   - best-effort; never throws

2. **Seam** `opts.rmOcDataHome` defaulting like `rmOutputLog`.

3. **Call sites**
   | Path | rmOcDataHome? | Why |
   |---|---|---|
   | crashRecover → **blocked** (count ≥ ceiling, no PR) | YES | #ac-4.2 |
   | crashRecover → **ready** (under ceiling, no PR) | **NO** | #ac-4.3 |
   | crashRecover → PR exists (no relabel) | YES | credentials in oc-data; not active ready re-dispatch; prepareOpencodeDataHome recreates |
   | orphan-cleaned (holderMissing) | YES | dual F2 — auth.json residue otherwise permanent |
   | completed-cleaned | YES | terminal |
   | keep-branch | NO | not safe terminal |

4. **Tests** in reaper.test.mjs
   - blocked → called
   - ready under ceiling → not called
   - PR exists dead holder → called
   - orphan-cleaned → called
   - completed-cleaned → called
   - path guard unit for defaultRmOcDataHome
   - RED/GREEN #ac-4.4

## Non-goals (hard)

- Do **not** change `prepareOpencodeDataHome` / oc-data **create** path in cron-a-dispatch (CANONICAL_OC_PLUGINS list edit is allowed).
- Do **not** edit cron-a-exit graceful path (reference only).
- Do **not** change dual-nudge.mjs / obs-eye dual branch behavior.
- No CC hook edits; no #301 prose residuals; no agent `model:` in feature commit.
- Full stateDir-wide sweep of orphan oc-data with **no** worktree entry is **out of issue AC scope** (residual S3 accepted; orphan-cleaned covers the reaper worktree path).

## Residual risks (accepted, honest)

- **S3 residual:** oc-data with no worktree entry and never seen by reaper listWorktrees stays until manual cleanup or future sweep — not in #ac-4.2 call sites; orphan-cleaned covers missing-holder worktrees.
- **Signal class:** metadata carrier matches dual_nudge + #ac-4.1 wording; if OC runtime later exposes a stronger additionalContext API, can upgrade without changing decide.
- Dual-eye path isolation: design does not touch applyDualNudge.

## Task split

| Task | Scope | ACs |
|---|---|---|
| **task-1** | pure idle decide + thin plugin + 4-surface registration + tests | #ac-4.1, #ac-4.4 idle |
| **task-2** | reaper rmOcDataHome + call sites + tests | #ac-4.2, #ac-4.3, #ac-4.4 cleanup |

## Demo

1. main-loop idle → metadata inject  
2. nested agent_id/agentId/agentID → none  
3. falsy-but-present → none  
4. reaper blocked → oc-data removed  
5. reaper ready → oc-data kept  
6. path guard rejects backup basename  
7. node --test green; fail-before/pass-after story  

## Spec dual merge summary

| Id | Sev | Disposition |
|---|---|---|
| F1 / reg surfaces | high | **fixed in design** — four surfaces incl. CANONICAL_OC_PLUGINS |
| F2 orphan-cleaned | high | **fixed** — call rmOcDataHome |
| F3/S2 signal class | high | **resolved** — #ac-4.1 allows obs/metadata; lock dual_nudge carrier |
| F4 SendMessage | med | **fixed** — oc_native_context |
| F5/S1 agentID | med/high | **fixed** — three key names, hasOwn |
| F6 PR+oc-data | med | **fixed** — rm when PR exists |
| F7 extractResponse | med | **fixed** — distinct fields |
| F8 reg tests | low | **fixed** with F1 tests |
| S3 no-worktree sweep | med | **accepted residual** (out of AC call-site scope) |

**HARD-GATE 1 (headless):** dual ISSUES absorbed into design; no unresolved ≥ medium blocking implement.
