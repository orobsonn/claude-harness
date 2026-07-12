/**
 * @description Tests for resolve-runtime.mjs (task-2): config.runtime selector with opencode default.
 * Pinned to the locked assertions for #ac-1 / #ac-6.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveRuntime } from "./resolve-runtime.mjs";

test("resolveRuntime: undefined and {} both return opencode", () => {
  assert.strictEqual(resolveRuntime(undefined), "opencode");
  assert.strictEqual(resolveRuntime({}), "opencode");
});

test("resolveRuntime: { runtime: 'claude' } returns claude and { runtime: 'opencode' } returns opencode", () => {
  assert.strictEqual(resolveRuntime({ runtime: "claude" }), "claude");
  assert.strictEqual(resolveRuntime({ runtime: "opencode" }), "opencode");
});

test("resolveRuntime: { runtime: 'foo' } and { runtime: '' } both return opencode", () => {
  assert.strictEqual(resolveRuntime({ runtime: "foo" }), "opencode");
  assert.strictEqual(resolveRuntime({ runtime: "" }), "opencode");
});
