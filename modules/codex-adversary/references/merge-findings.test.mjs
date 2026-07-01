import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyFindings, finalizeFindings, dedupKey } from "./merge-findings.mjs";

const issue = (over = {}) => ({
  description: "x", category: "race", severity: "high",
  scope: "src/a.ts", evidence: "fn handleDelete line 14",
  fix_hint: "guard it", ...over,
});

test("dedupKey collapses same scope+category+evidence", () => {
  assert.equal(dedupKey(issue()), dedupKey(issue({ description: "different words" })));
});

test("an issue both families raise is agreed (no cross-check)", () => {
  const { agreed, needsCrosscheck } = classifyFindings([issue()], [issue()]);
  assert.equal(agreed.length, 1);
  assert.equal(needsCrosscheck.length, 0);
  assert.deepEqual(agreed[0].found_by.sort(), ["claude", "codex"]);
});

test("single-family issue goes to cross-check with the OTHER family as refuter", () => {
  const claudeOnly = issue({ scope: "src/claude.ts" });
  const codexOnly = issue({ scope: "src/codex.ts" });
  const { agreed, needsCrosscheck } = classifyFindings([claudeOnly], [codexOnly]);
  assert.equal(agreed.length, 0);
  assert.equal(needsCrosscheck.length, 2);
  const byScope = Object.fromEntries(needsCrosscheck.map((n) => [n.issue.scope, n]));
  assert.equal(byScope["src/claude.ts"].refuter, "codex");
  assert.equal(byScope["src/codex.ts"].refuter, "claude");
});

test("policy B: single-family finding survives unless refuted", () => {
  const claudeOnly = issue({ scope: "src/keep.ts" });
  const refuted = issue({ scope: "src/drop.ts" });
  const classified = classifyFindings([claudeOnly, refuted], []);
  const verdicts = [
    { key: dedupKey(refuted), refuted: true, argument: "unreachable: guarded upstream", refuter: "codex" },
    // src/keep.ts: codex could not refute -> no verdict / refuted:false
  ];
  const { findings, dropped } = finalizeFindings(classified, verdicts);
  const scopes = findings.map((f) => f.scope);
  assert.ok(scopes.includes("src/keep.ts"), "unrefuted minority finding is kept");
  assert.ok(!scopes.includes("src/drop.ts"), "refuted finding is dropped");
  assert.equal(dropped[0].scope, "src/drop.ts");
  assert.equal(dropped[0].refuted_by, "codex");
});

test("missing verdict keeps the finding (fail-open cross-check)", () => {
  const claudeOnly = issue({ scope: "src/nojudge.ts" });
  const classified = classifyFindings([claudeOnly], []);
  const { findings } = finalizeFindings(classified, []); // no verdicts at all
  assert.equal(findings.length, 1);
  assert.equal(findings[0].scope, "src/nojudge.ts");
});

test("agreed findings always pass through finalize", () => {
  const classified = classifyFindings([issue()], [issue()]);
  const { findings } = finalizeFindings(classified, []);
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0].found_by.sort(), ["claude", "codex"]);
});
