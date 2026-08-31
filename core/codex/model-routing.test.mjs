import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolveRoute } from "./model-routing.mjs";

test("critical security selects the native Sol identifier, xhigh, and read-only", () => {
  assert.deepEqual(resolveRoute("security", "critical"), {
    model: "gpt-5.6-sol",
    reasoning_effort: "xhigh",
    sandbox_mode: "read-only",
  });
});

test("mechanical harvest selects Luna low", () => {
  assert.deepEqual(resolveRoute("harvester", "low"), {
    model: "gpt-5.6-luna",
    reasoning_effort: "low",
    sandbox_mode: "read-only",
  });
});

test("medium executor selects Terra and may write only in the workspace", () => {
  assert.deepEqual(resolveRoute("executor", "medium"), {
    model: "gpt-5.6-terra",
    reasoning_effort: "medium",
    sandbox_mode: "workspace-write",
  });
});

test("hard implementation escalates to Sol without treating it as a critical review", () => {
  assert.deepEqual(resolveRoute("executor", "high"), {
    model: "gpt-5.6-sol",
    reasoning_effort: "high",
    sandbox_mode: "workspace-write",
  });
});

test("sniper uses the same explicit hand ladder as executor", () => {
  assert.deepEqual(resolveRoute("sniper", "medium"), {
    model: "gpt-5.6-terra",
    reasoning_effort: "medium",
    sandbox_mode: "workspace-write",
  });
});

test("vendored routing is a usable project CLI, not test-only code", () => {
  const script = fileURLToPath(new URL("./model-routing.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, "--role", "executor", "--complexity", "medium"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    model: "gpt-5.6-terra",
    reasoning_effort: "medium",
    sandbox_mode: "workspace-write",
  });
});

test("unknown role or tier is rejected instead of silently taking a cheap route", () => {
  assert.throws(() => resolveRoute("executor", "tiny"), /unsupported complexity/);
  assert.throws(() => resolveRoute("invented-role", "low"), /unsupported role/);
});
