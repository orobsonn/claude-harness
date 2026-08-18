import { test } from "node:test";
import assert from "node:assert/strict";
import { driveCrossFamily } from "./cross-family.mjs";
import { normalizeSeverity, securityVerdict, classifyFindings, DEDUP_FIELDS, armingOf } from "./merge-findings.mjs";
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

// --- arming axis (rules/unarmed-defects.md) ---------------------------------
test("armingOf defaults to armed and only reads the declaration at the HEAD of description", () => {
  assert.equal(armingOf(sec()), "armed", "no declaration => armed");
  assert.equal(armingOf(sec({ description: "UNARMED · REPRO: traced — needs two shards" })), "unarmed");
  assert.equal(armingOf(sec({ description: "ARMED · REPRO: reproduced — overwrite" })), "armed");
  assert.equal(
    armingOf(sec({ description: "the retry path is unarmed only under concurrency" })),
    "armed",
    "the word appearing mid-prose is not a declaration"
  );
  assert.equal(armingOf(sec({ arming: "unarmed", description: "ARMED · REPRO: traced — x" })), "armed",
    "a model-emitted `arming` key is NOT a declaration channel — it can never outrank the prose head");
});

test("parking is OPT-IN: a parked UNARMED high still gates by DEFAULT, and only a supervised caller may excuse it", () => {
  const parked = sec({ severity: "high", description: "UNARMED · REPRO: traced — two tenants per shard. REARM: >= 2 tenants on one shard" });

  // The default is the UNATTENDED posture. core/vps/run-cron-review.mjs imports this function to decide
  // auto-merge eligibility, with no orchestrator, no park acceptance, no issue and no operator warning
  // on that path — an eye's own prose must never be able to open a merge gate.
  assert.equal(securityVerdict([parked]), "UNSAFE", "default is arming-blind: a parked high still BLOCKS");

  assert.equal(securityVerdict([parked], { honorParking: true }), "SECURE", "supervised checkpoint may park");
  assert.equal(
    securityVerdict([parked, sec({ severity: "medium" })], { honorParking: true }),
    "UNSAFE",
    "one armed medium alongside a parked high still gates"
  );
});

test("cross-family arming DISAGREEMENT resolves to armed and is recorded, never silently dropped", () => {
  const claude = sec({ description: "ARMED · REPRO: traced — token compared with ===" });
  const codex = sec({ description: "UNARMED · REPRO: not-reproduced — needs a colliding rotation window" });
  const { agreed } = classifyFindings([claude], [codex], DEDUP_FIELDS.security);
  assert.equal(agreed.length, 1, "same scope+severity+evidence collapses to one issue");
  assert.equal(armingOf(agreed[0]), "armed", "disagreement resolves conservatively to armed");
  assert.ok(agreed[0].arming_conflict, "the disagreement is recorded, not destroyed");
  assert.equal(securityVerdict(agreed, { honorParking: true }), "UNSAFE", "the contested finding still gates");
});

test("both families agreeing on UNARMED keeps it parked under a supervised verdict", () => {
  const d = "UNARMED · REPRO: traced — needs two tenants on one shard. REARM: >= 2 tenants on one shard";
  const { agreed } = classifyFindings([sec({ description: d })], [sec({ description: d })], DEDUP_FIELDS.security);
  assert.equal(armingOf(agreed[0]), "unarmed");
  assert.equal(agreed[0].arming_conflict, undefined);
  assert.equal(securityVerdict(agreed, { honorParking: true }), "SECURE");
  assert.equal(securityVerdict(agreed), "UNSAFE", "unattended still blocks");
});

test("a family duplicating ITSELF is never reported as a cross-family arming disagreement", () => {
  const a = sec({ description: "ARMED · REPRO: traced — token compared with ===" });
  const b = sec({ description: "UNARMED · REPRO: not-reproduced — needs a colliding window" });
  const { agreed, needsCrosscheck } = classifyFindings([a, b], [], DEDUP_FIELDS.security);
  const issue = (agreed[0] ?? needsCrosscheck[0].issue);
  assert.deepEqual(issue.found_by, ["claude"]);
  assert.equal(issue.arming_conflict, undefined, "same-family duplicate is not a contest");
});

test("a MISSING declaration is a format defect, not a contest — and never forges a conflict", () => {
  const declared = sec({ description: "UNARMED · REPRO: traced — needs two tenants. REARM: >= 2 tenants" });
  const silent = sec({ description: "no declaration at all" });
  const { agreed } = classifyFindings([declared], [silent], DEDUP_FIELDS.security);
  assert.equal(agreed[0].arming_conflict, undefined);
});

test("a contested finding is flipped to ARMED in the DESCRIPTION HEAD, where the prose-driven triage reads it", () => {
  const claude = sec({ description: "UNARMED · REPRO: not-reproduced — needs a colliding rotation window" });
  const codex = sec({ description: "ARMED · REPRO: reproduced — token compared with ===" });
  const { agreed } = classifyFindings([claude], [codex], DEDUP_FIELDS.security);
  assert.match(agreed[0].description, /^ARMED \(contested: claude called it unarmed\)/);
  assert.equal(armingOf(agreed[0]), "armed", "the head no longer says UNARMED, so the triage cannot park it");
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
