/** @description Locked tests for path-helpers (T2). PathResult API only, never throw. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { planDir } from "./path-helpers.mjs";

test("t2-plan-dir: OC and Claude planDir are feature-stable without a session prefix", () => {
  const oc = planDir({
    runtime: "opencode",
    projectRoot: "/tmp/project",
    sessionId: "ses_abc123",
    featureId: "oc-port-phase-1",
  });
  assert.equal(oc.ok, true);
  assert.ok(oc.path.endsWith("/oc-port-phase-1"));
  assert.ok(!oc.path.includes("ses_abc123"));

  const claude = planDir({
    runtime: "claude",
    projectRoot: "/tmp/project",
    featureId: "oc-port-phase-1",
  });
  assert.equal(claude.ok, true);
  assert.ok(claude.path.endsWith("/oc-port-phase-1"));
  assert.ok(!claude.path.includes("ses_"));
  assert.ok(!claude.path.includes("session"));
});

test("t2-path-result: unsafe ids yield PathResult ok false without throw", () => {
  const ignoredSession = planDir({
    runtime: "opencode",
    projectRoot: "/tmp/p",
    sessionId: "ses..dotdot",
    featureId: "ok-id",
  });
  assert.deepEqual(ignoredSession, { ok: true, path: "/tmp/p/.opencode/plans/ok-id" });

  const badFeature = planDir({
    runtime: "claude",
    projectRoot: "/tmp/p",
    featureId: "../traverse",
  });
  assert.equal(badFeature.ok, false);

  assert.doesNotThrow(() => {
    const r = planDir({ featureId: "a/b" });
    assert.equal(r.ok, false);
  });
});
