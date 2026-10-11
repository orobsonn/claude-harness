import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseCliArgs, runTasksCli } from "./tasks.mjs";

test("the tasks CLI takes the action from argv and parameters only as a JSON object", () => {
  assert.deepEqual(parseCliArgs(["status"]), { action: "status" });
  assert.deepEqual(parseCliArgs(["dispatch", "--json", '{"task_ids":["a"]}']), { action: "dispatch", task_ids: ["a"] });
  assert.throws(() => parseCliArgs(["explode"]), /usage/);
  assert.throws(() => parseCliArgs(["status", "--json", "[]"]), /JSON object/);
  assert.throws(() => parseCliArgs(["status", "--json", '{"action":"dispatch"}']), /differs/);
  assert.throws(() => parseCliArgs(["status", "--json", "{}", "extra"]), /unexpected extra/);
  assert.throws(() => parseCliArgs(["status", "--yaml", "x"]), /expected --json/);
  assert.throws(() => parseCliArgs(["status", "--json", JSON.stringify({ x: "y".repeat(70_000) })]), /too large/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tasks-cli-"));
  try {
    fs.writeFileSync(path.join(dir, "p.json"), '{"task_id":"task-a"}');
    assert.deepEqual(parseCliArgs(["wait", "--json-file", "p.json"], dir), { action: "wait", task_id: "task-a" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("identity comes from the host env, never from parameters", async () => {
  const seen = [];
  const injected = { readProcess: () => ({}), limits: { maxParallel: 3, timeoutMs: 1 } };
  const noSession = await runTasksCli(["status"], { env: {}, cwd: os.tmpdir(), injected });
  assert.match(noSession.reason, /classified global parent/);
  const lane = await runTasksCli(["status"], { env: { CLAUDE_CODE_SESSION_ID: "s1", CLAUDE_HARNESS_TASK_RUN: "{}" }, cwd: os.tmpdir(), injected });
  assert.match(lane.reason, /lane cannot coordinate/);
  const smuggled = await runTasksCli(["status", "--json", '{"session_id":"other"}'], { env: { CLAUDE_CODE_SESSION_ID: "s1" }, cwd: os.tmpdir(), injected });
  assert.equal(smuggled.ok, false);
  seen.push(smuggled.reason);
  assert.match(seen[0], /unexpected task parameters|classified/);
});
