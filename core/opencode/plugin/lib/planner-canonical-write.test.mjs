/** @description The plugin owns the canonical execution-plan.json: it writes what it hashed,
 * refuses without destroying a good plan, and binds without the orchestrator retyping anything.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readPlannerArtifact,
  reconcilePlannerStateFromDisk,
  semanticPlanHash,
  writeCanonicalPlan,
} from "./planner-artifact.mjs";
import { claimPlannerAttempt, completePlannerAttempt } from "./planner-state.mjs";
import { gateStatePath } from "../../../shared/lib/path-helpers.mjs";

const SESSION = "ses-canonical-write";
const FEATURE = "canonical-write";

function plan(overrides = {}) {
  return {
    feature_id: FEATURE,
    kind: "full",
    mode: "full",
    tasks: [{
      id: "task-1",
      severity: "medium",
      complexity: "medium",
      scope_paths: ["src/a.ts"],
      criterion_refs: ["#ac-1"],
      depends_on: [],
      locked_tests: [{ id: "lt-1", path: "src/a.test.ts", assertion: "Given a, When b, Then c" }],
    }],
    ...overrides,
  };
}

function root() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "oc-canonical-plan-"));
}

function planPath(dir) {
  return path.join(dir, ".opencode", "plans", `${SESSION}-${FEATURE}`, "execution-plan.json");
}

test("writes the returned plan at the canonical path and it reads back valid", () => {
  const dir = root();
  const written = writeCanonicalPlan(dir, SESSION, FEATURE, plan());
  assert.equal(written.ok, true);
  assert.equal(written.path, planPath(dir));
  const artifact = readPlannerArtifact(dir, SESSION, FEATURE);
  assert.equal(artifact.valid, true);
  assert.equal(artifact.semanticHash, semanticPlanHash(plan()));
});

test("a wrong-feature plan is refused and the existing canonical plan survives", () => {
  const dir = root();
  assert.equal(writeCanonicalPlan(dir, SESSION, FEATURE, plan()).ok, true);
  const before = fs.readFileSync(planPath(dir), "utf8");

  const refused = writeCanonicalPlan(dir, SESSION, FEATURE, plan({ feature_id: "other-feature" }));
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /feature_id/);
  assert.equal(fs.readFileSync(planPath(dir), "utf8"), before);
});

test("a structurally invalid plan is refused and the existing canonical plan survives", () => {
  const dir = root();
  assert.equal(writeCanonicalPlan(dir, SESSION, FEATURE, plan()).ok, true);
  const before = fs.readFileSync(planPath(dir), "utf8");

  const refused = writeCanonicalPlan(dir, SESSION, FEATURE, plan({ tasks: [{}] }));
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /structural validation/);
  assert.equal(fs.readFileSync(planPath(dir), "utf8"), before);
  assert.equal(fs.readdirSync(path.dirname(planPath(dir))).filter((f) => f.endsWith(".tmp")).length, 0);
});

test("plugin-authored plan binds to usable without any orchestrator transcription", () => {
  const dir = root();
  const sp = gateStatePath({ projectRoot: dir, runtime: "opencode", sessionId: SESSION });
  assert.equal(sp.ok, true);
  fs.mkdirSync(path.dirname(sp.path), { recursive: true });
  fs.writeFileSync(sp.path, JSON.stringify({ session_id: SESSION, feature_id: FEATURE }));

  const returned = plan();
  const claimed = claimPlannerAttempt(
    { session_id: SESSION, feature_id: FEATURE },
    {
      role: "planner",
      callId: "call-1",
      token: "token-1",
      sessionId: SESSION,
      featureId: FEATURE,
      model: "openai/planner",
      baselinePlan: { exists: false, fingerprint: "missing" },
      now: 1,
    },
  );
  assert.equal(claimed.ok, true);
  const completed = completePlannerAttempt(claimed.state, {
    callId: "call-1",
    token: "token-1",
    resultKind: "usable_plan",
    planHash: semanticPlanHash(returned),
    now: 2,
  });
  assert.equal(completed.state.planner_status, "plan_pending_write");

  // What the hook does: persist the hashed object itself, then reconcile.
  assert.equal(writeCanonicalPlan(dir, SESSION, FEATURE, returned).ok, true);
  fs.writeFileSync(sp.path, JSON.stringify(completed.state));
  const reconciled = reconcilePlannerStateFromDisk(dir, SESSION);

  assert.equal(reconciled.ok, true);
  assert.equal(reconciled.state.planner_status, "usable");
  assert.equal(reconciled.state.planner_plan_binding.semantic_hash, semanticPlanHash(returned));
});

test("a paraphrased plan cannot bind — the hash gate still holds against hand-editing", () => {
  const dir = root();
  const sp = gateStatePath({ projectRoot: dir, runtime: "opencode", sessionId: SESSION });
  fs.mkdirSync(path.dirname(sp.path), { recursive: true });

  const returned = plan();
  const paraphrased = plan({
    tasks: [{ ...returned.tasks[0], locked_tests: [{ id: "lt-1", path: "src/a.test.ts", assertion: "a works" }] }],
  });
  assert.equal(writeCanonicalPlan(dir, SESSION, FEATURE, paraphrased).ok, true);
  fs.writeFileSync(sp.path, JSON.stringify({
    session_id: SESSION,
    feature_id: FEATURE,
    planner_status: "plan_pending_write",
    planner_primary_attempts: 1,
    planner_active_attempt: {
      call_id: "call-1",
      token: "token-1",
      role: "planner",
      session_id: SESSION,
      feature_id: FEATURE,
      status: "plan_returned",
      returned_plan_hash: semanticPlanHash(returned),
      baseline_plan: { exists: false, fingerprint: "missing" },
    },
  }));

  const reconciled = reconcilePlannerStateFromDisk(dir, SESSION);
  assert.equal(reconciled.ok, true);
  assert.notEqual(reconciled.state.planner_status, "usable");
});
