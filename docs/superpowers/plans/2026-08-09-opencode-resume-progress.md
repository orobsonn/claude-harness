# OpenCode Resume Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve validated delivery progress when an approved OpenCode feature is resumed more than once.

**Architecture:** Keep one canonical execution-plan identity while selecting the most advanced validated gate-state from that plan lineage. Separate canonical-plan ownership from immediate state provenance.

**Tech Stack:** Node.js ESM, `node:test`, OpenCode harness state artifacts.

## Global Constraints

- Preserve canonical plan and snapshot integrity checks.
- Do not use native todos as workflow authority.
- Do not mix progress from different approved plan identities.
- Exclude terminal, active-planner, malformed, or unbound candidates.
- Keep the change limited to OpenCode feature resume behavior.

---

### Task 1: Recover the latest valid progress from one plan lineage

**Files:**

- Modify: `core/opencode/lib/feature-resume.mjs`
- Test: `core/opencode/lib/feature-resume.test.mjs`

**Interfaces:**

- Consumes: gate-state JSON, canonical `execution-plan.json`, and planner snapshot binding.
- Produces: `findFeatureResume(projectRoot, featureId)` candidate with `sessionId`, canonical plan identity, valid `planPath`, state, and plan.

- [ ] **Step 1: Write failing tests**

```js
assert.equal(resume.sessionId, resumedSession);
assert.equal(resume.planSessionId, sourceSession);
assert.deepEqual(adoptedState.capture_verified, ["resume-feature/task-one@freeze"]);
assert.equal(adoptedState.resumed_from_session_id, sourceSession);
assert.equal(adoptedState.resume_state_source_session_id, resumedSession);
```

- [ ] **Step 2: Verify RED**

Run: `node --test core/opencode/lib/feature-resume.test.mjs`

Expected: FAIL because discovery only considers the first session that owns a plan directory.

- [ ] **Step 3: Implement minimal validated discovery**

```js
const candidates = listFeatureGateStates(projectRoot, featureId)
  .map(validateResumeCandidate)
  .filter(Boolean)
  .filter((candidate) => candidate.resumable)
  .sort(compareResumeProgress);
```

Resolve and group candidates by immutable bound-plan identity. Select progress only from the authoritative identity, then keep that identity's canonical session in `resumed_from_session_id` during adoption.

- [ ] **Step 4: Verify GREEN**

Run: `node --test core/opencode/lib/feature-resume.test.mjs`

Expected: PASS with later-session progress retained and no cross-plan progress reuse.

- [ ] **Step 5: Run relevant regressions**

Run: `node --test core/opencode/lib/feature-resume.test.mjs core/opencode/lib/planner-artifact.test.mjs core/opencode/plugin/reinject-state.test.mjs core/opencode/lib/todo-projection.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add core/opencode/lib/feature-resume.mjs core/opencode/lib/feature-resume.test.mjs docs/superpowers/specs/2026-08-09-opencode-resume-progress-design.md docs/superpowers/plans/2026-08-09-opencode-resume-progress.md
git commit -m "fix(opencode): preserva progresso ao retomar feature"
```
