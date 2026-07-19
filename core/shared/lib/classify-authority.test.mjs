/** @description Locked tests for classify top-level-only authority. */
import test from "node:test";
import assert from "node:assert/strict";
import { decideClassifyAuthority } from "./classify-authority.mjs";

test("build top-level allow", () => {
  const d = decideClassifyAuthority({ agent: "build", sessionId: "ses_1" });
  assert.equal(d.ok, true);
});

test("child session deny even for build", () => {
  const d = decideClassifyAuthority({
    agent: "build",
    sessionId: "ses_child",
    parentSessionId: "ses_parent",
  });
  assert.equal(d.ok, false);
  assert.match(d.reason, /child session/);
});

test("executor deny", () => {
  const d = decideClassifyAuthority({ agent: "executor-high", sessionId: "ses_1" });
  assert.equal(d.ok, false);
  assert.match(d.reason, /executor-high|brief only/);
});

test("test-author / planner / adversary deny", () => {
  for (const agent of ["test-author", "planner", "adversary-family-1", "plan-reviewer-family-1"]) {
    const d = decideClassifyAuthority({ agent, sessionId: "ses_1" });
    assert.equal(d.ok, false, agent);
  }
});

test("unknown agent empty + no parent allow (compat)", () => {
  const d = decideClassifyAuthority({ sessionId: "ses_1" });
  assert.equal(d.ok, true);
});

test("unknown agent empty + parent deny", () => {
  const d = decideClassifyAuthority({ parentSessionId: "ses_p" });
  assert.equal(d.ok, false);
});
