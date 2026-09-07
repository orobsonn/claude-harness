import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import harnessTasks from "./harness-tasks.ts";

test("native tool exposes sequential durable actions and derives the global identity from the host", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tasks-tool-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = path.join(root, ".pi/harness/state/parent/gate-state.json");
  fs.mkdirSync(path.dirname(state), { recursive: true });
  fs.writeFileSync(
    state,
    JSON.stringify({
      session_id: "parent",
      feature_id: "feature",
      mode: "FULL",
      task_pipeline_version: 1,
    }),
  );
  let tool;
  harnessTasks({
    registerTool: (item) => {
      tool = item;
    },
    on: () => {},
  });
  assert.equal(tool.name, "harness_tasks");
  assert.equal(tool.executionMode, "sequential");
  const ctx = {
    cwd: root,
    sessionManager: { getSessionId: () => "parent", getHeader: () => ({}) },
  };
  const observed = await tool.execute(
    "call",
    { action: "status" },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(observed.details.ok, true);
  assert.deepEqual(observed.details.tasks, []);
  const fake = await tool.execute(
    "fake",
    { action: "status", sessionId: "other" },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(fake.isError, true);
  const child = {
    ...ctx,
    sessionManager: {
      ...ctx.sessionManager,
      getHeader: () => ({ parentSession: "global" }),
    },
  };
  assert.equal(
    (
      await tool.execute(
        "child",
        { action: "status" },
        undefined,
        undefined,
        child,
      )
    ).isError,
    true,
  );
});
