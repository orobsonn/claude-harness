#!/usr/bin/env node
/**
 * @description Prove recovery through a real OpenCode build session: a new
 * session must adopt an already-approved canonical plan and later verified
 * progress, without creating a new plan for itself.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { semanticPlanHash } from "../core/opencode/lib/plan-hash.mjs";
import { projectHarnessTodo } from "../core/opencode/lib/todo-projection.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const OPENCODE_BIN = process.env.OPENCODE_BIN || "opencode";
const TIMEOUT_MS = 180_000;
const featureId = "resume-approved-probe";
const canonicalSessionId = "ses-resume-canonical";
const progressSessionId = "ses-resume-progress";

function pass(message) {
  process.stdout.write(`PASS: ${message}\n`);
}

function fail(message) {
  process.stderr.write(`FAIL: ${message}\n`);
  process.exitCode = 1;
}

function modelStrategy() {
  return {
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
}

function approvedPlan() {
  return {
    feature_id: featureId,
    kind: "full",
    mode: "full",
    model_strategy: modelStrategy(),
    tasks: [
      {
        id: "preserve-progress",
        severity: "low",
        complexity: "low",
        scope_paths: ["src/probe.mjs"],
        criterion_refs: ["#ac-1"],
        depends_on: [],
        locked_tests: [],
        no_tests: true,
      },
      {
        id: "finish-review",
        severity: "low",
        complexity: "low",
        scope_paths: ["src/probe.mjs"],
        criterion_refs: ["#ac-2"],
        depends_on: ["preserve-progress"],
        locked_tests: [],
        no_tests: true,
      },
    ],
  };
}

function writeApprovedState(root, sessionId, planSessionId, captured = []) {
  const plan = approvedPlan();
  const bytes = Buffer.from(JSON.stringify(plan));
  const hash = createHash("sha256").update(bytes).digest("hex");
  const semanticHash = semanticPlanHash(plan);
  const stateDir = join(root, ".opencode", "plans", ".state", sessionId);
  const canonicalPath = join(root, ".opencode", "plans", `${planSessionId}-${featureId}`, "execution-plan.json");
  const snapshotPath = join(stateDir, "bound-plans", `${hash}.json`);
  mkdirSync(dirname(canonicalPath), { recursive: true });
  mkdirSync(dirname(snapshotPath), { recursive: true });
  writeFileSync(canonicalPath, bytes);
  writeFileSync(snapshotPath, bytes);
  writeFileSync(join(stateDir, "gate-state.json"), JSON.stringify({
    session_id: sessionId,
    feature_id: featureId,
    mode: "FULL",
    peak_mode: "FULL",
    classified: true,
    triaged: true,
    planner_status: "usable",
    plan_review_verdict: "APPROVE",
    ...(sessionId === planSessionId ? {} : { resumed_from_session_id: planSessionId }),
    planner_plan_binding: {
      session_id: sessionId,
      feature_id: featureId,
      snapshot_path: `.opencode/plans/.state/${sessionId}/bound-plans/${hash}.json`,
      snapshot_hash: semanticHash,
      snapshot_file_hash: hash,
      semantic_hash: semanticHash,
      file_hash: hash,
      expected_model_strategy: modelStrategy(),
    },
    capture_verified: captured,
    fidelity_pass: [],
    hand_finished: [],
    regate_pending: [],
    regate_passed: [],
  }, null, 2));
  return { canonicalPath, hash };
}

function findClassifyEvent(stdout) {
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const event = JSON.parse(line);
      if (event.type !== "tool_use") continue;
      const part = event.part || {};
      const tool = String(part.tool || part.name || "").toLowerCase();
      if (tool === "classify" || tool.endsWith("_classify") || tool.endsWith(".classify")) return event;
    } catch {
      // A non-JSON output line is irrelevant to this structural oracle.
    }
  }
  return null;
}

function targetStates(root) {
  const stateRoot = join(root, ".opencode", "plans", ".state");
  return readdirSync(stateRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && ![canonicalSessionId, progressSessionId].includes(entry.name))
    .map((entry) => {
      const statePath = join(stateRoot, entry.name, "gate-state.json");
      if (!existsSync(statePath)) return null;
      try { return { sessionId: entry.name, statePath, state: JSON.parse(readFileSync(statePath, "utf8")) }; } catch { return null; }
    })
    .filter(Boolean)
    .filter((entry) => entry.state?.feature_id === featureId);
}

function main() {
  const root = mkdtempSync(join(tmpdir(), "oc-resume-approved-probe-"));
  try {
    const vendor = join(REPO_ROOT, "core/claude-code/skills/initializing-projects/references/vendor-core.mjs");
    execFileSync("node", [vendor, "--source", REPO_ROOT, "--target", root, "--runtime", "opencode"], {
      cwd: REPO_ROOT,
      stdio: "pipe",
      timeout: 120_000,
    });
    writeFileSync(join(root, "README.md"), "# controlled resume probe\n");
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "probe@example.invalid"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Resume Probe"], { cwd: root });
    execFileSync("git", ["add", "README.md"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "probe baseline"], { cwd: root });
    const baselineSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();

    const { canonicalPath } = writeApprovedState(root, canonicalSessionId, canonicalSessionId);
    const captured = `${featureId}/preserve-progress@${baselineSha}`;
    writeApprovedState(root, progressSessionId, canonicalSessionId, [captured]);
    pass("fixture has a canonical APPROVE plan plus later capture-verified progress");

    const prompt = `This is a controlled FULL delivery recovery probe. First load skill oc-triaging-requests. Then inspect README.md as its required investigation. The feature_id is ${featureId}. Classify this exactly once as FULL. The feature already has an approved canonical plan: do not create a planner task or modify files after classify; reply RESUME_PROBE_DONE.`;
    const result = spawnSync(OPENCODE_BIN, ["run", "--dir", root, "--format", "json", "--auto", "--agent", "build", prompt], {
      cwd: root,
      encoding: "utf8",
      timeout: TIMEOUT_MS,
    });
    const stdout = result.stdout || "";
    const stderr = result.stderr || "";
    if (result.error) throw result.error;
    const classify = findClassifyEvent(stdout);
    assert.ok(classify, `real OpenCode run never called classify; stderr=${stderr.slice(-600)} stdout=${stdout.slice(-900)}`);
    const toolState = classify.part?.state || {};
    assert.notEqual(toolState.status, "error", `classify failed: ${String(toolState.error || "unknown")}`);
    pass("real build session invoked native classify");

    const targets = targetStates(root);
    assert.equal(targets.length, 1, `expected one target recovery state, got ${targets.length}`);
    const target = targets[0];
    const state = target.state;
    assert.equal(state.planner_status, "usable");
    assert.equal(state.plan_review_verdict, "APPROVE");
    assert.equal(state.resumed_from_session_id, canonicalSessionId);
    assert.equal(state.resume_state_source_session_id, progressSessionId);
    assert.deepEqual(state.capture_verified, [captured]);
    assert.deepEqual(state.fidelity_pass, []);
    assert.deepEqual(state.hand_finished, []);
    assert.equal(existsSync(join(root, ".opencode", "plans", `${target.sessionId}-${featureId}`, "execution-plan.json")), false);
    assert.ok(existsSync(canonicalPath));
    pass("target kept the approved canonical plan and adopted only durable verified progress");

    const todos = projectHarnessTodo(JSON.parse(readFileSync(canonicalPath, "utf8")), state, {
      isAncestor: (sha) => spawnSync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], { cwd: root }).status === 0,
    });
    assert.equal(todos.find((todo) => todo.content === "Deliver task: preserve-progress")?.status, "completed");
    assert.equal(todos.find((todo) => todo.content === "Deliver task: finish-review")?.status, "pending");
    pass("todo projection ticks only the capture mark proven ancestral to the resumed HEAD");
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

main();
