/** @description Locked tests for the A5 bound-plan snapshot reader (fail-open + path guard). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readBoundPlanSnapshot } from "./bound-plan.mjs";

const ROOT = "/proj";
const gs = (snapshot_path) => ({ planner_plan_binding: { snapshot_path } });

test("reads + parses a snapshot inside .opencode/plans", () => {
  const plan = { tasks: [{ id: "t1", scope_paths: ["src/a.ts"] }] };
  const readFileSync = (p) => {
    assert.equal(p, "/proj/.opencode/plans/.state/ses_x/bound-plans/h.json");
    return JSON.stringify(plan);
  };
  const out = readBoundPlanSnapshot(
    ROOT,
    gs(".opencode/plans/.state/ses_x/bound-plans/h.json"),
    { readFileSync },
  );
  assert.deepEqual(out, plan);
});

test("null when no binding / no snapshot_path (fail-open)", () => {
  assert.equal(readBoundPlanSnapshot(ROOT, {}, { readFileSync: () => "{}" }), null);
  assert.equal(readBoundPlanSnapshot(ROOT, gs(""), { readFileSync: () => "{}" }), null);
  assert.equal(readBoundPlanSnapshot(ROOT, gs(42), { readFileSync: () => "{}" }), null);
});

test("null when snapshot escapes the .opencode/plans subtree (path traversal guard)", () => {
  const readFileSync = () => {
    throw new Error("must not read outside subtree");
  };
  assert.equal(
    readBoundPlanSnapshot(ROOT, gs("../../etc/passwd"), { readFileSync }),
    null,
  );
  assert.equal(
    readBoundPlanSnapshot(ROOT, gs(".opencode/plans/../../secret.json"), { readFileSync }),
    null,
  );
  assert.equal(
    readBoundPlanSnapshot(ROOT, gs("/etc/passwd"), { readFileSync }),
    null,
  );
});

test("null on unreadable / unparseable snapshot (fail-open)", () => {
  const throwRead = () => {
    throw new Error("ENOENT");
  };
  assert.equal(
    readBoundPlanSnapshot(ROOT, gs(".opencode/plans/x.json"), { readFileSync: throwRead }),
    null,
  );
  assert.equal(
    readBoundPlanSnapshot(ROOT, gs(".opencode/plans/x.json"), { readFileSync: () => "not json{" }),
    null,
  );
  assert.equal(
    readBoundPlanSnapshot(ROOT, gs(".opencode/plans/x.json"), { readFileSync: () => "[1,2]" }),
    null,
  );
});
