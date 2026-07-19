/** @description Locked tests for buildClassifyStub — pre-plan stub shape, never throws. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildClassifyStub,
  CLASSIFY_MODES,
  decideClassifyTransition,
  MODE_RANK,
} from "./classify-stub.mjs";

test("t5-classify: buildClassifyStub writes pre-plan stub shape without throw", () => {
  const r = buildClassifyStub({
    mode: "LIGHT",
    featureId: "user-auth-revamp",
    sessionId: "ses_abc123",
  });
  assert.equal(r.ok, true);
  assert.ok(r.stub);
  assert.equal(r.stub.kind, "stub");
  assert.equal(r.stub.mode, "LIGHT");
  assert.equal(r.stub.feature_id, "user-auth-revamp");
  assert.equal(r.stub.session_id, "ses_abc123");
  assert.deepEqual(r.stub.tasks, []);
});

test("buildClassifyStub rejects unsafe featureId without throw", () => {
  const r = buildClassifyStub({ mode: "FULL", featureId: "../etc" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /featureId/i);
});

test("buildClassifyStub rejects invalid mode without throw", () => {
  const r = buildClassifyStub({ mode: "turbo", featureId: "ok-id" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /mode/i);
});

test("buildClassifyStub accepts all CLASSIFY_MODES", () => {
  for (const mode of CLASSIFY_MODES) {
    const r = buildClassifyStub({ mode, featureId: "feat-x" });
    assert.equal(r.ok, true, mode);
  }
});

test("buildClassifyStub never throws on garbage input", () => {
  assert.doesNotThrow(() => buildClassifyStub(null));
  assert.doesNotThrow(() => buildClassifyStub(undefined));
  assert.doesNotThrow(() => buildClassifyStub("x"));
  assert.equal(buildClassifyStub(null).ok, false);
});

test("decideClassifyTransition fresh when not classified", () => {
  const r = decideClassifyTransition({
    requestedMode: "LIGHT",
    requestedFeatureId: "feat-a",
  });
  assert.equal(r.ok, true);
  assert.equal(r.action, "fresh");
  assert.equal(r.mode, "LIGHT");
  assert.equal(r.peakMode, "LIGHT");
});

test("decideClassifyTransition same mode is noop", () => {
  const r = decideClassifyTransition({
    requestedMode: "LIGHT",
    requestedFeatureId: "feat-a",
    currentMode: "LIGHT",
    currentFeatureId: "feat-a",
    classified: true,
  });
  assert.equal(r.ok, true);
  assert.equal(r.action, "noop");
  assert.equal(r.peakMode, "LIGHT");
});

test("decideClassifyTransition denies downgrade LIGHT→QUICK", () => {
  const r = decideClassifyTransition({
    requestedMode: "QUICK",
    requestedFeatureId: "feat-a",
    currentMode: "LIGHT",
    currentFeatureId: "feat-a",
    classified: true,
    peakMode: "LIGHT",
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /downgrade denied/);
});

test("decideClassifyTransition allows escalate QUICK→LIGHT", () => {
  const r = decideClassifyTransition({
    requestedMode: "LIGHT",
    requestedFeatureId: "feat-a",
    currentMode: "QUICK",
    currentFeatureId: "feat-a",
    classified: true,
  });
  assert.equal(r.ok, true);
  assert.equal(r.action, "escalate");
  assert.equal(r.mode, "LIGHT");
  assert.equal(r.peakMode, "LIGHT");
});

test("decideClassifyTransition denies feature switch mid-session", () => {
  const r = decideClassifyTransition({
    requestedMode: "LIGHT",
    requestedFeatureId: "feat-b",
    currentMode: "LIGHT",
    currentFeatureId: "feat-a",
    classified: true,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /feature switch denied/);
});

test("MODE_RANK is monotonic no-ceremony < QUICK < LIGHT < FULL", () => {
  assert.ok(MODE_RANK["no-ceremony"] < MODE_RANK.QUICK);
  assert.ok(MODE_RANK.QUICK < MODE_RANK.LIGHT);
  assert.ok(MODE_RANK.LIGHT < MODE_RANK.FULL);
});
