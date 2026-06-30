import { test } from "node:test";
import assert from "node:assert/strict";
import { composeRolePrompt, ROLES, runCodexRole } from "./codex-adversary.mjs";
import { mergeVerdicts } from "./merge-verdicts.mjs";

// --- role-generic prompt composition ---------------------------------------
test("composeRolePrompt(adversary) embeds the canonical taxonomy", () => {
  const p = composeRolePrompt({ role: "adversary", taskJson: { scope_paths: ["a.ts"] } });
  assert.match(p, /adversary/i);
  assert.match(p, /issues\[\]/);
  assert.match(p, /SKILL 1/);
});

test("composeRolePrompt(plan-reviewer) uses the verdict contract, no taxonomy skill", () => {
  const p = composeRolePrompt({ role: "plan-reviewer", taskJson: { plan: "x" } });
  assert.match(p, /plan-reviewer/i);
  assert.match(p, /APPROVE \| REVISE/);
  assert.ok(!/SKILL 1/.test(p), "plan-reviewer declares no skills");
});

test("composeRolePrompt throws on unknown role", () => {
  assert.throws(() => composeRolePrompt({ role: "nope", taskJson: {} }), /unknown cross-family role/);
});

test("ROLES declare a merge shape for each eye", () => {
  assert.equal(ROLES.adversary.shape, "findings");
  assert.equal(ROLES["plan-reviewer"].shape, "verdict");
});

test("runCodexRole returns parsed output for any shape (injected spawn)", () => {
  const fakeSpawn = () => ({ status: 0, stdout: "```json\n{\"verdict\":\"REVISE\",\"issues\":[]}\n```" });
  const r = runCodexRole({ prompt: "p", spawn: fakeSpawn, availability: { ok: true, reason: "" } });
  assert.equal(r.available, true);
  assert.equal(r.output.verdict, "REVISE");
});

// --- verdict merge (either-REVISE-wins) ------------------------------------
test("mergeVerdicts: either REVISE => REVISE, concerns unioned", () => {
  const claude = { verdict: "APPROVE", issues: [], planner_instructions: "" };
  const codex = { verdict: "REVISE", issues: [{ description: "race in task 3" }], planner_instructions: "split task 3" };
  const m = mergeVerdicts(claude, codex);
  assert.equal(m.verdict, "REVISE");
  assert.equal(m.issues.length, 1);
  assert.deepEqual(m.issues[0].found_by, ["codex"]);
  assert.match(m.planner_instructions, /split task 3/);
});

test("mergeVerdicts: APPROVE only when both approve", () => {
  const m = mergeVerdicts({ verdict: "APPROVE" }, { verdict: "APPROVE" });
  assert.equal(m.verdict, "APPROVE");
  assert.deepEqual(m.sources, { claude: "APPROVE", codex: "APPROVE" });
});

test("mergeVerdicts: codex unavailable => Claude-only verdict (no spurious REVISE)", () => {
  const m = mergeVerdicts({ verdict: "APPROVE", issues: [] }, {}, { codexAvailable: false });
  assert.equal(m.verdict, "APPROVE");
  assert.equal(m.sources.codex, null);
});

test("mergeVerdicts: unknown verdict string defaults to REVISE (conservative)", () => {
  const m = mergeVerdicts({ verdict: "MAYBE" }, { verdict: "APPROVE" });
  assert.equal(m.verdict, "REVISE");
});
