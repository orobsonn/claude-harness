# OpenCode Native Task Rails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent native OpenCode hands from altering frozen acceptance oracles, make an internally malformed bound-plan block self-heal safely, and classify hand capacity exhaustion without stopping the delivery flow.

**Architecture:** The dispatch record becomes the authoritative, call-keyed source of frozen paths derived only from the canonical bound plan. The plan-write gate rejects executor/sniper writes to those paths before positive scope matching, while the parent runs deterministic test gates. The plan gate replaces only one terminal, same-SHA reserved block with canonical bytes; ambiguity remains a deny.

**Tech Stack:** TypeScript OpenCode plugins, dependency-free Node test runner, JSON dispatch records.

## Global Constraints

- Preserve `task` as the only native hand dispatch path.
- Never trust test paths or plan bodies embedded in a model prompt.
- Do not claim a shell-level lock unless executor/sniper Bash write capability is removed or isolated.
- Maintain one patch release and Keep a Changelog/version sync.

---

### Task 1: Canonical frozen-path authority

**Files:**
- Modify: `core/opencode/lib/dispatch-scope.mjs`
- Modify: `core/opencode/plugin/lib/plan-write-decide.mjs`
- Modify: `core/opencode/plugin/plan-write-gate.ts`
- Modify: `core/opencode/plugin/lib/host-hand-capture.mjs`
- Test: `core/opencode/lib/dispatch-scope.test.mjs`
- Test: `core/opencode/plugin/plan-write-gate.test.mjs`
- Test: `core/opencode/plugin/lib/host-hand-capture.test.mjs`

- [ ] **Step 1: Write failing tests**

Assert that an executor dispatch record contains canonical `frozen_paths` from `locked_tests.path` and `fixture_paths`, that executor/sniper edit/patch/delete attempts to a frozen path inside broad `scope_paths` are denied, and that a captured hand record reports frozen violations.

- [ ] **Step 2: Run focused tests to verify RED**

Run: `node --test core/opencode/lib/dispatch-scope.test.mjs core/opencode/plugin/plan-write-gate.test.mjs core/opencode/plugin/lib/host-hand-capture.test.mjs`

Expected: failing assertions because native dispatch records do not yet carry or enforce frozen paths.

- [ ] **Step 3: Implement the smallest authority change**

Derive and validate `frozen_paths` only from the bound task. Persist it for executor/sniper, give test-author an exact writable surface, and deny frozen writes before scope allow. Recompute violations from baseline changes; a violation cannot produce a DONE record.

- [ ] **Step 4: Run focused tests to verify GREEN**

Run the command from Step 2. Expected: exit 0.

### Task 2: Robust canonical bound-plan prompt

**Files:**
- Modify: `core/opencode/plugin/plan-gate.ts`
- Test: `core/opencode/plugin/plan-gate.test.mjs`

- [ ] **Step 1: Write failing tests**

Cover one terminal reserved block with the current SHA and a partial/malicious body: it is replaced byte-for-byte by the canonical plan; zero blocks appends it; stale SHA, malformed/multiple/non-terminal blocks deny; a second pass is identical.

- [ ] **Step 2: Run the focused test to verify RED**

Run: `node --test core/opencode/plugin/plan-gate.test.mjs`

Expected: the partial current-SHA block is denied instead of normalized.

- [ ] **Step 3: Implement a strict block normalizer**

Use line-delimited markers, preserve the prefix unchanged, discard untrusted block content, and append exactly the canonical binding. Do not parse or merge a model-supplied body.

- [ ] **Step 4: Run the focused test to verify GREEN**

Run: `node --test core/opencode/plugin/plan-gate.test.mjs`. Expected: exit 0.

### Task 3: Capacity-exhaustion hand outcome

**Files:**
- Modify: `core/opencode/lib/hand-records.mjs`
- Modify: `core/opencode/plugin/lib/host-hand-capture.mjs`
- Modify: `core/opencode/skills/orchestrating-delivery/SKILL.md`
- Test: `core/opencode/lib/hand-records.test.mjs`
- Test: `core/opencode/plugin/lib/host-hand-capture.test.mjs`

- [ ] **Step 1: Write failing tests**

Assert that an output with no explicit hand status but the provider capacity signal is classified as a non-refusal capacity failure, never as an agent `BLOCKED` verdict.

- [ ] **Step 2: Run focused tests to verify RED**

Run: `node --test core/opencode/lib/hand-records.test.mjs core/opencode/plugin/lib/host-hand-capture.test.mjs`

Expected: the current adapter maps absence of an explicit status to BLOCKED.

- [ ] **Step 3: Implement minimal classification and route**

Persist a distinct non-DONE outcome for capacity exhaustion and require the conductor to consume it as a one-tier executor escalation with the existing partial diff, rather than surfacing a false refusal to the operator.

- [ ] **Step 4: Run focused tests to verify GREEN**

Run the command from Step 2. Expected: exit 0.

### Task 4: Patch release

**Files:**
- Modify: `package.json`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Run the full project verification**

Run the repository's OpenCode test suite and release checks. Expected: exit 0.

- [ ] **Step 2: Bump patch version and record the fixes**

Set the package version to the next patch after `v0.53.0` and add a Keep a Changelog entry describing the three native-task rails.

- [ ] **Step 3: Commit, push, PR, merge, tag, and publish the patch release**

Use a conventional Portuguese commit, selective staging, a PR with Summary/Test plan, squash merge, then create the matching tag and GitHub Release.
