/** @description Classification persists triage facts without authoring the feature plan. */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executionPlanPath } from "../../../shared/lib/path-helpers.mjs";
import { persistClassifyState } from "./classify-persist.mjs";

test("OpenCode execution plan path is stable across sessions", () => {
  const first = executionPlanPath({
    projectRoot: "/work/project",
    runtime: "opencode",
    featureId: "stable-feature",
    sessionId: "ses_first",
  });
  const second = executionPlanPath({
    projectRoot: "/work/project",
    runtime: "opencode",
    featureId: "stable-feature",
    sessionId: "ses_second",
  });

  assert.deepEqual(first, {
    ok: true,
    path: "/work/project/.opencode/plans/stable-feature/execution-plan.json",
  });
  assert.deepEqual(second, first);
});

test("classify persistence writes only gate state and leaves a stable plan byte-identical", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stable-classify-"));
  try {
    const planPath = path.join(root, ".opencode", "plans", "stable-feature", "execution-plan.json");
    const statePath = path.join(root, ".opencode", "plans", ".state", "ses_stable", "gate-state.json");
    const planBytes = '{"feature_id":"stable-feature","tasks":[{"id":"task-1"}]}\n';
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.writeFileSync(planPath, planBytes);

    const result = persistClassifyState({
      statePath,
      statePatch: {
        session_id: "ses_stable",
        feature_id: "stable-feature",
        mode: "LIGHT",
        peak_mode: "LIGHT",
        classified: true,
        triaged: true,
      },
    });

    assert.equal(result.ok, true, result.reason);
    assert.equal(fs.readFileSync(planPath, "utf8"), planBytes);
    assert.deepEqual(JSON.parse(fs.readFileSync(statePath, "utf8")), {
      session_id: "ses_stable",
      feature_id: "stable-feature",
      mode: "LIGHT",
      peak_mode: "LIGHT",
      classified: true,
      triaged: true,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("classify persistence failure never creates a feature plan", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stable-classify-fail-"));
  try {
    const result = persistClassifyState(
      {
        statePath: path.join(root, ".opencode", "plans", ".state", "ses_fail", "gate-state.json"),
        statePatch: { classified: true },
      },
      { mergeGateState: () => ({ ok: false, reason: "gate-state-write-failed" }) },
    );

    assert.equal(result.ok, false);
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
