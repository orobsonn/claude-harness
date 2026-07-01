import { test } from "node:test";
import assert from "node:assert/strict";
import { driveCrossFamily } from "./cross-family.mjs";
import { normalizeSeverity, securityVerdict, classifyFindings, DEDUP_FIELDS } from "./merge-findings.mjs";
import { ROLES } from "./codex-adversary.mjs";

const sec = (over = {}) => ({
  description: "leak", severity: "high", scope: "src/auth.ts",
  evidence: "fn login", fix_hint: "sanitize", ...over,
});
const ON = { HARNESS_CODEX_ADVERSARY: "1", OPENAI_API_KEY: "sk-x" };
const OK = { ok: true, reason: "" };

// --- registry ---------------------------------------------------------------
test("ROLES.security is findings-shaped with severity-based dedup", () => {
  assert.equal(ROLES.security.shape, "findings");
  assert.deepEqual(ROLES.security.dedupFields, ["scope", "severity", "evidence"]);
});

// --- severity normalization (A2) --------------------------------------------
test("normalizeSeverity maps any family's strings; unknown => high (conservative)", () => {
  assert.equal(normalizeSeverity("Critical"), "high");
  assert.equal(normalizeSeverity("HIGH"), "high");
  assert.equal(normalizeSeverity("moderate"), "medium");
  assert.equal(normalizeSeverity("low"), "low");
  assert.equal(normalizeSeverity("weird-value"), "high");
});

test("securityVerdict gates on high/medium and normalizes cross-family severity", () => {
  assert.equal(securityVerdict([]), "SECURE");
  assert.equal(securityVerdict([sec({ severity: "low" })]), "SECURE");
  assert.equal(securityVerdict([sec({ severity: "Critical" })]), "UNSAFE");
  assert.equal(securityVerdict([sec({ severity: "medium" })]), "UNSAFE");
});

// --- dedup per-shape (A1) ----------------------------------------------------
test("security dedup keeps two distinct findings in the same scope (no category collapse)", () => {
  const a = sec({ severity: "high", evidence: "fn login" });
  const b = sec({ severity: "medium", evidence: "fn refresh" });
  const { agreed, needsCrosscheck } = classifyFindings([a], [b], DEDUP_FIELDS.security);
  assert.equal(agreed.length, 0);
  assert.equal(needsCrosscheck.length, 2, "distinct findings are NOT collapsed");
});

test("security dedup marks a genuinely shared finding as agreed", () => {
  const shared = sec({ severity: "high", evidence: "fn login" });
  const { agreed } = classifyFindings([shared], [{ ...shared }], DEDUP_FIELDS.security);
  assert.equal(agreed.length, 1);
  assert.deepEqual(agreed[0].found_by, ["claude", "codex"]);
});

// --- driver role=security (policy B bidirectional) --------------------------
test("driveCrossFamily(security): codex-only finding is pending Claude refutation, not in gate yet", () => {
  const claudeOnly = sec({ scope: "src/claude.ts" });
  const codexOnly = sec({ scope: "src/codex.ts" });
  const runAttack = () => ({ available: true, issues: [codexOnly] });
  const runRefute = ({ key }) => ({ key, refuted: false, argument: "real", refuter: "codex" });
  const r = driveCrossFamily({
    role: "security", taskJson: {}, claudeIssues: [claudeOnly], env: ON,
    runAttack, runRefute, availability: OK,
  });
  assert.equal(r.role, "security");
  assert.deepEqual(r.pendingClaudeRefutation.map((i) => i.scope), ["src/codex.ts"]);
  // codex-only NOT in findings yet → gate verdict computed on Claude+agreed only.
  assert.ok(!r.findings.map((f) => f.scope).includes("src/codex.ts"));
  assert.equal(r.verdict, "UNSAFE"); // the surviving claude-only high gates
});

test("driveCrossFamily(security): toggle off => Claude-only verdict (fail-open)", () => {
  const r = driveCrossFamily({ role: "security", taskJson: {}, claudeIssues: [sec({ severity: "low" })], env: {} });
  assert.equal(r.enabled, false);
  assert.equal(r.verdict, "SECURE"); // identical to Claude-only
});

// --- A3: a compose/path defect fails OPEN, never throws ----------------------
test("driveCrossFamily: a compose failure degrades to passthrough, never throws (fail-open)", () => {
  const claude = [sec()];
  const runAttack = () => assert.fail("attack must not run when compose throws");
  let r;
  assert.doesNotThrow(() => {
    r = driveCrossFamily({
      role: "nonexistent-role", taskJson: {}, claudeIssues: claude, env: ON,
      runAttack, availability: OK,
    });
  });
  assert.equal(r.available, false);
  assert.deepEqual(r.findings, claude);
  assert.match(r.reason, /compose\/attack failed/);
});
