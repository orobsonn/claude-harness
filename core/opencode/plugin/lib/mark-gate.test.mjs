/** @description Public marker library stays pure and its CLI stays observability-only. */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import marker, { fidelityPassEntry, defaultHeadSha } from "./mark-gate.mjs";

const markerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "mark-gate.mjs");

test("public marker library exports only non-mutating helpers", () => {
  assert.deepEqual(Object.keys(marker).sort(), ["defaultHeadSha", "fidelityPassEntry"]);
  assert.equal(fidelityPassEntry("feature", "task", null), "feature/task");
  assert.equal(fidelityPassEntry("feature", "task", "abc"), "feature/task@abc");
  assert.equal(typeof defaultHeadSha, "function");
});

test("privileged CLI action rejects without creating gate-state", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mark-cli-"));
  try {
    const result = spawnSync(process.execPath, [markerPath, "brainstormed", "--root", root, "--session", "ses-a"], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /host-issued|observability-only/);
    assert.equal(fs.existsSync(path.join(root, ".opencode", "plans", ".state")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
