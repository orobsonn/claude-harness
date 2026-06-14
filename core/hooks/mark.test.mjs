/**
 * @description Test suite for mark.mjs CLI and parseArgs/run functions.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { parseArgs, run } from "./mark.mjs";

/**
 * Spawns mark.mjs as a subprocess and captures stdout/stderr.
 * @param {string[]} args - Command arguments (e.g., ['brainstorm-done', '--feature-id', 'foo'])
 * @returns {Promise<{exitCode: number, stdout: string, stderr: string}>}
 */
async function spawnMark(args) {
  return new Promise((resolve) => {
    const proc = spawn("node", [new URL("./mark.mjs", import.meta.url).pathname, ...args]);
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code) => {
      resolve({
        exitCode: code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
}

test("mark.test.mjs", async (t) => {
  // ========================================================================
  // Unit tests for parseArgs and run functions
  // ========================================================================

  await t.test("parseArgs: parses brainstorm-done --feature-id correctly", () => {
    const result = parseArgs(["node", "mark.mjs", "brainstorm-done", "--feature-id", "foo"]);
    assert.deepEqual(result, { marker: "brainstorm-done", feature_id: "foo" });
  });

  await t.test("parseArgs: returns null for unknown marker command", () => {
    const result = parseArgs(["node", "mark.mjs", "unknown-marker", "--feature-id", "foo"]);
    assert.equal(result, null);
  });

  await t.test("parseArgs: returns null when --feature-id is missing", () => {
    const result = parseArgs(["node", "mark.mjs", "brainstorm-done"]);
    assert.equal(result, null);
  });

  await t.test("run: succeeds with valid feature_id", () => {
    const result = run({ marker: "brainstorm-done", feature_id: "foo" });
    assert.equal(result.success, true);
    assert.deepEqual(result.output, { marker: "brainstorm-done", feature_id: "foo" });
  });

  await t.test("run: rejects invalid feature_id with path traversal", () => {
    const result = run({ marker: "brainstorm-done", feature_id: "../x" });
    assert.equal(result.success, false);
    assert.match(result.error, /invalid feature_id/);
  });

  // --- regate-pending / regate-passed markers (the re-gate rail) ---

  await t.test("parseArgs: parses regate-pending --feature-id --task-id correctly", () => {
    const result = parseArgs([
      "node",
      "mark.mjs",
      "regate-pending",
      "--feature-id",
      "foo",
      "--task-id",
      "task-1",
    ]);
    assert.deepEqual(result, {
      marker: "regate-pending",
      feature_id: "foo",
      task_id: "task-1",
    });
  });

  await t.test("parseArgs: parses regate-passed --feature-id --task-id correctly", () => {
    const result = parseArgs([
      "node",
      "mark.mjs",
      "regate-passed",
      "--feature-id",
      "foo",
      "--task-id",
      "task-1",
    ]);
    assert.deepEqual(result, {
      marker: "regate-passed",
      feature_id: "foo",
      task_id: "task-1",
    });
  });

  await t.test("parseArgs: returns null when regate marker is missing --task-id", () => {
    const result = parseArgs(["node", "mark.mjs", "regate-pending", "--feature-id", "foo"]);
    assert.equal(result, null);
  });

  await t.test("run: succeeds with valid feature_id and task_id for regate-pending", () => {
    const result = run({ marker: "regate-pending", feature_id: "foo", task_id: "task-1" });
    assert.equal(result.success, true);
    assert.deepEqual(result.output, {
      marker: "regate-pending",
      feature_id: "foo",
      task_id: "task-1",
    });
  });

  await t.test("run: succeeds with valid feature_id and task_id for regate-passed", () => {
    const result = run({ marker: "regate-passed", feature_id: "foo", task_id: "task-1" });
    assert.equal(result.success, true);
    assert.deepEqual(result.output, {
      marker: "regate-passed",
      feature_id: "foo",
      task_id: "task-1",
    });
  });

  await t.test("run: rejects regate marker with invalid task_id", () => {
    const result = run({ marker: "regate-pending", feature_id: "foo", task_id: "../x" });
    assert.equal(result.success, false);
    assert.match(result.error, /invalid task_id/);
  });

  // ========================================================================
  // Integration tests spawning the CLI as subprocess
  // ========================================================================

  await t.test("CLI: returns exit code 0 and correct JSON on valid args", async () => {
    const { exitCode, stdout, stderr } = await spawnMark([
      "brainstorm-done",
      "--feature-id",
      "foo",
    ]);

    assert.equal(exitCode, 0, `Expected exit 0, got ${exitCode}\nstderr: ${stderr}`);
    assert.equal(stderr, "", `Expected no stderr output, got: ${stderr}`);

    const parsed = JSON.parse(stdout);
    assert.deepEqual(parsed, { marker: "brainstorm-done", feature_id: "foo" });
  });

  await t.test("CLI: exits non-zero with stderr for invalid feature_id", async () => {
    const { exitCode, stderr } = await spawnMark([
      "brainstorm-done",
      "--feature-id",
      "../x",
    ]);

    assert.notEqual(exitCode, 0, "Expected non-zero exit code");
    assert.match(stderr, /invalid feature_id/, "stderr should mention invalid feature_id");
  });

  await t.test("CLI: exits non-zero for unknown marker command", async () => {
    const { exitCode, stderr } = await spawnMark(["unknown-marker", "--feature-id", "foo"]);

    assert.notEqual(exitCode, 0, "Expected non-zero exit code");
    assert.match(stderr, /invalid command/, "stderr should mention invalid command");
  });

  await t.test("CLI: accepts valid kebab-case feature_id values", async () => {
    for (const id of ["foo", "my-feature", "user-auth-revamp", "a1b2c3"]) {
      const { exitCode, stdout } = await spawnMark([
        "brainstorm-done",
        "--feature-id",
        id,
      ]);

      assert.equal(exitCode, 0, `Expected exit 0 for id ${id}`);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.feature_id, id);
    }
  });

  await t.test("CLI: returns exit 0 and JSON with task_id for regate-pending", async () => {
    const { exitCode, stdout, stderr } = await spawnMark([
      "regate-pending",
      "--feature-id",
      "foo",
      "--task-id",
      "task-1",
    ]);

    assert.equal(exitCode, 0, `Expected exit 0, got ${exitCode}\nstderr: ${stderr}`);
    const parsed = JSON.parse(stdout);
    assert.deepEqual(parsed, {
      marker: "regate-pending",
      feature_id: "foo",
      task_id: "task-1",
    });
  });

  await t.test("CLI: returns exit 0 and JSON with task_id for regate-passed", async () => {
    const { exitCode, stdout } = await spawnMark([
      "regate-passed",
      "--feature-id",
      "foo",
      "--task-id",
      "task-1",
    ]);

    assert.equal(exitCode, 0, `Expected exit 0, got ${exitCode}`);
    const parsed = JSON.parse(stdout);
    assert.deepEqual(parsed, {
      marker: "regate-passed",
      feature_id: "foo",
      task_id: "task-1",
    });
  });

  await t.test("CLI: exits non-zero when regate marker omits --task-id", async () => {
    const { exitCode, stderr } = await spawnMark([
      "regate-pending",
      "--feature-id",
      "foo",
    ]);

    assert.notEqual(exitCode, 0, "Expected non-zero exit code");
    assert.match(stderr, /invalid command/, "stderr should mention invalid command");
  });

  await t.test("CLI: rejects feature_id exceeding 64 characters", async () => {
    const longId = "a".repeat(65);
    const { exitCode, stderr } = await spawnMark([
      "brainstorm-done",
      "--feature-id",
      longId,
    ]);

    assert.notEqual(exitCode, 0, "Expected non-zero exit code");
    assert.match(stderr, /invalid feature_id/, "stderr should mention invalid feature_id");
  });
});

// --- escalation-fallback marker (Trilho 3 — the hand-routing escalation ticket) ---

test("parseArgs+run: escalation-fallback echoes {marker, feature_id, task_id}", () => {
  const parsed = parseArgs([
    "node",
    "mark.mjs",
    "escalation-fallback",
    "--feature-id",
    "feat-a",
    "--task-id",
    "task-1",
  ]);
  assert.deepEqual(parsed, {
    marker: "escalation-fallback",
    feature_id: "feat-a",
    task_id: "task-1",
  });
  const result = run(parsed);
  assert.equal(result.success, true);
  assert.deepEqual(result.output, {
    marker: "escalation-fallback",
    feature_id: "feat-a",
    task_id: "task-1",
  });
});

test("parseArgs: escalation-fallback without --task-id → null (task-id required)", () => {
  const parsed = parseArgs(["node", "mark.mjs", "escalation-fallback", "--feature-id", "feat-a"]);
  assert.equal(parsed, null);
});

// --- hand-finished / capture-verified markers (Trilho 4 — the independent-capture rail) ---

test("parseArgs+run: hand-finished echoes {marker, feature_id, task_id}", () => {
  const parsed = parseArgs([
    "node",
    "mark.mjs",
    "hand-finished",
    "--feature-id",
    "feat-a",
    "--task-id",
    "task-1",
  ]);
  assert.deepEqual(parsed, {
    marker: "hand-finished",
    feature_id: "feat-a",
    task_id: "task-1",
  });
  const result = run(parsed);
  assert.equal(result.success, true);
  assert.deepEqual(result.output, {
    marker: "hand-finished",
    feature_id: "feat-a",
    task_id: "task-1",
  });
});
