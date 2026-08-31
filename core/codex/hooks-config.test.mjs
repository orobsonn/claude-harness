import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const hooks = JSON.parse(readFileSync(new URL("./hooks.json", import.meta.url), "utf8"));

test("version check is synchronous so a SessionStart warning reaches the active Codex turn", () => {
  const command = hooks.hooks.SessionStart[0].hooks[0];
  assert.match(command.command, /version-check\.mjs/);
  assert.notEqual(command.async, true, "an async hook cannot reliably contribute SessionStart context");
});

test("policy rails are scoped to actual local Codex tool names, not claimed as MCP coverage", () => {
  for (const event of ["PreToolUse", "PermissionRequest", "PostToolUse"]) {
    assert.equal(hooks.hooks[event][0].matcher, "Bash|apply_patch|Agent");
  }
});
