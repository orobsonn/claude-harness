import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const runtimePath = fileURLToPath(new URL("./subagents.json", import.meta.url));

test("Pi runtime gives eyes and hands a finite 144-turn default", () => {
  const runtime = JSON.parse(readFileSync(runtimePath, "utf8"));
  assert.equal(runtime.defaultMaxTurns, 144);
  assert.ok(Number.isInteger(runtime.defaultMaxTurns) && runtime.defaultMaxTurns > 16);
  assert.equal(runtime.maxConcurrent, 1, "one active child keeps the parent ceremony ordered");
});
