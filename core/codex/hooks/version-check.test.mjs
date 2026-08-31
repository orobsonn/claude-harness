import assert from "node:assert/strict";
import test from "node:test";
import { compareSemver, decide, evaluateVersionCheck, parseSemver } from "./version-check.mjs";

test("version check parses and compares release versions", () => {
  assert.deepEqual(parseSemver("v0.59.1"), { major: 0, minor: 59, patch: 1 });
  assert.equal(parseSemver("latest"), null);
  assert.equal(compareSemver({ major: 0, minor: 59, patch: 1 }, { major: 0, minor: 60, patch: 0 }), -1);
});

test("version check only injects a SessionStart warning when the vendored runtime is behind", () => {
  assert.equal(decide({ localVersion: "0.59.1", remoteTag: "v0.59.1" }), null);
  assert.match(decide({ localVersion: "0.59.1", remoteTag: "v0.60.0" }).hookSpecificOutput.additionalContext, /0\.60\.0/);
});

test("version check is fail-open for non-start events, remote sessions, and failed lookups", () => {
  assert.deepEqual(evaluateVersionCheck({ hook_event_name: "PostToolUse" }, {}), {});
  assert.deepEqual(evaluateVersionCheck({ hook_event_name: "SessionStart" }, { env: { CODEX_REMOTE: "1" } }), {});
  assert.deepEqual(evaluateVersionCheck({ hook_event_name: "SessionStart" }, {
    readLocalVersion: () => "0.59.1",
    resolveRemoteTag: () => { throw new Error("offline"); },
  }), {});
});
