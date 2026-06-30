import { test } from "node:test";
import assert from "node:assert/strict";
import { isEnabled, runCodexRefutation } from "./codex-adversary.mjs";
import { driveCrossFamily } from "./cross-family.mjs";

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
