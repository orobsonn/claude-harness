/** @description Terminal delivery completion when bound plans freeze non-Ollama hand_tiers. */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { semanticPlanHash } from "../../lib/planner-artifact.mjs";
import { buildSessionRecovery, recordSessionCompletion } from "./session-state.mjs";

const SESSION_ID = "ses_terminal_delivery_fixture";
const FEATURE_ID = "terminal-delivery-fixture";
const TASK_ID = "task-1";
const CAPTURE_SHA = "a".repeat(40);

const OPENAI_MODEL_STRATEGY = {
  hand_tiers: {
    low: "openai/gpt-5.6-luna",
    medium: "openai/gpt-5.6-luna",
    high: "openai/gpt-5.6-terra",
  },
  planner: "openai/gpt-5.6-sol",
  "plan-reviewer": "openai/gpt-5.6-sol",
  compliance: "openai/gpt-5.6-terra",
  adversary: "openai/gpt-5.6-sol",
  security: "openai/gpt-5.6-sol",
  shipper: "openai/gpt-5.6-luna",
  harvester: "openai/gpt-5.6-luna",
};

function buildFullPlan() {
  return {
    feature_id: FEATURE_ID,
    kind: "full",
    mode: "light",
    version: "1.0",
    created_at: "2026-08-03T18:00:00.000Z",
    tasks: [
      {
        id: TASK_ID,
        title: "Fixture terminal delivery task",
        description: "Minimal full-plan task for session completion proof",
        depends_on: [],
        severity: "low",
        complexity: "low",
        scope_paths: ["core/opencode/plugin/lib/session-state.mjs"],
        criterion_refs: ["#ac-1"],
        locked_tests: [
          {
            id: "lt-fixture-terminal-delivery",
            path: "core/opencode/plugin/lib/session-state-terminal-delivery.test.mjs",
            assertion:
              "Given a terminal-ready bound OpenAI plan When recordSessionCompletion runs Then freeze authorizes completion",
            command: "node --test core/opencode/plugin/lib/session-state-terminal-delivery.test.mjs",
          },
        ],
        adversarial: { enabled: false, focus: [] },
      },
    ],
    model_strategy: OPENAI_MODEL_STRATEGY,
    final_review: { compliance: true, adversary: true },
    demo: { type: "markdown", scenarios_from_refs: ["#uj-1"] },
  };
}

/**
 * @param {{
 *   expectedOn?: "binding" | "last_attempt" | "none",
 * }} [opts]
 */
function setupTerminalFixture(opts = {}) {
  const expectedOn = opts.expectedOn ?? "binding";
  const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "session-state-terminal-")));
  const plan = buildFullPlan();
  const planRaw = `${JSON.stringify(plan, null, 2)}\n`;
  const fileHash = crypto.createHash("sha256").update(planRaw, "utf8").digest("hex");
  const semanticHash = semanticPlanHash(plan);

  const planDirPath = path.join(projectRoot, ".opencode", "plans", `${SESSION_ID}-${FEATURE_ID}`);
  const stateDir = path.join(projectRoot, ".opencode", "plans", ".state", SESSION_ID);
  const boundDir = path.join(stateDir, "bound-plans");
  fs.mkdirSync(planDirPath, { recursive: true });
  fs.mkdirSync(boundDir, { recursive: true });
  fs.mkdirSync(path.join(stateDir, "dispatch-records"), { recursive: true });

  const planRawPath = path.join(planDirPath, "execution-plan.json");
  const snapshotPath = path.join(boundDir, `${fileHash}.json`);
  fs.writeFileSync(planRawPath, planRaw, "utf8");
  fs.writeFileSync(snapshotPath, planRaw, "utf8");

  /** @type {Record<string, unknown>} */
  const binding = {
    call_id: "call_terminal_fixture",
    session_id: SESSION_ID,
    feature_id: FEATURE_ID,
    semantic_hash: semanticHash,
    file_hash: fileHash,
    snapshot_path: `.opencode/plans/.state/${SESSION_ID}/bound-plans/${fileHash}.json`,
    snapshot_hash: semanticHash,
    snapshot_file_hash: fileHash,
  };
  /** @type {Record<string, unknown>} */
  const lastAttempt = { result: "bound" };
  if (expectedOn === "binding") {
    binding.expected_model_strategy = structuredClone(OPENAI_MODEL_STRATEGY);
  } else if (expectedOn === "last_attempt") {
    lastAttempt.expected_model_strategy = structuredClone(OPENAI_MODEL_STRATEGY);
  }

  const gateStatePath = path.join(stateDir, "gate-state.json");
  fs.writeFileSync(
    gateStatePath,
    `${JSON.stringify(
      {
        session_id: SESSION_ID,
        feature_id: FEATURE_ID,
        mode: "LIGHT",
        classified: true,
        planner_status: "usable",
        planner_binding_error: null,
        planner_plan_binding: binding,
        planner_last_attempt: lastAttempt,
        hand_finished: [`${FEATURE_ID}/${TASK_ID}`],
        capture_verified: [`${FEATURE_ID}/${TASK_ID}@${CAPTURE_SHA}`],
        regate_pending: [],
        regate_passed: [],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return {
    projectRoot,
    sessionId: SESSION_ID,
    gateStatePath,
    cleanup: () => fs.rmSync(projectRoot, { recursive: true, force: true }),
  };
}

test("idle complete stamps retention for non-Ollama freeze on binding", () => {
  const fixture = setupTerminalFixture({ expectedOn: "binding" });
  try {
    const now = Date.UTC(2026, 7, 3, 18, 0, 0);
    const result = recordSessionCompletion(fixture.projectRoot, fixture.sessionId, {
      eventType: "session.idle",
      now,
      isAncestor: () => true,
    });
    assert.equal(result.ok, true);
    assert.equal(result.recorded, true);
    const persisted = JSON.parse(fs.readFileSync(fixture.gateStatePath, "utf8"));
    assert.equal(persisted.session_status, "completed");
    assert.equal(Number.isFinite(Date.parse(persisted.session_completed_at)), true);
  } finally {
    fixture.cleanup();
  }
});

test("idle complete stamps retention when freeze lives only on planner_last_attempt", () => {
  const fixture = setupTerminalFixture({ expectedOn: "last_attempt" });
  try {
    const result = recordSessionCompletion(fixture.projectRoot, fixture.sessionId, {
      eventType: "session.idle",
      now: Date.UTC(2026, 7, 3, 18, 0, 0),
      isAncestor: () => true,
    });
    assert.equal(result.ok, true);
    assert.equal(result.recorded, true);
    assert.equal(JSON.parse(fs.readFileSync(fixture.gateStatePath, "utf8")).session_status, "completed");
  } finally {
    fixture.cleanup();
  }
});

test("idle does not complete OpenAI plan without complete expected freeze", () => {
  const fixture = setupTerminalFixture({ expectedOn: "none" });
  try {
    const result = recordSessionCompletion(fixture.projectRoot, fixture.sessionId, {
      eventType: "session.idle",
      now: Date.UTC(2026, 7, 3, 18, 0, 0),
      isAncestor: () => true,
    });
    assert.equal(result.recorded, false);
    assert.notEqual(JSON.parse(fs.readFileSync(fixture.gateStatePath, "utf8")).session_status, "completed");
  } finally {
    fixture.cleanup();
  }
});

test("compaction recovery accepts bound OpenAI plan when freeze is on binding", () => {
  const fixture = setupTerminalFixture({ expectedOn: "binding" });
  try {
    const recovered = buildSessionRecovery(fixture.projectRoot, fixture.sessionId, {
      isAncestor: () => true,
    });
    assert.equal(recovered.ok, true, recovered.reason);
    const payload = JSON.parse(recovered.context.split("\n")[1]);
    assert.equal(payload.feature_id, FEATURE_ID);
    assert.deepEqual(payload.progress, { capture_verified: 1, total_tasks: 1 });
  } finally {
    fixture.cleanup();
  }
});

test("compaction recovery rejects bound OpenAI plan without expected freeze", () => {
  const fixture = setupTerminalFixture({ expectedOn: "none" });
  try {
    const recovered = buildSessionRecovery(fixture.projectRoot, fixture.sessionId, {
      isAncestor: () => true,
    });
    assert.equal(recovered.ok, false);
    assert.equal(recovered.reason, "planner snapshot full plan failed validation");
  } finally {
    fixture.cleanup();
  }
});
