/**
 * @description Test suite for classify.mjs CLI and parseArgs/run functions.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { parseArgs, run } from "./classify.mjs";

/**
 * Spawns classify.mjs as a subprocess and captures stdout/stderr.
 * @param {string[]} args - Command arguments (e.g., ['--mode', 'FULL', '--feature-id', 'user-auth'])
 * @returns {Promise<{exitCode: number, stdout: string, stderr: string}>}
 */
async function spawnClassify(args) {
  return new Promise((resolve) => {
    const proc = spawn("node", [new URL("./classify.mjs", import.meta.url).pathname, ...args]);
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

test("classify.test.mjs", async (t) => {
  // ========================================================================
  // Unit tests for parseArgs and run functions
  // ========================================================================

  await t.test("parseArgs: parses --mode and --feature-id correctly", () => {
    const result = parseArgs([
      "node",
      "classify.mjs",
      "--mode",
      "FULL",
      "--feature-id",
      "user-auth",
    ]);
    assert.deepEqual(result, { mode: "FULL", feature_id: "user-auth" });
  });

  await t.test("parseArgs: returns null when --mode is missing", () => {
    const result = parseArgs(["node", "classify.mjs", "--feature-id", "user-auth"]);
    assert.equal(result, null);
  });

  await t.test("parseArgs: returns null when --feature-id is missing", () => {
    const result = parseArgs(["node", "classify.mjs", "--mode", "FULL"]);
    assert.equal(result, null);
  });

  await t.test("run: succeeds with valid mode and feature_id", () => {
    const result = run({ mode: "FULL", feature_id: "user-auth" });
    assert.equal(result.success, true);
    assert.deepEqual(result.output, { mode: "FULL", feature_id: "user-auth" });
  });

  await t.test("run: rejects invalid feature_id with path traversal", () => {
    const result = run({ mode: "FULL", feature_id: "../x" });
    assert.equal(result.success, false);
    assert.match(result.error, /invalid feature_id/);
  });

  await t.test("run: rejects invalid mode", () => {
    const result = run({ mode: "BOGUS", feature_id: "user-auth" });
    assert.equal(result.success, false);
    assert.match(result.error, /invalid mode/);
  });

  await t.test("run: rejects feature_id longer than 64 characters", () => {
    const longId = "a".repeat(65) + "-b";
    const result = run({ mode: "FULL", feature_id: longId });
    assert.equal(result.success, false);
    assert.match(result.error, /invalid feature_id/);
  });

  // ========================================================================
  // Integration tests spawning the CLI as subprocess
  // ========================================================================

  await t.test("CLI: returns exit code 0 and correct JSON on valid args", async () => {
    const { exitCode, stdout, stderr } = await spawnClassify([
      "--mode",
      "FULL",
      "--feature-id",
      "user-auth",
    ]);

    assert.equal(exitCode, 0, `Expected exit 0, got ${exitCode}\nstderr: ${stderr}`);
    assert.equal(stderr, "", `Expected no stderr output, got: ${stderr}`);

    const parsed = JSON.parse(stdout);
    assert.deepEqual(parsed, { mode: "FULL", feature_id: "user-auth" });
  });

  await t.test("CLI: exits non-zero with stderr for invalid feature_id", async () => {
    const { exitCode, stderr } = await spawnClassify([
      "--mode",
      "FULL",
      "--feature-id",
      "../x",
    ]);

    assert.notEqual(exitCode, 0, "Expected non-zero exit code");
    assert.match(stderr, /invalid feature_id/, "stderr should mention invalid feature_id");
  });

  await t.test("CLI: exits non-zero and lists modes for invalid mode", async () => {
    const { exitCode, stderr } = await spawnClassify([
      "--mode",
      "BOGUS",
      "--feature-id",
      "user-auth",
    ]);

    assert.notEqual(exitCode, 0, "Expected non-zero exit code");
    assert.match(
      stderr,
      /no-ceremony\|QUICK\|LIGHT\|FULL/,
      "stderr should list allowed modes",
    );
  });

  await t.test("CLI: exits non-zero for feature_id exceeding 64 characters", async () => {
    const longId = "a".repeat(65);
    const { exitCode, stderr } = await spawnClassify([
      "--mode",
      "FULL",
      "--feature-id",
      longId,
    ]);

    assert.notEqual(exitCode, 0, "Expected non-zero exit code");
    assert.match(stderr, /invalid feature_id/, "stderr should mention invalid feature_id");
  });

  await t.test("CLI: supports all valid modes", async () => {
    for (const mode of ["no-ceremony", "QUICK", "LIGHT", "FULL"]) {
      const { exitCode, stdout } = await spawnClassify([
        "--mode",
        mode,
        "--feature-id",
        "test-feature",
      ]);

      assert.equal(exitCode, 0, `Expected exit 0 for mode ${mode}`);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.mode, mode);
    }
  });

  await t.test("CLI: requires both --mode and --feature-id", async () => {
    const { exitCode, stderr } = await spawnClassify(["--mode", "FULL"]);
    assert.notEqual(exitCode, 0, "Expected non-zero exit when --feature-id missing");
    assert.match(stderr, /missing required arguments/);
  });
});
