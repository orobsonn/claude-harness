/** @description Locked persistence tests for classify reset and stub consistency. */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { persistClassifyArtifacts } from "./classify-persist.mjs";

test("classify state failure leaves the existing plan byte-unchanged", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "classify-persist-"));
  try {
    const planPath = path.join(root, "plans", "execution-plan.json");
    const statePath = path.join(root, "state", "gate-state.json");
    const previous = { kind: "stub", feature_id: "old-feature", tasks: [] };
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.writeFileSync(planPath, JSON.stringify(previous));
    const result = persistClassifyArtifacts(
      { planPath, statePath, stub: { kind: "stub", feature_id: "new-feature", tasks: [] }, statePatch: { classified: true } },
      { mergeGateState: () => ({ ok: false, reason: "gate-state-lock-timeout" }) },
    );
    assert.equal(result.ok, false);
    assert.match(result.reason, /gate-state persistence failed/);
    assert.equal(fs.readFileSync(planPath, "utf8"), JSON.stringify(previous));
    assert.equal(fs.existsSync(statePath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("classify state failure never creates a new stub", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "classify-persist-new-"));
  try {
    const planPath = path.join(root, "plans", "execution-plan.json");
    const result = persistClassifyArtifacts(
      { planPath, statePath: path.join(root, "state.json"), stub: { kind: "stub", tasks: [] }, statePatch: {} },
      { mergeGateState: () => ({ ok: false, reason: "gate-state-write-failed" }) },
    );
    assert.equal(result.ok, false);
    assert.equal(fs.existsSync(planPath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("interleaving read A -> write B -> state failure preserves concurrent B", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "classify-persist-concurrent-"));
  try {
    const planPath = path.join(root, "plans", "execution-plan.json");
    const concurrent = { kind: "full", feature_id: "concurrent", tasks: [{ id: "task-1" }] };
    const original = { kind: "stub", feature_id: "original", tasks: [] };
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.writeFileSync(planPath, JSON.stringify(original));
    fs.readFileSync(planPath);
    const result = persistClassifyArtifacts(
      { planPath, statePath: path.join(root, "state.json"), stub: { kind: "stub", feature_id: "attempt", tasks: [] }, statePatch: {} },
      { mergeGateState: () => {
        fs.writeFileSync(planPath, JSON.stringify(concurrent));
        return { ok: false, reason: "gate-state-lock-timeout" };
      } },
    );
    assert.equal(result.ok, false);
    assert.deepEqual(JSON.parse(fs.readFileSync(planPath, "utf8")), concurrent);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("state success followed by stub failure remains fail-closed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "classify-persist-write-fail-"));
  try {
    let state = {};
    const result = persistClassifyArtifacts(
      { planPath: path.join(root, "execution-plan.json"), statePath: path.join(root, "state.json"), stub: { kind: "stub", tasks: [] }, statePatch: { classified: true, delivery_status: "planning" } },
      {
        mergeGateState: (_path, patch) => {
          state = { ...state, ...patch };
          return { ok: true, state };
        },
        writePlan: () => { throw new Error("disk full"); },
      },
    );
    assert.equal(result.ok, false);
    assert.match(result.reason, /plan write failed/);
    assert.equal(state.classified, false);
    assert.equal(state.classify_status, "stub_pending");
    assert.equal(state.delivery_status, "delivery-blocked");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
