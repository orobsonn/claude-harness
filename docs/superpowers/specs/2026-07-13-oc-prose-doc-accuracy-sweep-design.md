# Spec — oc-prose-doc-accuracy-sweep (issue #301)

**feature_id:** `oc-prose-doc-accuracy-sweep`  
**Mode:** light  
**Priority:** P1 · Size M  
**Hard rule:** `somente_prosa` — prose/docs only; no production `.mjs`/`.ts` logic; no agent `model:` field changes in the feature commit.

## Product outcome

OC harness prose must not lie to the operator about models, headless detection, release deploy paths, or config-error escalation.

## User journeys

- **#uj-1:** sniper agent prose model names match `harness.routing.json`.
- **#uj-2:** OC `releases.md` points at instructions file OC actually loads (not phantom `.claude/CLAUDE.md` for OC-only).
- **#uj-3:** config-error on a hand → critical exception path in OC orchestrating-delivery prose (not retry ladder).
- **#uj-4:** OC headless detection prose does not treat `CLAUDE_CODE_REMOTE` as native OC signal.

## Acceptance criteria (tightened after dual spec-adversary)

- **#ac-3.1:** `CLAUDE_CODE_REMOTE` has **zero occurrences** in:
  - `core/opencode/skills/triaging-requests/SKILL.md`
  - `core/opencode/skills/orchestrating-delivery/SKILL.md`  
  Delete-only for that token. **No** optional note that re-introduces the name. Demo: grep → empty in both files.
- **#ac-3.1b:** After the edit, both skills still list as HEADLESS signals: (1) autonomous / VPS cron / "without asking" trigger text, (2) `$HARNESS_OBSERVABILITY_RUN_PATH`, (3) `$HARNESS_OC_DATA_HOME`. Demo greps assert presence of those two env names in both files.
- **#ac-3.2:** all 6 sniper agent md files cite exact routing model names in **description** prose:
  - low pair → `xai/grok-build-0.1`
  - medium pair → `xai/grok-4.3`
  - high pair → `xai/grok-4.5`  
  **no** `MiMo`, `MiniMax`, or `Qwen` in those 6 files. Frontmatter `model:` lines must remain unchanged.
- **#ac-3.3:** `core/opencode/rules/releases.md` lines ~64/66:
  1. do **not** cite `.claude/CLAUDE.md` as deploy-default path;
  2. **do** cite project-root **`AGENTS.md`** (optionally "or project-root `CLAUDE.md` if that is the project's instruction file");
  3. do **not** invent `.opencode/AGENTS.md` as the project deploy-signal file.
- **#ac-3.4:** Inside `### Escalation ladder` in `orchestrating-delivery/SKILL.md`, an explicit paragraph/bullet contains **all** of: `CONFIG_ERROR`, `critical exception`, and `NOT` + `K=1` (or equivalent "never retry / never tier-bump"). Grep alone on orphan fidelity mentions is insufficient — the binding must live in the ladder section. Prefer also cross-ref at fidelity deny lines (~204/250): route to critical exception, do not retry.
- **#ac-3.5:** `git diff` of the feature does **not** change any agent `model:` field and does **not** touch production `.mjs`/`.ts` outside tests (ideally no `.mjs`/`.ts` at all).

## Locked decisions

- **somente_prosa**
- **referencia_modelos_reais:** `core/opencode/harness.routing.json` sniper tiers (lines 24–30)
- **referencia_cc_config_error:** CC “Hand config-error → critical exception (NOT a K=1 escalation)”
- **headless_delete_only:** remove `CLAUDE_CODE_REMOTE` token entirely from the two OC skills (no re-scope note)
- **releases_positive_path:** project-root `AGENTS.md` (not `.opencode/AGENTS.md`)

## Evidence (before) — file:line

### 1. Headless signal (#ac-3.1 / #ac-3.1b / #uj-4)

| File | Line | Current prose |
|---|---|---|
| `core/opencode/skills/triaging-requests/SKILL.md` | 37 | `env $CLAUDE_CODE_REMOTE is set` listed as HEADLESS signal |
| `core/opencode/skills/orchestrating-delivery/SKILL.md` | 51 | `$CLAUDE_CODE_REMOTE` listed among HEADLESS env signals |

**Target:** delete `$CLAUDE_CODE_REMOTE` from both lists. Keep: autonomous trigger text, `$HARNESS_OBSERVABILITY_RUN_PATH`, `$HARNESS_OC_DATA_HOME`.

### 2. Sniper model prose (#ac-3.2 / #uj-1)

Routing truth (`core/opencode/harness.routing.json`):

| Tier | Model |
|---|---|
| low | `xai/grok-build-0.1` |
| medium | `xai/grok-4.3` |
| high | `xai/grok-4.5` |

| File | Line | Wrong prose | Target |
|---|---|---|---|
| `sniper-low.md` | 2 | `MiMo V2.5 via the Go plan` | `xai/grok-build-0.1` |
| `sniper-low-spawn.md` | 2 | `MiMo V2.5 via the Go plan` | `xai/grok-build-0.1` |
| `sniper-medium.md` | 2 | `MiniMax M2.5` | `xai/grok-4.3` |
| `sniper-medium-spawn.md` | 2 | `MiniMax M2.5` | `xai/grok-4.3` |
| `sniper-high.md` | 2 | `Strong fixer (Qwen)` | `xai/grok-4.5` |
| `sniper-high-spawn.md` | 2 | `Strong fixer (Qwen)` | `xai/grok-4.5` |

**Hard:** edit **description** prose only; leave frontmatter `model:` lines untouched.

### 3. releases.md path (#ac-3.3 / #uj-2)

| File | Lines | Current | Target |
|---|---|---|---|
| `core/opencode/rules/releases.md` | 64, 66 | `<projeto>/.claude/CLAUDE.md` | project-root `AGENTS.md` (optionally dual with root `CLAUDE.md` if that is the project's instruction file). Never `.opencode/AGENTS.md` as project deploy-signal. |

### 4. CONFIG_ERROR ladder (#ac-3.4 / #uj-3)

| File | Lines | Current gap |
|---|---|---|
| `core/opencode/skills/orchestrating-delivery/SKILL.md` | 204, 250 | `CONFIG_ERROR` only as fidelity-missing spawn deny |
| same | 254–256 | Ladder: retry → bump → critical — **no** CONFIG_ERROR → critical (NOT K=1) |

**CC reference** (~line 385): Hand config-error → critical exception (NOT a K=1 escalation).

**Target OC prose inside Escalation ladder:**

```
**Hand CONFIG_ERROR → critical exception (NOT a K=1 escalation):** when a hand
dispatch fails precondition / never ran (e.g. missing fidelity_pass stamp,
missing/invalid setup, CONFIG_ERROR from spawn), do NOT retry same tier and do
NOT bump tier. Route to CRITICAL EXCEPTION: INTERACTIVE surface to operator in
pt-br product language; HEADLESS record as open PR risk item.
```

Optional cross-ref at ~204/250: "route to critical exception — do not retry".

## Spec adversary dual (Phase 0)

| Eye | dual_status contribution | Result |
|---|---|---|
| primary (adversary) | ISSUES | S1 high: AC re-scope loophole; S2–S4 medium: native signals, releases positive path, CONFIG_ERROR NOT-K=1 binding |
| secondary (adversary-openai) | ISSUES | Confirmed live code defects match UJs (expected pre-impl); no additional spec hole beyond primary after re-dispatch |

**dual_status:** `both`  
**Action taken:** tightened #ac-3.1 (delete-only), added #ac-3.1b, locked releases positive path, locked ladder binding text for #ac-3.4. Residual S5 low accepted (demo already lists per-tier greps).

**HARD-GATE 1 (headless):** residual ≥ medium from primary addressed in this revision → proceed to plan.

## Non-goals

- No change to any agent frontmatter `model:` field in the feature commit
- No change to `harness.routing.json`
- No production `.mjs` / `.ts` logic
- No Claude Code pipeline content edits
- Residual from #300 (`git --no-pager push` detection) out of scope

## Scope paths (only)

1. `core/opencode/skills/triaging-requests/SKILL.md`
2. `core/opencode/skills/orchestrating-delivery/SKILL.md`
3. `core/opencode/agents/sniper-low.md`
4. `core/opencode/agents/sniper-low-spawn.md`
5. `core/opencode/agents/sniper-medium.md`
6. `core/opencode/agents/sniper-medium-spawn.md`
7. `core/opencode/agents/sniper-high.md`
8. `core/opencode/agents/sniper-high-spawn.md`
9. `core/opencode/rules/releases.md`

## Demo (from UJs/ACs)

1. `grep CLAUDE_CODE_REMOTE` on the two skills → empty
2. both skills still contain `HARNESS_OBSERVABILITY_RUN_PATH` and `HARNESS_OC_DATA_HOME`
3. `grep -i 'MiMo|MiniMax|Qwen' core/opencode/agents/sniper-*.md` → empty
4. per-tier: low files cite `xai/grok-build-0.1`; medium `xai/grok-4.3`; high `xai/grok-4.5`
5. releases.md has no `.claude/CLAUDE.md`; cites `AGENTS.md`
6. Escalation ladder section contains CONFIG_ERROR + critical exception + NOT K=1
7. `git diff` has no `model:` line changes and no production `.mjs`/`.ts`

## Task split

- **T1:** headless prose (#ac-3.1, #ac-3.1b) + CONFIG_ERROR ladder (#ac-3.4) in the two skills
- **T2:** sniper model prose ×6 (#ac-3.2)
- **T3:** releases.md path (#ac-3.3)
