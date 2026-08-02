/** @description Locked persistence tests for classify reset and stub consistency. */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { persistClassifyArtifacts } from "./classify-persist.mjs";

const LEGACY_CEREMONY_STATE_KEYS = [
  "brainstormed_binding",
  "adversary_fired_binding",
  "ceremony_generation",
  "ceremony_evidence",
];

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
    assert.equal(state.delivery_status, "planning");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fresh cleanup pending failure leaves existing plan bytes untouched", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "classify-persist-cleanup-pending-fail-"));
  try {
    const planPath = path.join(root, "execution-plan.json");
    const previousBytes = '{"kind":"full","tasks":[{"id":"existing"}]}\n';
    fs.writeFileSync(planPath, previousBytes);
    const result = persistClassifyArtifacts(
      {
        planPath,
        statePath: path.join(root, "gate-state.json"),
        stub: { kind: "stub", tasks: [] },
        statePatch: { classified: true },
        removeStateKeys: LEGACY_CEREMONY_STATE_KEYS,
      },
      { mergeGateStateAndRemove: () => ({ ok: false, reason: "gate-state-lock-timeout" }) },
    );

    assert.equal(result.ok, false);
    assert.match(result.reason, /gate-state persistence failed/);
    assert.equal(fs.readFileSync(planPath, "utf8"), previousBytes);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fresh cleanup finalize failure leaves classify fail-closed at stub_pending", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "classify-persist-cleanup-finalize-fail-"));
  try {
    let calls = 0;
    let state = { brainstormed_binding: { session_id: "stale" }, unrelated_fact: "preserve-me" };
    const result = persistClassifyArtifacts(
      {
        planPath: path.join(root, "execution-plan.json"),
        statePath: path.join(root, "gate-state.json"),
        stub: { kind: "stub", tasks: [] },
        statePatch: { delivery_status: "planning" },
        removeStateKeys: LEGACY_CEREMONY_STATE_KEYS,
      },
      {
        mergeGateStateAndRemove: (_path, patch, removeStateKeys) => {
          calls += 1;
          if (calls === 2) return { ok: false, reason: "gate-state-write-failed" };
          state = { ...state, ...patch };
          for (const key of removeStateKeys) delete state[key];
          return { ok: true, state };
        },
      },
    );

    assert.equal(result.ok, false);
    assert.match(result.reason, /gate-state finalize failed/);
    assert.equal(state.classified, false);
    assert.equal(state.classify_status, "stub_pending");
    assert.equal(state.delivery_status, "planning");
    assert.equal(Object.hasOwn(state, "brainstormed_binding"), false);
    assert.equal(state.unrelated_fact, "preserve-me");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fresh classify removes legacy ceremony sidecars in both locked persistence phases", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "classify-persist-fresh-cleanup-"));
  try {
    const planPath = path.join(root, "plans", "execution-plan.json");
    const statePath = path.join(root, "state", "gate-state.json");
    const legacyState = {
      session_id: "session-old",
      feature_id: "feature-old",
      brainstormed_binding: { session_id: "session-old" },
      adversary_fired_binding: { session_id: "session-old" },
      ceremony_generation: 17,
      ceremony_evidence: { digest: "stale" },
      unrelated_fact: "preserve-me",
    };
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, `${JSON.stringify(legacyState)}\n`);

    let pendingState;
    const result = persistClassifyArtifacts(
      {
        planPath,
        statePath,
        stub: { kind: "stub", feature_id: "feature-new", tasks: [] },
        statePatch: {
          session_id: "session-new",
          feature_id: "feature-new",
          brainstormed: false,
          adversary_fired: false,
        },
        removeStateKeys: LEGACY_CEREMONY_STATE_KEYS,
      },
      {
        writePlan: (targetPath, content) => {
          pendingState = JSON.parse(fs.readFileSync(statePath, "utf8"));
          fs.mkdirSync(path.dirname(targetPath), { recursive: true });
          fs.writeFileSync(targetPath, content);
        },
      },
    );

    assert.equal(result.ok, true);
    const finalizedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    for (const key of LEGACY_CEREMONY_STATE_KEYS) {
      assert.equal(Object.hasOwn(pendingState, key), false, `${key} survived pending persistence`);
      assert.equal(Object.hasOwn(finalizedState, key), false, `${key} survived finalized persistence`);
    }
    assert.equal(pendingState.classified, false);
    assert.equal(pendingState.classify_status, "stub_pending");
    assert.equal(finalizedState.classified, true);
    assert.equal(finalizedState.classify_status, "ready");
    assert.equal(finalizedState.unrelated_fact, "preserve-me");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("classify persistence preserves legacy and unrelated facts when no cleanup keys are requested", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "classify-persist-preserve-"));
  try {
    const planPath = path.join(root, "execution-plan.json");
    const statePath = path.join(root, "gate-state.json");
    fs.writeFileSync(statePath, `${JSON.stringify({
      brainstormed_binding: { session_id: "prior" },
      unrelated_fact: "preserve-me",
    })}\n`);

    const result = persistClassifyArtifacts({
      planPath,
      statePath,
      stub: { kind: "stub", tasks: [] },
      statePatch: { mode: "FULL", peak_mode: "FULL" },
    });

    assert.equal(result.ok, true);
    const finalizedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.deepEqual(finalizedState.brainstormed_binding, { session_id: "prior" });
    assert.equal(finalizedState.unrelated_fact, "preserve-me");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
