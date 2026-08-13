/** @description Same-session, stable-plan compaction recovery. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { reinjectState } from "./reinject-state.ts";
import { buildSessionRecovery, encodeRecoveryPayload } from "./lib/session-state.mjs";

const { createReinjectStateHooks } = reinjectState.testApi;
const SESSION = "ses-stable-recovery";
const FEATURE = "stable-recovery";
const MODEL_STRATEGY = {
  hand_tiers: { low: "gemma4", medium: "glm-5.2", high: "kimi-k2.7-code" },
  planner: "openai/planner", "plan-reviewer": "openai/reviewer", compliance: "openai/compliance",
  adversary: "openai/adversary", security: "openai/security", shipper: "openai/shipper", harvester: "openai/harvester",
};

function fixture({ withPlan = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "oc-reinject-stable-")));
  const statePath = path.join(root, ".opencode", "plans", ".state", SESSION, "gate-state.json");
  const planPath = path.join(root, ".opencode", "plans", FEATURE, "execution-plan.json");
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({ session_id: SESSION, feature_id: FEATURE, mode: "FULL", classified: true }));
  if (withPlan) {
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.writeFileSync(planPath, JSON.stringify({
      feature_id: FEATURE,
      kind: "full",
      mode: "full",
      model_strategy: MODEL_STRATEGY,
      tasks: ["one", "two"].map((id) => ({
        id: `task-${id}`,
        severity: "low",
        complexity: "low",
        scope_paths: ["src/index.ts"],
        criterion_refs: ["#ac-1"],
        locked_tests: [],
        no_tests: true,
        depends_on: [],
      })),
    }));
  }
  return { root, statePath, planPath, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function payload(context) {
  return JSON.parse(context.split("\n")[1]);
}

test("compaction reports this session's stable plan without workflow inference", async () => {
  const f = fixture();
  try {
    const before = fs.readFileSync(f.statePath);
    const hooks = await createReinjectStateHooks(f.root, f.root);
    assert.equal(hooks.event, undefined);
    assert.equal(hooks.dispose, undefined);
    const output = { context: [] };
    await hooks["experimental.session.compacting"]({ sessionID: SESSION }, output);
    assert.equal(output.context.length, 1);
    assert.deepEqual(payload(output.context[0]), {
      schema: "harness.compaction-recovery.v1",
      mode: "FULL",
      feature_id: FEATURE,
      canonical_plan_path: `.opencode/plans/${FEATURE}/execution-plan.json`,
      plan_available: true,
      total_tasks: 2,
    });
    assert.doesNotMatch(output.context[0], /next|phase|review|planner|capture|verdict/i);
    assert.deepEqual(fs.readFileSync(f.statePath), before);
  } finally { f.cleanup(); }
});

test("missing or invalid stable plan degrades to triage facts without selecting a recovery action", () => {
  for (const invalid of [false, true]) {
    const f = fixture({ withPlan: invalid });
    try {
      if (invalid) fs.writeFileSync(f.planPath, "{");
      const recovered = buildSessionRecovery(f.root, SESSION);
      assert.equal(recovered.ok, true);
      assert.equal(payload(recovered.context).plan_available, false);
      assert.equal(payload(recovered.context).total_tasks, 0);
    } finally { f.cleanup(); }
  }
});

test("a different session cannot recover or mutate this session", async () => {
  const f = fixture();
  try {
    const before = fs.readFileSync(f.statePath);
    const hooks = await createReinjectStateHooks(f.root, f.root);
    const output = { context: [] };
    await hooks["experimental.session.compacting"]({ sessionID: "ses-other" }, output);
    assert.deepEqual(output.context, []);
    assert.deepEqual(fs.readFileSync(f.statePath), before);
  } finally { f.cleanup(); }
});

test("directory/worktree disagreement and a symlinked plan fail without leaking context", async () => {
  const f = fixture();
  const sibling = fs.mkdtempSync(path.join(os.tmpdir(), "oc-reinject-sibling-"));
  try {
    let hooks = await createReinjectStateHooks(sibling, f.root);
    let output = { context: [] };
    await hooks["experimental.session.compacting"]({ sessionID: SESSION }, output);
    assert.deepEqual(output.context, []);

    const outside = path.join(sibling, "plan.json");
    fs.writeFileSync(outside, fs.readFileSync(f.planPath));
    fs.rmSync(f.planPath);
    fs.symlinkSync(outside, f.planPath);
    hooks = await createReinjectStateHooks(f.root, f.root);
    output = { context: [] };
    await hooks["experimental.session.compacting"]({ sessionID: SESSION }, output);
    assert.equal(payload(output.context[0]).plan_available, false);
  } finally {
    f.cleanup();
    fs.rmSync(sibling, { recursive: true, force: true });
  }
});

test("recovery envelope obeys its UTF-8 byte ceiling", () => {
  const context = encodeRecoveryPayload({ schema: "harness.compaction-recovery.v1", value: "界".repeat(20_000) });
  assert.ok(context);
  assert.ok(Buffer.byteLength(context, "utf8") <= 8192);
  assert.equal(Buffer.from(context).toString("utf8"), context);
  assert.equal(payload(context).truncated, true);
});
