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

// #620 #ac-1.1 — no-ceremony stamp must not pin feature_id across a later delivery classify
test("decideClassifyTransition no-ceremony+feat-a → LIGHT feat-b is fresh", () => {
  const r = decideClassifyTransition({
    requestedMode: "LIGHT",
    requestedFeatureId: "feat-b",
    currentMode: "no-ceremony",
    currentFeatureId: "feat-a",
    classified: true,
    peakMode: "no-ceremony",
  });
  assert.equal(r.ok, true);
  assert.equal(r.action, "fresh");
  assert.equal(r.mode, "LIGHT");
  assert.equal(r.featureId, "feat-b");
  assert.equal(r.peakMode, "LIGHT");
});

// residual peak from prior stamp must not poison the unbound feature's peak
test("decideClassifyTransition no-ceremony unbind resets peak to requested mode", () => {
  const r = decideClassifyTransition({
    requestedMode: "LIGHT",
    requestedFeatureId: "feat-b",
    currentMode: "no-ceremony",
    currentFeatureId: "feat-a",
    classified: true,
    peakMode: "FULL",
  });
  assert.equal(r.ok, true);
  assert.equal(r.action, "fresh");
  assert.equal(r.peakMode, "LIGHT");
});

// cannot launder feature-switch by downgrading delivery → no-ceremony first
test("decideClassifyTransition denies LIGHT→no-ceremony (same or other feature)", () => {
  const same = decideClassifyTransition({
    requestedMode: "no-ceremony",
    requestedFeatureId: "feat-a",
    currentMode: "LIGHT",
    currentFeatureId: "feat-a",
    classified: true,
  });
  assert.equal(same.ok, false);
  assert.match(same.reason, /downgrade denied/);

  const other = decideClassifyTransition({
    requestedMode: "no-ceremony",
    requestedFeatureId: "feat-b",
    currentMode: "LIGHT",
    currentFeatureId: "feat-a",
    classified: true,
  });
  assert.equal(other.ok, false);
  assert.match(other.reason, /feature switch denied/);
});

// #620 #ac-1.2 — same feature escalate from no-ceremony still works
test("decideClassifyTransition no-ceremony+feat-a → LIGHT feat-a is escalate", () => {
  const r = decideClassifyTransition({
    requestedMode: "LIGHT",
    requestedFeatureId: "feat-a",
    currentMode: "no-ceremony",
    currentFeatureId: "feat-a",
    classified: true,
    peakMode: "no-ceremony",
  });
  assert.equal(r.ok, true);
  assert.equal(r.action, "escalate");
  assert.equal(r.mode, "LIGHT");
  assert.equal(r.featureId, "feat-a");
  assert.equal(r.peakMode, "LIGHT");
});

// #620 #ac-1.3 — delivery modes still deny feature switch (anti-launder #403)
test("decideClassifyTransition QUICK/LIGHT/FULL feature switch stays denied", () => {
  for (const currentMode of ["QUICK", "LIGHT", "FULL"]) {
    for (const requestedMode of ["LIGHT", "FULL"]) {
      const r = decideClassifyTransition({
        requestedMode,
        requestedFeatureId: "feat-b",
        currentMode,
        currentFeatureId: "feat-a",
        classified: true,
        peakMode: currentMode,
      });
      assert.equal(r.ok, false, `${currentMode}→${requestedMode}`);
      assert.match(r.reason, /feature switch denied/);
    }
  }
});

test("decideClassifyTransition no-ceremony does not launder downgrade on same feature", () => {
  // no-ceremony is rank 0; escalate path only applies when req > cur. Same feature noop/escalate only.
  const r = decideClassifyTransition({
    requestedMode: "no-ceremony",
    requestedFeatureId: "feat-a",
    currentMode: "no-ceremony",
    currentFeatureId: "feat-a",
    classified: true,
  });
  assert.equal(r.ok, true);
  assert.equal(r.action, "noop");
});

test("MODE_RANK is monotonic no-ceremony < QUICK < LIGHT < FULL", () => {
  assert.ok(MODE_RANK["no-ceremony"] < MODE_RANK.QUICK);
  assert.ok(MODE_RANK.QUICK < MODE_RANK.LIGHT);
  assert.ok(MODE_RANK.LIGHT < MODE_RANK.FULL);
});
