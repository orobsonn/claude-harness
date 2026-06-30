import { test } from "node:test";
import assert from "node:assert/strict";
import { isEnabled, runCodexRefutation } from "./codex-adversary.mjs";
import { driveCrossFamily } from "./cross-family.mjs";
// Namespace import so tests for driveCrossFamilyVerdict (not yet exported) fail at call-time,
// NOT at import-time — preserving green/red isolation from the existing suite.
import * as crossFamilyMod from "./cross-family.mjs";

const issue = (over = {}) => ({
  description: "x", category: "race", severity: "high",
  scope: "src/a.ts", evidence: "fn f line 1", suggested_sniper_tier: "opus", fix_hint: "guard", ...over,
});

// --- toggle -----------------------------------------------------------------
test("isEnabled defaults OFF (opt-in)", () => {
  assert.equal(isEnabled({ env: {}, task: {} }), false);
});
test("isEnabled honors env HARNESS_CODEX_ADVERSARY", () => {
  assert.equal(isEnabled({ env: { HARNESS_CODEX_ADVERSARY: "1" }, task: {} }), true);
  assert.equal(isEnabled({ env: { HARNESS_CODEX_ADVERSARY: "off" }, task: { adversarial: { cross_family: true } } }), false);
});
test("isEnabled honors task.adversarial.cross_family", () => {
  assert.equal(isEnabled({ env: {}, task: { adversarial: { cross_family: true } } }), true);
});

// --- refutation (fail-open) -------------------------------------------------
test("runCodexRefutation keeps finding when codex unavailable", () => {
  const v = runCodexRefutation({ finding: issue(), taskJson: {}, key: "k", availability: { ok: false, reason: "no codex" } });
  assert.equal(v.refuted, false);
  assert.equal(v.refuter, "codex");
});
test("runCodexRefutation parses a refuted verdict from injected spawn", () => {
  const fakeSpawn = () => ({ status: 0, stdout: "```json\n{\"refuted\":true,\"argument\":\"guarded upstream\"}\n```" });
  const v = runCodexRefutation({ finding: issue(), taskJson: {}, key: "k", spawn: fakeSpawn, availability: { ok: true, reason: "" } });
  assert.equal(v.refuted, true);
  assert.match(v.argument, /guarded/);
});

// --- driver -----------------------------------------------------------------
test("driveCrossFamily: toggle off => passthrough (claude-only)", () => {
  const claude = [issue()];
  const r = driveCrossFamily({ taskJson: {}, claudeIssues: claude, env: {} });
  assert.equal(r.enabled, false);
  assert.deepEqual(r.findings, claude);
  assert.equal(r.pendingClaudeRefutation.length, 0);
});

test("driveCrossFamily: enabled but headless-no-key => passthrough", () => {
  const r = driveCrossFamily({ taskJson: { adversarial: { cross_family: true } }, claudeIssues: [issue()], env: { CLAUDE_CODE_REMOTE: "1" } });
  assert.equal(r.enabled, true);
  assert.equal(r.available, false);
  assert.equal(r.findings.length, 1);
});

test("driveCrossFamily: agreed + codex-refutes-claude-only + claude-pending", () => {
  const claudeOnly = issue({ scope: "src/claude.ts" });
  const shared = issue({ scope: "src/shared.ts" });
  const codexOnly = issue({ scope: "src/codex.ts" });
  const env = { HARNESS_CODEX_ADVERSARY: "1", OPENAI_API_KEY: "sk-x" };

  const runAttack = () => ({ available: true, issues: [shared, codexOnly] });
  // Codex refutes the claude-only finding => it should be dropped.
  const runRefute = ({ key }) => ({ key, refuted: true, argument: "unreachable", refuter: "codex" });

  const r = driveCrossFamily({
    taskJson: {}, claudeIssues: [claudeOnly, shared], env,
    runAttack, runRefute, availability: { ok: true, reason: "" },
  });

  assert.equal(r.enabled, true);
  assert.equal(r.available, true);
  const scopes = r.findings.map((f) => f.scope);
  assert.ok(scopes.includes("src/shared.ts"), "agreed finding ships");
  assert.ok(!scopes.includes("src/claude.ts"), "refuted claude-only finding dropped");
  assert.equal(r.dropped[0].scope, "src/claude.ts");
  assert.deepEqual(r.pendingClaudeRefutation.map((i) => i.scope), ["src/codex.ts"]);
});

test("driveCrossFamily: unrefuted claude-only survives", () => {
  const claudeOnly = issue({ scope: "src/keep.ts" });
  const env = { HARNESS_CODEX_ADVERSARY: "1", OPENAI_API_KEY: "sk-x" };
  const runAttack = () => ({ available: true, issues: [] });
  const runRefute = ({ key }) => ({ key, refuted: false, argument: "real", refuter: "codex" });
  const r = driveCrossFamily({ taskJson: {}, claudeIssues: [claudeOnly], env, runAttack, runRefute, availability: { ok: true, reason: "" } });
  assert.ok(r.findings.map((f) => f.scope).includes("src/keep.ts"));
});

// ============================================================================
// TASK-1 LOCKED TESTS — verdict-shaped routing (cross-family.mjs shape branch)
//
// Assumed API (production code does NOT exist yet — tests 1, 2, 4 are RED):
//   export function driveCrossFamilyVerdict({ role, taskJson, claudeVerdict, runRole, env, availability })
//     role          — "plan-reviewer" (ROLES[role].shape === "verdict")
//     taskJson      — plan object or JSON string
//     claudeVerdict — { verdict, issues, planner_instructions } from the Claude plan-reviewer eye
//     runRole       — injectable ({ prompt, availability }) => { available, output?, reason? }
//                     analogous to driveCrossFamily's runAttack; defaults to runCodexRole.
//                     prompt is produced by composeRolePrompt({ role, taskJson }).
//     availability  — pre-checked { ok, reason } (injected in tests to bypass checkAvailability)
//     env           — process.env (toggle; pass HARNESS_CODEX_ADVERSARY:"1" to enable)
//   On success   : mergeVerdicts(claudeVerdict, runRole().output, { codexAvailable: true })
//   On fail-open : mergeVerdicts(claudeVerdict, {}, { codexAvailable: false })
//                  (returns the Claude verdict with sources.codex===null, never throws)
// ============================================================================

// [TASK-1 locked test 1] codex REVISE + claude APPROVE => merged REVISE (either-REVISE-wins),
// proving the verdict-shaped path is taken (not driveCrossFamily which returns findings[]).
test("driveCrossFamilyVerdict [t1]: codex REVISE + claude APPROVE => merged REVISE", () => {
  const claudeVerdict = { verdict: "APPROVE", issues: [], planner_instructions: "" };
  const runRole = () => ({
    available: true,
    output: { verdict: "REVISE", issues: [{ note: "flaw" }], planner_instructions: "fix X" },
  });
  const r = crossFamilyMod.driveCrossFamilyVerdict({
    role: "plan-reviewer",
    taskJson: {},
    claudeVerdict,
    env: { HARNESS_CODEX_ADVERSARY: "1", OPENAI_API_KEY: "sk-x" },
    availability: { ok: true, reason: "" },
    runRole,
  });
  assert.equal(r.verdict, "REVISE");
});

// [TASK-1 locked test 2] runRole receives a prompt from composeRolePrompt: contains the
// plan-reviewer verdict schema (planner_instructions, APPROVE/REVISE) and NOT the adversary
// issues[] schema (suggested_sniper_tier), proving composeRolePrompt is called before runRole.
test("driveCrossFamilyVerdict [t2]: runRole receives composeRolePrompt output (verdict schema, not adversary schema)", () => {
  let capturedPrompt = null;
  const runRole = ({ prompt }) => {
    capturedPrompt = prompt;
    return { available: true, output: { verdict: "APPROVE", issues: [], planner_instructions: "" } };
  };
  crossFamilyMod.driveCrossFamilyVerdict({
    role: "plan-reviewer",
    taskJson: { id: "test-plan" },
    claudeVerdict: { verdict: "APPROVE", issues: [], planner_instructions: "" },
    env: { HARNESS_CODEX_ADVERSARY: "1", OPENAI_API_KEY: "sk-x" },
    availability: { ok: true, reason: "" },
    runRole,
  });
  assert.ok(capturedPrompt !== null, "runRole must have been called with a prompt");
  // composeRolePrompt for plan-reviewer includes the verdict output contract
  assert.match(capturedPrompt, /planner_instructions/, "prompt contains verdict field planner_instructions");
  assert.match(capturedPrompt, /APPROVE|REVISE/, "prompt contains verdict values");
  // Must NOT be the adversary's schema (which carries suggested_sniper_tier / fix_hint in its contract)
  assert.doesNotMatch(capturedPrompt, /suggested_sniper_tier/, "prompt must not be the adversary issues[] schema");
});

// [TASK-1 locked test 3] Adversary role still takes the findings-shaped driveCrossFamily path
// (output has findings[]/pendingClaudeRefutation, not a single verdict field) — unchanged today.
// This test must be GREEN now and stay GREEN after the shape-routing branch is added.
test("driveCrossFamily [t3]: --role adversary output is findings-shaped (unchanged from today)", () => {
  const r = driveCrossFamily({
    role: "adversary",
    taskJson: {},
    claudeIssues: [issue()],
    env: {},
  });
  assert.ok(Array.isArray(r.findings), "findings must be an array");
  assert.ok(Array.isArray(r.pendingClaudeRefutation), "pendingClaudeRefutation must be an array");
  assert.equal(r.verdict, undefined, "adversary output must not have a top-level verdict field");
});

// [TASK-1 locked test 4] codex unavailable => fail-open: Claude verdict preserved, no throw.
test("driveCrossFamilyVerdict [t4]: codex unavailable => fail-open, claude verdict preserved, no throw", () => {
  const claudeVerdict = { verdict: "APPROVE", issues: [{ note: "ok" }], planner_instructions: "all good" };
  const runRole = () => ({ available: false, reason: "codex not found" });
  let r;
  assert.doesNotThrow(() => {
    r = crossFamilyMod.driveCrossFamilyVerdict({
      role: "plan-reviewer",
      taskJson: {},
      claudeVerdict,
      env: { HARNESS_CODEX_ADVERSARY: "1", OPENAI_API_KEY: "sk-x" },
      availability: { ok: false, reason: "codex not found" },
      runRole,
    });
  });
  assert.equal(r.verdict, "APPROVE", "fail-open must preserve the Claude verdict");
});

// ============================================================================
// TASK-2 LOCKED TESTS — runForRole routing (closes the CLI gap found in final review HIGH)
//
// Bug: main() in cross-family.mjs calls driveCrossFamily (findings-shaped) for ALL roles,
// including plan-reviewer which expects the verdict path. driveCrossFamilyVerdict is dead-code
// from the CLI perspective. The prior locked tests [t1/t2/t4] called driveCrossFamilyVerdict
// directly and never exercised the CLI routing — so the gap passed the unit gate.
//
// Assumed API (production code does NOT exist yet — tests below are RED):
//   export function runForRole({ role, taskJson, claudeInput, env, availability, runAttack, runRefute, runRole })
//     Routes by ROLES[role].shape:
//       shape 'verdict'  (plan-reviewer) → driveCrossFamilyVerdict({
//                                            role, taskJson, claudeVerdict: claudeInput,
//                                            runRole, env, availability })
//       shape 'findings' (adversary/security) → driveCrossFamily({
//                                                 role, taskJson, claudeIssues: claudeInput,
//                                                 runAttack, runRefute, env, availability })
//       unknown role → treat as findings (fail-open, same as today's behavior)
//     Returns the result of the chosen driver unchanged.
//   main() reads --task/--claude files and calls runForRole instead of driveCrossFamily directly.
// ============================================================================

// [TASK-2 test 1] plan-reviewer routes to verdict path: codex REVISE + claude APPROVE => REVISE.
// Proves runForRole selected driveCrossFamilyVerdict (result has .verdict string, not findings envelope).
test("runForRole [plan-reviewer]: routes to verdict path — codex REVISE + claude APPROVE => result.verdict === 'REVISE'", () => {
  const claudeInput = { verdict: "APPROVE", issues: [], planner_instructions: "" };
  const runRole = () => ({ available: true, output: { verdict: "REVISE", issues: [], planner_instructions: "fix" } });
  const r = crossFamilyMod.runForRole({
    role: "plan-reviewer",
    taskJson: {},
    claudeInput,
    env: { HARNESS_CODEX_ADVERSARY: "1", OPENAI_API_KEY: "sk-x" },
    availability: { ok: true, reason: "" },
    runRole,
  });
  // either-REVISE-wins: codex REVISE must override claude APPROVE
  assert.equal(r.verdict, "REVISE", "either-REVISE-wins: codex REVISE overrides claude APPROVE");
  // Must NOT be findings-shaped: mergeVerdicts output has no pendingClaudeRefutation array
  assert.ok(!Array.isArray(r.pendingClaudeRefutation),
    "verdict path must not produce a findings envelope (pendingClaudeRefutation must be absent)");
});

// [TASK-2 test 2] adversary routes to findings path: output is findings-shaped (no top-level verdict).
// Proves runForRole selected driveCrossFamily and did NOT discard findings as the buggy main() would.
test("runForRole [adversary]: routes to findings path — output has findings[]/pendingClaudeRefutation, no top-level verdict", () => {
  const claudeInput = [issue()];
  const runAttack = () => ({ available: true, issues: [] });
  const r = crossFamilyMod.runForRole({
    role: "adversary",
    taskJson: {},
    claudeInput,
    env: { HARNESS_CODEX_ADVERSARY: "1", OPENAI_API_KEY: "sk-x" },
    availability: { ok: true, reason: "" },
    runAttack,
  });
  // Must be findings-shaped
  assert.ok(Array.isArray(r.findings), "findings path must have findings[]");
  assert.ok(Array.isArray(r.pendingClaudeRefutation), "findings path must have pendingClaudeRefutation[]");
  // Adversary role never emits a top-level verdict (only security does via securityVerdict())
  assert.equal(r.verdict, undefined, "adversary findings path must not have a top-level verdict field");
});

// ============================================================================
// TASK-3 LOCKED TESTS — driveCrossFamilyVerdict robustness (toggle + fail-open)
//
// Two defects found by final review (Codex) in driveCrossFamilyVerdict:
//   1. Ignores the toggle: no isEnabled() call → with toggle OFF it still runs runRole.
//   2. Output without verdict vira REVISE espúrio: output:{} hits mergeVerdicts with
//      codexAvailable:true → normVerdict(undefined) === "REVISE" → spurious REVISE gate.
//
// Correct behaviour:
//   1. Toggle OFF (env HARNESS_CODEX_ADVERSARY:'0' + task.adversarial.cross_family:false) →
//      runRole must NOT be called; Claude verdict must be returned unchanged.
//   2. runRole returns {available:true, output:{}} (no verdict field) →
//      must fail-open: Claude verdict preserved, sources.codex === null.
// ============================================================================

// [TASK-3 test 1] toggle off: HARNESS_CODEX_ADVERSARY='0' + task cross_family:false =>
// runRole NOT called, Claude verdict preserved.
test("driveCrossFamilyVerdict [toggle off]: HARNESS_CODEX_ADVERSARY='0' + task cross_family:false => runRole NOT called, Claude verdict preserved", () => {
  let called = false;
  const runRole = () => { called = true; return { available: true, output: { verdict: "REVISE", issues: [], planner_instructions: "bad" } }; };
  const claudeVerdict = { verdict: "APPROVE", issues: [], planner_instructions: "" };
  const r = crossFamilyMod.driveCrossFamilyVerdict({
    role: "plan-reviewer",
    taskJson: { adversarial: { cross_family: false } },
    claudeVerdict,
    env: { HARNESS_CODEX_ADVERSARY: "0" },
    availability: { ok: true, reason: "" },
    runRole,
  });
  assert.equal(called, false, "runRole must NOT be called when toggle is off");
  assert.equal(r.verdict, "APPROVE", "Claude verdict must be preserved when toggle is off");
});

// [TASK-3 test 2] codex output without verdict field => fail-open, Claude verdict preserved,
// sources.codex === null (treated as unavailable, not a spurious REVISE).
test("driveCrossFamilyVerdict [codex output without verdict]: available true but output {} => fail-open, Claude verdict preserved, sources.codex null", () => {
  const runRole = () => ({ available: true, output: {} });
  const claudeVerdict = { verdict: "APPROVE", issues: [], planner_instructions: "ok" };
  const r = crossFamilyMod.driveCrossFamilyVerdict({
    role: "plan-reviewer",
    taskJson: {},
    claudeVerdict,
    env: { HARNESS_CODEX_ADVERSARY: "1", OPENAI_API_KEY: "sk-x" },
    availability: { ok: true, reason: "" },
    runRole,
  });
  assert.equal(r.verdict, "APPROVE", "fail-open: Claude verdict must be preserved when codex output has no verdict field");
  assert.equal(r.sources.codex, null, "fail-open: sources.codex must be null (not a spurious REVISE)");
});
