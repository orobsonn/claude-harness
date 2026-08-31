import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const policy = fileURLToPath(new URL("./hooks/policy.mjs", import.meta.url));
const payload = {
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "git push --force origin main" },
};
const result = spawnSync(process.execPath, [policy], {
  encoding: "utf8",
  input: JSON.stringify(payload),
});
assert.equal(result.status, 0, result.stderr);
const output = JSON.parse(result.stdout);
assert.equal(output.hookSpecificOutput.hookEventName, "PreToolUse");
assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
process.stdout.write("hook smoke passed\n");

