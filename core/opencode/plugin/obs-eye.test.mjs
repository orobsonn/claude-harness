/** @description OC obs-eye mirrors the CC lane's curated, fail-open eye observability. */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { obsEye } from "./obs-eye.ts";

const { createObsEyeHooks } = obsEye.testApi;
import { eventsPathFor, readEvents } from "../../shared/lib/obs-append.mjs";
import { semanticPlanHash } from "../lib/plan-hash.mjs";

const SESSION = "ses-obs-eye";
const FEATURE = "obs-eye";

function taskCall(role, response = "") {
  return {
    input: { tool: "task", sessionID: SESSION },
    output: {
      args: { subagent_type: role, feature_id: FEATURE },
      output: response,
      metadata: {},
    },
  };
}

async function withOutbox(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "obs-eye-"));
  const metaPath = path.join(root, "obs.json");
  const previous = process.env.HARNESS_OBSERVABILITY_RUN_PATH;
  fs.writeFileSync(metaPath, "{}", "utf8");
  process.env.HARNESS_OBSERVABILITY_RUN_PATH = metaPath;
  try {
    await run({ root, metaPath });
  } finally {
    if (previous === undefined) delete process.env.HARNESS_OBSERVABILITY_RUN_PATH;
    else process.env.HARNESS_OBSERVABILITY_RUN_PATH = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function seedBoundPlan(root) {
  const plan = {
    feature_id: FEATURE,
    kind: "full",
    mode: "full",
    model_strategy: {
      hand_tiers: { low: "gemma4", medium: "glm-5.2", high: "kimi-k2.7-code" },
      planner: "openai/planner", "plan-reviewer": "openai/reviewer", compliance: "openai/compliance",
      adversary: "openai/adversary", security: "openai/security", shipper: "openai/shipper", harvester: "openai/harvester",
    },
    tasks: [{ id: "task-1", severity: "medium", complexity: "medium", scope_paths: ["src/index.ts"], criterion_refs: ["#ac-1"], locked_tests: [], no_tests: true }],
  };
  const raw = Buffer.from(JSON.stringify(plan));
  const fileHash = crypto.createHash("sha256").update(raw).digest("hex");
  const planPath = path.join(root, ".opencode", "plans", `${SESSION}-${FEATURE}`, "execution-plan.json");
  const snapshotPath = path.join(root, ".opencode", "plans", ".state", SESSION, "bound-plans", `${fileHash}.json`);
  const statePath = path.join(root, ".opencode", "plans", ".state", SESSION, "gate-state.json");
  fs.mkdirSync(path.dirname(planPath), { recursive: true });
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
  fs.writeFileSync(planPath, raw);
  fs.writeFileSync(snapshotPath, raw);
  const binding = {
    session_id: SESSION, feature_id: FEATURE,
    snapshot_path: path.relative(root, snapshotPath), snapshot_hash: semanticPlanHash(plan), snapshot_file_hash: fileHash,
    semantic_hash: semanticPlanHash(plan), file_hash: fileHash, expected_model_strategy: plan.model_strategy,
  };
  fs.writeFileSync(statePath, JSON.stringify({ session_id: SESSION, feature_id: FEATURE, mode: "FULL", planner_status: "usable", planner_plan_binding: binding }));
  return { statePath, binding };
}

test("plan-reviewer appends the curated verdict without mutating task metadata", async () => {
  await withOutbox(async ({ root, metaPath }) => {
    const hooks = await createObsEyeHooks(root);
    const call = taskCall("plan-reviewer", '{"verdict":"APPROVE","findings":[]}');
    await hooks["tool.execute.after"](call.input, call.output);

    assert.deepEqual(call.output.metadata, {});
    assert.deepEqual(
      readEvents(metaPath).map(({ ts, ...event }) => event),
      [{ type: "plan-reviewed", verdict: "APPROVE", role: "plan-reviewer" }],
    );
  });
});

test("plan-reviewer APPROVE records the verdict only for the bound plan it reviewed", async () => {
  await withOutbox(async ({ root }) => {
    const { statePath, binding } = seedBoundPlan(root);

    const hooks = await createObsEyeHooks(root);
    const call = taskCall("plan-reviewer", '{"verdict":"APPROVE","findings":[]}');
    call.input.callID = "call-approved-review";
    await hooks["tool.execute.before"](call.input, call.output);
    await hooks["tool.execute.after"](call.input, call.output);

    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(state.plan_review_verdict, "APPROVE");
    assert.equal(state.planner_plan_binding.snapshot_file_hash, binding.snapshot_file_hash);
  });
});

test("a late plan-reviewer result cannot stamp a replacement plan", async () => {
  await withOutbox(async ({ root }) => {
    const { statePath } = seedBoundPlan(root);

    const hooks = await createObsEyeHooks(root);
    const call = taskCall("plan-reviewer", "Verdict: APPROVE");
    call.input.callID = "call-stale-review";
    await hooks["tool.execute.before"](call.input, call.output);
    const replaced = JSON.parse(fs.readFileSync(statePath, "utf8"));
    replaced.planner_plan_binding.snapshot_file_hash = "a".repeat(64);
    fs.writeFileSync(statePath, JSON.stringify(replaced));
    await hooks["tool.execute.after"](call.input, call.output);

    assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).plan_review_verdict, undefined);
  });
});

test("narrative verdict text never stamps plan approval", async () => {
  await withOutbox(async ({ root }) => {
    const { statePath } = seedBoundPlan(root);
    const hooks = await createObsEyeHooks(root);
    const call = taskCall("plan-reviewer", "I cannot APPROVE this plan yet.");
    call.input.callID = "call-narrative";
    await hooks["tool.execute.before"](call.input, call.output);
    await hooks["tool.execute.after"](call.input, call.output);
    assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).plan_review_verdict, undefined);
  });
});

test("adversary is spec-scoped before a plan and a raw eye after a full plan", async () => {
  await withOutbox(async ({ root, metaPath }) => {
    const hooks = await createObsEyeHooks(root);
    const first = taskCall("adversary", '{"issues":[]}');
    await hooks["tool.execute.after"](first.input, first.output);

    const planDir = path.join(root, ".opencode", "plans", `${SESSION}-${FEATURE}`);
    fs.mkdirSync(planDir, { recursive: true });
    fs.writeFileSync(
      path.join(planDir, "execution-plan.json"),
      JSON.stringify({
        kind: "full",
        mode: "full",
        feature_id: FEATURE,
        tasks: [{
          id: "task-1",
          severity: "medium",
          complexity: "medium",
          scope_paths: ["src/index.ts"],
          criterion_refs: ["#ac-1.1"],
          locked_tests: [{ id: "lt-1", path: "src/index.test.ts", assertion: "observable" }],
        }],
      }),
    );
    const second = taskCall("adversary", '{"issues":[]}');
    await hooks["tool.execute.after"](second.input, second.output);

    assert.deepEqual(
      readEvents(metaPath).map(({ ts, ...event }) => event),
      [
        { type: "spec-adversary", role: "adversary" },
        { type: "eye", role: "adversary" },
      ],
    );
  });
});

test("non-eye roles and non-task tools do not append", async () => {
  await withOutbox(async ({ root, metaPath }) => {
    const hooks = await createObsEyeHooks(root);
    const planner = taskCall("planner", "done");
    await hooks["tool.execute.after"](planner.input, planner.output);
    await hooks["tool.execute.after"](
      { tool: "bash", sessionID: SESSION },
      { args: { subagent_type: "compliance" }, output: "PASS" },
    );
    assert.deepEqual(readEvents(metaPath), []);
  });
});

test("missing outbox is fail-open and never creates an events file", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "obs-eye-missing-"));
  const metaPath = path.join(root, "missing.json");
  const previous = process.env.HARNESS_OBSERVABILITY_RUN_PATH;
  process.env.HARNESS_OBSERVABILITY_RUN_PATH = metaPath;
  try {
    const hooks = await createObsEyeHooks(root);
    const call = taskCall("compliance", "PASS");
    await assert.doesNotReject(() => hooks["tool.execute.after"](call.input, call.output));
    assert.equal(fs.existsSync(eventsPathFor(metaPath)), false);
  } finally {
    if (previous === undefined) delete process.env.HARNESS_OBSERVABILITY_RUN_PATH;
    else process.env.HARNESS_OBSERVABILITY_RUN_PATH = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("obs-eye has no dual runtime dependency", () => {
  const source = fs.readFileSync(fileURLToPath(new URL("./obs-eye.ts", import.meta.url)), "utf8");
  assert.doesNotMatch(source, /dual-nudge|dual_nudge|HARNESS_CODEX_ADVERSARY/);
});
