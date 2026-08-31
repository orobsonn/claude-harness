# OpenCode Single Build Primary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `build` the only OpenCode primary while preserving an isolated, one-shot harness lifecycle capability.

**Architecture:** Lifecycle commands remain user shortcuts but execute in `build`. A native tool and entry-gate authority check carry the privileged action; ordinary product requests still enter triage and dispatch the existing internal roles.

**Tech Stack:** OpenCode agents/commands/skills, TypeScript plugin tools, Node test runner.

**Spec:** `docs/superpowers/specs/2026-08-30-opencode-single-build-primary-design.md`

## Global Constraints

- Only root interactive `build` may run a lifecycle operation.
- Lifecycle never classifies, creates a plan, or dispatches a task.
- Lifecycle commands may only run the pinned vendoring CLI or the routing tool.
- Normal product delivery keeps the existing triage and internal planner/reviewer/hand flow.

---

### Task 1: Lock and implement the single-primary catalog

**Files:**

- Modify: `core/opencode/agents/agents-manifest.test.mjs`
- Modify: `core/opencode/agents/build.md`
- Delete: `core/opencode/agents/plan.md`, `core/opencode/agents/harness-config.md`
- Modify: `core/opencode/AGENTS.md`, `core/opencode/docs/OPERATOR-GUIDE.md`

- [ ] Write a failing catalog test that expects only `build` with `mode: primary` and command files without `agent:` routing.
- [ ] Run the targeted test and observe the pre-change failure.
- [ ] Remove the two primary agents; update the manifest, build instructions, and operator guide.
- [ ] Run the targeted test and the agent catalog tests.

### Task 2: Move lifecycle authority into native build-only tools

**Files:**

- Create: `core/opencode/tools/lifecycle-update.ts`
- Create: `core/opencode/tools/lifecycle-update-core.mjs`
- Create: `core/opencode/tools/lifecycle-update-core.test.mjs`
- Modify: `core/opencode/plugin/entry-gate.ts`, `core/opencode/plugin/entry-gate.test.mjs`
- Modify: `core/opencode/command/updating-harness.md`, `core/opencode/command/configuring-model-routing.md`
- Modify: `core/opencode/skills/updating-harness/SKILL.md`, `core/opencode/skills/configuring-model-routing/SKILL.md`, `core/opencode/skills/triaging-requests/SKILL.md`

- [ ] Write failing tests for fixed lifecycle argv and root-build authority.
- [ ] Run those tests and observe their failure.
- [ ] Implement the native tool and allow only root `build`; deny child/fleet authority before execution.
- [ ] Update the commands and skills to use native tools without lifecycle lane switching.
- [ ] Run targeted tool and entry-gate tests.

### Task 3: Reconcile owned docs and run the full harness suite

**Files:**

- Modify: `core/opencode/agents/skill-catalog.test.mjs` and affected contract tests
- Delete or replace: lifecycle/plan-lane tests superseded by the single-primary contract

- [ ] Update obsolete contracts only after the new behavior is green.
- [ ] Run `npm test` and fix only regressions caused by the new contract.

### Task 4: Prove the runtime on the VPS

**Files:** none required.

- [ ] Vendor the resulting harness into an isolated VPS checkout.
- [ ] Run a live root `build` `/updating-harness` command and confirm no role switch, no classify, and a `merged` or `noop` lifecycle result.
- [ ] Run a live normal build request and confirm triage remains available and lifecycle does not run.
- [ ] Record the session ids and non-sensitive outcome evidence in the PR.
