# Adversary Proportionality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep OpenCode adversarial review focused on contract-breaking risks without promoting rare hypothetical chains into new architecture.

**Architecture:** Add a concise qualification rule to the adversary's upfront-spec instructions and a matching disposition rule to the delivery conductor. A small textual regression test locks the required limits; no runtime state, new gate, or retry system is introduced.

**Tech Stack:** Markdown agent/skill contracts; Node.js built-in test runner.

## Global Constraints

- Preserve real blockers: violated ACs/contracts, likely material harm, and concrete security/privacy/irreversibility paths remain blocking.
- Treat unsupported rare chains as separate opportunities, not mandatory scope expansion.
- Do not introduce runtime code, new state, middleware, retries, or deterministic gates.

---

### Task 1: Lock the proportionality contract

**Files:**
- Create: `core/opencode/agents/adversary-proportionality.test.mjs`
- Modify: `core/opencode/agents/adversary.md`
- Modify: `core/opencode/skills/orchestrating-delivery/SKILL.md`

**Interfaces:**
- Consumes: the upfront-spec scope rule in `adversary.md` and material-finding disposition in `orchestrating-delivery/SKILL.md`.
- Produces: a prose contract that distinguishes a real delivery blocker from a separate hardening opportunity.

- [ ] **Step 1: Write the failing textual regression test**

```js
assert.match(adversary, /contract.*not.*robustness/i);
assert.match(adversary, /rare.*chain|hypothetical/i);
assert.match(orchestrator, /state machine|persistence|middleware/i);
assert.match(orchestrator, /separate issue|opportunity/i);
```

- [ ] **Step 2: Run the test and verify it fails because the new policy is absent**

Run: `node --test core/opencode/agents/adversary-proportionality.test.mjs`

Expected: FAIL because neither source currently defines the proportionality boundary.

- [ ] **Step 3: Add the minimal prose**

Add one compact section to the adversary's upfront-spec pass defining evidence-qualified blockers and stopping repeated hypothetical variations. Add one compact conductor rule that keeps the issue scope unless a qualifying blocker requires expansion.

- [ ] **Step 4: Run the focused test and the full suite**

Run: `node --test core/opencode/agents/adversary-proportionality.test.mjs && npm test`

Expected: both commands exit 0.

- [ ] **Step 5: Commit the implementation**

```bash
git add core/opencode/agents/adversary.md \
  core/opencode/agents/adversary-proportionality.test.mjs \
  core/opencode/skills/orchestrating-delivery/SKILL.md \
  docs/superpowers/plans/2026-08-11-adversary-proportionality.md
git commit -m "fix(opencode): limita escalada adversarial"
```
