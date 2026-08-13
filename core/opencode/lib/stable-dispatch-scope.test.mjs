/** @description Stable-plan task scope is validated, hashed, and frozen per dispatch call. */

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  claimActiveDispatch,
  readCanonicalTask,
  readDispatchRecord,
} from "./dispatch-scope.mjs";

const SESSION = "ses_stable_scope";
const FEATURE = "stable-scope";

function plan(scopePaths = ["src/a.ts"]) {
  return {
    feature_id: FEATURE,
    mode: "light",
    model_strategy: {
      hand_tiers: { low: "openai/gpt-5.6-luna", medium: "openai/gpt-5.6-luna", high: "openai/gpt-5.6-terra" },
      planner: "openai/gpt-5.6-sol", "plan-reviewer": "openai/gpt-5.6-sol", compliance: "openai/gpt-5.6-sol",
      adversary: "openai/gpt-5.6-sol", security: "openai/gpt-5.6-sol", shipper: "openai/gpt-5.6-luna", harvester: "openai/gpt-5.6-luna",
    },
    final_review: { compliance: true, adversary: true },
    demo: { type: "smoke", scenarios_from_refs: ["#uj-1"] },
    tasks: [{
      id: "task-1", title: "Freeze scope", description: "Freeze one stable task scope.", depends_on: [],
      severity: "medium", complexity: "medium", scope_paths: scopePaths, allowed_writes: ["findings.md"],
      resolved_judgments: { scope: "call-keyed" }, criterion_refs: ["#ac-1"],
      locked_tests: [{ id: "lt-1", path: "tests/a.test.mjs", assertion: "Given a claimed hand, When plan changes, Then its scope stays fixed" }],
      adversarial: { enabled: false, focus: [] },
    }],
  };
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stable-dispatch-"));
  const planPath = path.join(root, ".opencode", "plans", FEATURE, "execution-plan.json");
  const statePath = path.join(root, ".opencode", "plans", ".state", SESSION, "gate-state.json");
  fs.mkdirSync(path.dirname(planPath), { recursive: true });
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({ session_id: SESSION, feature_id: FEATURE, mode: "LIGHT", classified: true }));
  const bytes = `${JSON.stringify(plan())}\n`;
  fs.writeFileSync(planPath, bytes);
  return { root, planPath, firstHash: crypto.createHash("sha256").update(bytes).digest("hex"), close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("readCanonicalTask validates the stable plan and returns task plus factual file hash", () => {
  const f = fixture();
  try {
    const result = readCanonicalTask(f.root, FEATURE, "task-1");
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.planHash, f.firstHash);
    assert.deepEqual(result.task.scope_paths, ["src/a.ts"]);
  } finally { f.close(); }
});

test("claim freezes scope and plan hash even when stable plan is edited after the claim", () => {
  const f = fixture();
  try {
    const first = claimActiveDispatch(f.root, {
      sessionId: SESSION, callId: "call-one", role: "executor-low", taskId: "task-1", now: 1_000,
    });
    assert.equal(first.ok, true, first.reason);
    assert.deepEqual(first.claim.scope_paths, ["src/a.ts"]);
    assert.equal(first.claim.plan_hash, f.firstHash);

    const revisedBytes = `${JSON.stringify(plan(["src/a.ts", "src/widened.ts"]))}\n`;
    fs.writeFileSync(f.planPath, revisedBytes);
    const revisedHash = crypto.createHash("sha256").update(revisedBytes).digest("hex");

    const frozen = readDispatchRecord(f.root, { parentSessionId: SESSION, callId: "call-one" });
    assert.equal(frozen.ok, true, frozen.reason);
    assert.deepEqual(frozen.record.scope_paths, ["src/a.ts"]);
    assert.equal(frozen.record.plan_hash, f.firstHash);

    const second = claimActiveDispatch(f.root, {
      sessionId: SESSION, callId: "call-two", role: "executor-low", taskId: "task-1", now: 2_000,
    });
    assert.equal(second.ok, true, second.reason);
    assert.deepEqual(second.claim.scope_paths, ["src/a.ts", "src/widened.ts"]);
    assert.equal(second.claim.plan_hash, revisedHash);
  } finally { f.close(); }
});
