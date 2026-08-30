# Codex Native Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Vendor the complete applicable delivery harness into native Codex surfaces with verified model routing and deterministic rails only where they provide leverage.

**Architecture:** `core/codex/` is the source tree. Its vendor output uses `.codex/` for Codex configuration, agents, hooks, rules, and metadata, and `.agents/skills/` for repository skills. A single policy hook owns critical per-event decisions; the rest of the pipeline is skills and AGENTS guidance.

**Tech Stack:** Node.js 18+ built-ins, TOML/JSON/Markdown, Codex CLI 0.151.0+, Node test runner.

**Spec:** `docs/superpowers/specs/2026-08-30-codex-native-port-design.md`

## Global Constraints

- Do not add dependencies or a second orchestration engine.
- Every behavior change follows red → green → full affected suite.
- Use Luna/low only for narrow mechanical work, Terra/medium for execution and tests, Sol/high or xhigh for planning, adversarial, security, and sensitive ambiguity.
- Sandbox and native permission policy are the boundary; hooks are explicitly documented as rails.
- Preserve operator-owned configuration and never weaken protected `.codex/` paths to ease vendoring.

---

### Task 1: Capability matrix and native contract

**Files:**
- Create: `core/codex/capability-matrix.json`
- Create: `core/codex/capability-matrix.mjs`
- Create: `core/codex/capability-matrix.test.mjs`
- Create: `core/codex/docs/OPERATOR-GUIDE.md`

**Interfaces:**
- Consumes: `core/claude-code/`, `core/opencode/`, and current Codex documentation.
- Produces: one record per source surface with `source`, `category`, `status`, `codex_surface`, `verification`, and `residual_risk`.

- [ ] **Step 1: Write the failing matrix-contract test**

```js
test('every production runtime surface is adjudicated once', () => {
  const matrix = readMatrix();
  assert.ok(matrix.some((row) => row.category === 'hooks' && row.status === 'deterministic'));
  assert.ok(matrix.every((row) => row.verification && row.residual_risk));
  assert.deepEqual(unadjudicatedSources(matrix), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test core/codex/capability-matrix.test.mjs`

Expected: `ERR_MODULE_NOT_FOUND` because the matrix and reader do not exist.

- [ ] **Step 3: Write minimal implementation**

Record every role, skill, rule, hook/plugin, permission, lifecycle, shared primitive, cross-family eye, and VPS/Orca surface. The guide names runtime trust and hook limitations instead of treating unsupported controls as parity.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test core/codex/capability-matrix.test.mjs && node core/codex/capability-matrix.mjs --check`

Expected: PASS and a zero-missing-surface report.

### Task 2: Agents, skills, rules, and routing

**Files:**
- Create: `core/codex/agents/{planner,plan-reviewer,adversary,security,compliance,executor,test-author,harvester,shipper}.toml`
- Create: `core/codex/skills/harness-*/SKILL.md`
- Create: `core/codex/rules/protected-operations.rules`
- Create: `core/codex/harness.routing.json`
- Create: `core/codex/model-routing.mjs`
- Create: `core/codex/model-routing.test.mjs`

**Interfaces:**
- Consumes: a role and `low|medium|high|critical` work classification.
- Produces: `{ model, reasoning_effort, sandbox_mode }` and narrow Codex custom-agent TOML files.

- [ ] **Step 1: Write the failing routing tests**

```js
test('critical security selects Sol xhigh and read-only', () => {
  assert.deepEqual(resolveRoute('security', 'critical'), {
    model: 'gpt-5.6', reasoning_effort: 'xhigh', sandbox_mode: 'read-only'
  });
});
test('mechanical harvest selects Luna low', () => {
  assert.equal(resolveRoute('harvester', 'low').model, 'gpt-5.6-luna');
});
```

- [ ] **Step 2: Verify red**

Run: `node --test core/codex/model-routing.test.mjs`

Expected: module missing.

- [ ] **Step 3: Implement minimum catalog**

Create one agent per responsibility, route metadata, concise skills that port active workflow contracts, and command rules with positive and negative rule examples. Hands receive their model at dispatch, not through duplicated low/medium/high agent files.

- [ ] **Step 4: Verify green and Codex parsing**

Run: `node --test core/codex/model-routing.test.mjs core/codex/agents-manifest.test.mjs && codex --strict-config exec --sandbox read-only 'List the Codex custom agents available in this repository.'`

Expected: all tests PASS and Codex loads repository configuration without a parse error.

### Task 3: Single-owner critical lifecycle hook

**Files:**
- Create: `core/codex/hooks/policy.mjs`
- Create: `core/codex/hooks/policy.test.mjs`
- Create: `core/codex/hooks.json`
- Create: `core/codex/hook-smoke.mjs`

**Interfaces:**
- Consumes: official-shaped Codex hook JSON from stdin.
- Produces: a documented `PreToolUse` or `PermissionRequest` decision and an atomic per-event audit record.

- [ ] **Step 1: Write failing deny tests**

```js
test('pre-tool hook denies force push before Bash runs', () => {
  const out = invoke({ hook_event_name: 'PreToolUse', tool_name: 'Bash',
    tool_input: { command: 'git push --force origin main' } });
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
});
test('apply_patch cannot mutate harness-owned paths', () => {
  assert.equal(invoke(edit('.codex/hooks.json')).hookSpecificOutput.permissionDecision, 'deny');
});
```

- [ ] **Step 2: Verify red**

Run: `node --test core/codex/hooks/policy.test.mjs`

Expected: module missing.

- [ ] **Step 3: Implement one synchronous policy hook**

Validate event shape, normalize only permitted tool inputs, emit official decision JSON, use atomic write/rename for validated per-event audit records, and limit stop continuation to one. Do not infer subagent role from unsupported payload fields.

- [ ] **Step 4: Verify green plus real smoke**

Run: `node --test core/codex/hooks/policy.test.mjs && node core/codex/hook-smoke.mjs && codex --strict-config exec --sandbox read-only 'Run no commands; confirm the project hook configuration is recognized.'`

Expected: tests PASS, smoke proves official payload handling, and Codex accepts the hook config.

### Task 4: Vendor, update, package, and runtime fixture

**Files:**
- Modify: `core/claude-code/skills/initializing-projects/references/vendor-core.mjs`
- Modify: `core/claude-code/skills/initializing-projects/references/vendor-core.test.mjs`
- Modify: `package.json`
- Modify: `scripts/parity-manifest.mjs`
- Modify: `scripts/package-artifact.test.mjs`
- Create: `core/codex/vendor-contract.test.mjs`

**Interfaces:**
- Consumes: source repository plus `--runtime codex|all`.
- Produces: a non-clobbering, idempotent Codex vendor tree.

- [ ] **Step 1: Write failing vendor tests**

```js
test('runtime codex creates only Codex and shared artifacts', () => {
  const result = vendor({ runtime: 'codex', target: fixture });
  assert.ok(existsSync(join(fixture, '.codex', 'hooks.json')));
  assert.ok(existsSync(join(fixture, '.agents', 'skills')));
  assert.ok(!existsSync(join(fixture, '.opencode')));
});
test('second Codex vendor is byte-idempotent and preserves user config', () => {
  assert.deepEqual(runTwiceWithUserConfig(), runOnceWithUserConfig());
});
```

- [ ] **Step 2: Verify red**

Run: `node --test core/codex/vendor-contract.test.mjs`

Expected: runtime `codex` is rejected by the existing vendor target normalizer.

- [ ] **Step 3: Implement source resolution and non-clobbering vendor**

Add `codex` and `all` to runtime normalization, copy the Codex source excluding tests, generate ownership/version manifests, merge the root AGENTS block, and retain an existing user `.codex/config.toml` untouched.

- [ ] **Step 4: Verify green, package, and runtime fixture**

Run: `node --test core/codex/vendor-contract.test.mjs core/claude-code/skills/initializing-projects/references/vendor-core.test.mjs scripts/package-artifact.test.mjs && npm pack --dry-run`

Expected: tests PASS and package file list includes `core/codex`.

### Task 5: Full verification and adversarial completion audit

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Create: `docs/codex-runtime-gaps-2026-08-30-final.md`

**Interfaces:**
- Consumes: all prior test evidence and actual Codex CLI output.
- Produces: a traceable operator handoff and residual-risk report.

- [ ] **Step 1: Write failing completion-audit checks**

```js
test('capability matrix has no unadjudicated production surface', () => {
  assert.equal(unadjudicatedRows().length, 0);
});
test('vendor artifact includes every native Codex runtime file', () => {
  assert.deepEqual(missingArtifactPaths(), []);
});
```

- [ ] **Step 2: Verify red before documentation closes gaps**

Run: `node --test core/codex/capability-matrix.test.mjs core/codex/vendor-contract.test.mjs`

Expected: a missing acceptance artifact or unadjudicated row fails until the prior implementation is complete.

- [ ] **Step 3: Complete operator documentation and residual audit**

Document installation, trust, permission modes, `$` skills, custom agents, model dispatch, hook scope and bypasses, update, and all unsupported/omitted surfaces. Update changelog under `Unreleased` without changing version until a release milestone is requested.

- [ ] **Step 4: Run final evidence suite**

Run: `npm test && node scripts/parity-manifest.mjs --check && node scripts/package-artifact.test.mjs && codex --strict-config exec --sandbox read-only 'Summarize active repository guidance, skills, custom agents, hooks, and rules without making changes.'`

Expected: every command exits 0; the final Codex output acknowledges the vendored surfaces; the adversarial audit has no unaddressed blocker.

