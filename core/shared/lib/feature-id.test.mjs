/** @description Locked tests for feature-id (T2). PathResult contract, never throw. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isSafeFeatureId, isSafeSessionId } from "./feature-id.mjs";

test("t2-feature-id: isSafeFeatureId accepts kebab-case and rejects path traversal and uppercase", () => {
  assert.equal(isSafeFeatureId("oc-port-phase-1"), true);
  assert.equal(isSafeFeatureId("my-feat-123"), true);
  assert.equal(isSafeFeatureId("../traverse"), false);
  assert.equal(isSafeFeatureId("foo/bar"), false);
  assert.equal(isSafeFeatureId("Foo-Bar"), false);
  assert.equal(isSafeFeatureId("UPPER"), false);
  assert.equal(isSafeFeatureId(""), false);
  assert.equal(isSafeFeatureId(null), false);
});

test("t2-session: isSafeSessionId rejects .. and path separators", () => {
  assert.equal(isSafeSessionId("ses_0b24f619affeeA4bXbMGY9VhfJ"), true);
  assert.equal(isSafeSessionId("ses_abc123"), true);
  assert.equal(isSafeSessionId("ses..bad"), false);
  assert.equal(isSafeSessionId("ses/123"), false);
  assert.equal(isSafeSessionId("ses\\123"), false);
  assert.equal(isSafeSessionId(""), false);
  assert.equal(isSafeSessionId("a".repeat(129)), false);
  assert.equal(isSafeSessionId(null), false);
});
