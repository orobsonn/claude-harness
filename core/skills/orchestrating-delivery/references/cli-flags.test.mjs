/**
 * @description Tests for the shared `--flag value` argv parser and symlink-safe direct-CLI guard
 * used by the harness's thin CLI entrypoints.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFlags } from "./cli-flags.mjs";

test("parseFlags pairs --flag value into a plain object, stripping the -- prefix", () => {
  const args = parseFlags(["--feature-id", "F", "--task-id", "T"], "tool");
  assert.deepEqual(args, { "feature-id": "F", "task-id": "T" });
});

test("parseFlags returns an empty object for empty argv", () => {
  assert.deepEqual(parseFlags([], "tool"), {});
});

test("parseFlags exits(1) on an argument that does not start with --", () => {
  const realExit = process.exit;
  const realWrite = process.stderr.write;
  let exitCode = null;
  let stderr = "";
  process.exit = (code) => {
    exitCode = code;
    throw new Error("__exit__");
  };
  process.stderr.write = (s) => {
    stderr += s;
    return true;
  };
  try {
    assert.throws(() => parseFlags(["not-a-flag", "value"], "tool"), /__exit__/);
  } finally {
    process.exit = realExit;
    process.stderr.write = realWrite;
  }
  assert.equal(exitCode, 1);
  assert.ok(stderr.includes("[tool]"));
});
