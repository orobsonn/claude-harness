import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCliArgs, runInit, SOURCE_URL } from "./cli.mjs";

test("parseCliArgs", () => {
  assert.deepEqual(parseCliArgs(["node", "cli.mjs", "init"]), { command: "init" });
  assert.deepEqual(parseCliArgs(["node", "cli.mjs", "bogus"]), { command: "bogus" });
  assert.deepEqual(parseCliArgs(["node", "cli.mjs"]), { command: undefined });
});

test("SOURCE_URL is the baked slug", () => {
  assert.equal(SOURCE_URL, "https://github.com/orobsonn/claude-harness.git");
});

test("runInit delegates to vendor with resolved tag", () => {
  let calls = 0; let arg = null;
  const ret = runInit({
    cwd: "/tmp/target-proj",
    resolveTag: () => "v0.15.0",
    runVendor: (o) => { calls++; arg = o; },
  });
  assert.equal(calls, 1);
  assert.deepEqual(arg, { source: "https://github.com/orobsonn/claude-harness.git", ref: "v0.15.0", target: "/tmp/target-proj" });
  assert.equal(ret, "v0.15.0");
});

test("runInit throws when tag cannot be resolved and never vendors", () => {
  let calls = 0;
  assert.throws(() => runInit({
    cwd: "/tmp/target-proj",
    resolveTag: () => null,
    runVendor: () => { calls++; },
  }));
  assert.equal(calls, 0);
});