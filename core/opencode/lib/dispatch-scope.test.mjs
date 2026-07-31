/** @description Direct unit contract for the framework-owned dispatch-scope module. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeProjectPath } from "./dispatch-scope.mjs";

test("dispatch-scope accepts a file under the project root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-scope-unit-"));
  try {
    fs.mkdirSync(path.join(root, "src"));
    assert.deepEqual(normalizeProjectPath(root, "src/task.mjs"), { ok: true, path: "src/task.mjs" });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
