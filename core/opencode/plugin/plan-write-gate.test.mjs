/**
 * @description Locked tests for plan-write-gate (LIGHT state anti-forge).
 * Pure decide + hermetic plugin hook with OC arg shapes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  decide,
  extractWritePath,
  throwIfDenied,
} from "./lib/plan-write-decide.mjs";
import { createPlanWriteGateHooks } from "./plan-write-gate.ts";

test("allow write to execution-plan.json (orchestrator may author plan)", () => {
  const p = {
    tool_input: { file_path: ".opencode/plans/foo/execution-plan.json" },
  };
  assert.equal(decide(p).allow, true);
});

test("deny write to gate-state.json (basename rail)", () => {
  const p = { tool_input: { file_path: "any/gate-state.json" } };
  const r = decide(p);
  assert.equal(r.allow, false);
  assert.match(r.reason ?? "", /gate-state\/triage/);
});

test("deny write to triage.json under .state", () => {
  const p = {
    tool_input: { file_path: ".opencode/plans/.state/ses/triage.json" },
  };
  assert.equal(decide(p).allow, false);
});

test("carve-out basename *.test.* fixtures pass", () => {
  const p = { tool_input: { file_path: "__fixtures__/gate-state.test.json" } };
  assert.equal(decide(p).allow, true);
});

test("carve never applies to live gate-state basename even under .test. session segment", () => {
  const p = {
    tool_input: {
      file_path: ".opencode/plans/.state/ses.test.x/gate-state.json",
    },
  };
  const r = decide(p);
  assert.equal(r.allow, false);
  assert.match(r.reason ?? "", /gate-state|harness markers/);
});

test("empty path fail-closed", () => {
  const r = decide({ tool_input: {} });
  assert.equal(r.allow, false);
  assert.match(r.reason ?? "", /path missing/);
});

test("deny Write overwrite of mark-gate.mjs marker script", () => {
  const r = decide({
    tool_input: { file_path: "core/opencode/plugin/lib/mark-gate.mjs" },
  });
  assert.equal(r.allow, false);
  assert.match(r.reason ?? "", /marker scripts|mark-gate/);
});

test("deny Write overwrite of frozen tooling vendor-core", () => {
  const r = decide({
    tool_input: {
      file_path:
        "core/claude-code/skills/initializing-projects/references/vendor-core.mjs",
    },
  });
  assert.equal(r.allow, false);
  assert.match(r.reason ?? "", /tooling|anti-forgery/);
});

test("traversal to state denied (no carve bypass)", () => {
  const p = {
    tool_input: {
      file_path:
        "../../../__fixtures__/.opencode/plans/.state/s/gate-state.json",
    },
  };
  assert.equal(decide(p).allow, false);
});

test("absolute path under .state hits oracle (deny)", () => {
  const state = {
    tool_input: {
      file_path: "/home/u/proj/.opencode/plans/.state/ses/other.json",
    },
  };
  const rState = decide(state);
  assert.equal(rState.allow, false);
  assert.match(rState.reason ?? "", /\.state|gate-state|harness markers/);

  const absOutsideOracle = {
    tool_input: { file_path: "/tmp/unrelated/notes.json" },
  };
  assert.equal(decide(absOutsideOracle).allow, true);

  const absPlan = {
    tool_input: { file_path: "/tmp/.opencode/plans/foo/execution-plan.json" },
  };
  assert.equal(decide(absPlan).allow, true);
});

test("extractWritePath accepts OC filePath args", () => {
  assert.equal(
    extractWritePath({ args: { filePath: ".opencode/plans/.state/s/gate-state.json" } }),
    ".opencode/plans/.state/s/gate-state.json",
  );
  assert.equal(
    extractWritePath({ tool_input: { file_path: "x/gate-state.json" } }),
    "x/gate-state.json",
  );
});

test("throwIfDenied throws [plan-write-gate] prefix", () => {
  assert.throws(
    () =>
      throwIfDenied(
        decide({
          tool_input: { file_path: ".opencode/plans/.state/s/gate-state.json" },
        }),
      ),
    /\[plan-write-gate\]/,
  );
  assert.doesNotThrow(() =>
    throwIfDenied(
      decide({
        tool_input: { file_path: "src/app.ts" },
      }),
    ),
  );
});

test("hermetic plugin: OC write to gate-state throws; plan and normal file allow", async () => {
  const hooks = await createPlanWriteGateHooks();
  const before = hooks["tool.execute.before"];
  assert.equal(typeof before, "function");

  await assert.rejects(
    () =>
      before(
        { tool: "write" },
        {
          args: {
            filePath: ".opencode/plans/.state/ses_x/gate-state.json",
            content: "{}",
          },
        },
      ),
    /\[plan-write-gate\]/,
  );

  await assert.doesNotReject(() =>
    before(
      { tool: "write" },
      {
        args: {
          filePath: ".opencode/plans/feat/execution-plan.json",
          content: "{}",
        },
      },
    ),
  );

  await assert.doesNotReject(() =>
    before(
      { tool: "edit" },
      { args: { filePath: "src/lib/foo.ts", content: "x" } },
    ),
  );

  // namespaced write tool
  await assert.rejects(
    () =>
      before(
        { tool: "file.write" },
        { args: { path: "cwd/triage.json", content: "{}" } },
      ),
    /\[plan-write-gate\]/,
  );
});
