# OpenCode Claude-Parity Reset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove OpenCode-only workflow engines and make its delivery semantics follow Claude Code.

**Architecture:** Use one stable feature plan written by the planner. Keep only thin host adapters for
classification, factual gates, capture, observation and compaction recovery; phase progression remains
model-owned prose.

**Tech Stack:** Node.js ESM, OpenCode TypeScript plugins/native tools, `node:test`.

**Spec:** `docs/superpowers/specs/2026-08-13-opencode-claude-parity-reset-design.md`

## Global Constraints

- Claude Code is the behavioral reference.
- No new state field, retry counter, scheduler, coordinator or fallback search.
- Stable plan path is `.opencode/plans/<feature_id>/execution-plan.json`.
- Existing factual scope/capture/ancestry rails remain.
- Tests are written and observed failing before production edits.

---

### Task 1: Freeze the parity boundary

**Files:**
- Create: `core/opencode/plugin/claude-parity-reset.test.mjs`
- Modify: `scripts/parity-manifest.mjs`
- Modify: `scripts/parity-manifest.test.mjs`
- Modify: `docs/specs/oc-port/oc-plugin-module-manifest.json`

**Interfaces:**
- Consumes: current OpenCode source inventory and Claude Code stable-plan contract.
- Produces: a test that fails while OC-only engines/paths remain and a manifest that rejects their return.

- [ ] Write tests asserting the removal list is absent, plan paths are feature-stable, planner is the
      direct writer, and todo/resume/bound-plan language is absent.
- [ ] Run the focused test and confirm it fails on current `feature-resume`, `planner-recovery`,
      `sync-harness-todo` and session-scoped path references.
- [ ] Update the parity manifest only after the runtime removal makes the test pass.

### Task 2: Replace planner lifecycle with direct stable-plan authorship

**Files:**
- Modify: `core/opencode/tools/classify.ts`
- Modify: `core/opencode/tools/lib/classify-persist.mjs`
- Modify: `core/opencode/agents/planner.md`
- Modify: `core/opencode/plugin/plan-write-gate.ts`
- Modify: `core/opencode/plugin/plan-gate.ts`
- Modify: `core/opencode/plugin/obs-plan-write.ts`
- Modify: `core/opencode/lib/dispatch-scope.mjs`
- Delete: `core/opencode/plugin/planner-recovery.ts`
- Delete: `core/opencode/lib/planner-state.mjs`
- Delete: `core/opencode/lib/planner-artifact.mjs`
- Delete: `core/opencode/plugin/lib/planner-brief.mjs`
- Delete: `core/opencode/plugin/lib/planner-result.mjs`
- Update the corresponding tests.

**Interfaces:**
- Produces: `classify({mode, feature_id}) -> {plan_path, mode, feature_id, action}` where `plan_path`
  is stable; `readCanonicalTask(projectRoot, featureId, taskId)` derives task scope and plan hash from
  the validated stable file.

- [ ] Write failing tests for classify-without-stub, planner direct write, build write denial and
      downstream validation without binding.
- [ ] Simplify classify to persist only triage state and return the stable path.
- [ ] Make planner write/validate that path and make plan-write-gate the sole authorship rail.
- [ ] Make plan-gate and dispatch-scope read/validate/hash the stable plan directly.
- [ ] Remove planner lifecycle modules and all live imports; run the focused gate/dispatch tests.

### Task 3: Remove automatic resume, verdict and todo engines

**Files:**
- Delete: `core/opencode/lib/feature-resume.mjs`
- Delete: `core/opencode/lib/classify-resume.mjs`
- Delete: `core/opencode/lib/runtime-todo-projection.mjs`
- Delete: `core/opencode/lib/todo-projection.mjs`
- Delete: `core/opencode/tools/sync-harness-todo.ts`
- Modify: `core/opencode/plugin/obs-eye.ts`
- Modify: `core/opencode/plugin/marker-authority.ts`
- Modify: `core/opencode/plugin/lib/session-state.mjs`
- Modify: `core/opencode/plugin/reinject-state.ts`
- Modify: `core/opencode/skills/triaging-requests/SKILL.md`
- Modify: `core/opencode/skills/orchestrating-delivery/SKILL.md`
- Modify: `core/opencode/agents/build.md`
- Update/delete corresponding tests and live probes.

**Interfaces:**
- Produces: explicit-resume prose that reads the stable path; no host selection/adoption/verdict/todo
  policy.

- [ ] Write failing prose/runtime tests proving explicit resume does not call planner/reviewer and
      same-session compaction only reports the stable path/task count.
- [ ] Remove auto-resume and verdict mutation from classify/obs/session-state.
- [ ] Remove todo metadata/tool calls without changing marker authority.
- [ ] Port the simple Claude Code resume/planning prose and delete recovery exceptions.
- [ ] Run focused classify/reinject/marker/obs/skill tests.

### Task 4: Vendor closure, lifecycle simplification and live proof

**Files:**
- Modify: `core/claude-code/skills/initializing-projects/references/vendor-core.mjs`
- Modify: `core/vps/cron-a-dispatch.mjs`
- Modify: `core/opencode/skills/updating-harness/SKILL.md`
- Delete or narrow OpenCode-only lifecycle helpers/tests that no longer have a Claude counterpart.
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces: exact vendor/plugin inventory and a simple model-driven update flow matching Claude Code.

- [ ] Update retired-file ledgers, runtime completeness and plugin catalogs for every deletion.
- [ ] Replace the OpenCode update coordinator prose with the Claude Code selective vendor/PR flow,
      adapted only for `.opencode` and host permissions.
- [ ] Vendor into a temporary project; assert remaining plugins import and factories return hooks.
- [ ] Run focused tests, full `npm test`, `git diff --check` and package dry-run with a writable npm cache.
- [ ] Run one real local OpenCode session that classifies, writes/reviews a stable plan and resumes it
      by explicit instruction without creating/reviewing another plan.
