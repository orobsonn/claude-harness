/**
 * @description Tests for resolveHookCommand — verifies Stop-hook command shape only.
 * Per static_test_proves: "blocking_configuration_shape_only".
 * Runtime blocking is verified by the operator-gated demo (AC v2.3).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { resolveHookCommand } from "./resolve-hook-command.mjs";

// Locked test 1:
// Given config dir '/tmp/handcfg-x' and frozen test path
// 'core/skills/orchestrating-delivery/references/dispatch-hand.test.mjs',
// When resolveHookCommand(configDir, testPath) builds the Stop-hook command,
// Then the returned command is an ABSOLUTE `node --test` invocation targeting
// that frozen test path AND contains no `${CLAUDE_PROJECT_DIR}` substring.
test("resolveHookCommand returns absolute node --test command without CLAUDE_PROJECT_DIR", () => {
  const configDir = "/tmp/handcfg-x";
  const testPath = "core/skills/orchestrating-delivery/references/dispatch-hand.test.mjs";

  const command = resolveHookCommand(configDir, testPath);

  // Must start with an absolute path to `node` (resolved) and contain `--test`
  assert.ok(
    command.includes("node --test") || /^\/.*node\s+--test/.test(command),
    `Command must be a node --test invocation, got: ${command}`
  );

  // The test path argument must be absolute
  const parts = command.split(" ");
  const testArg = parts[parts.length - 1];
  assert.ok(
    isAbsolute(testArg),
    `Test path in command must be absolute, got: ${testArg}`
  );

  // Must NOT contain ${CLAUDE_PROJECT_DIR}
  assert.ok(
    !command.includes("${CLAUDE_PROJECT_DIR}"),
    `Command must not contain \${CLAUDE_PROJECT_DIR}, got: ${command}`
  );

  // The absolute test path must embed the relative path
  assert.ok(
    testArg.endsWith(testPath),
    `Absolute test path must end with the given relative path, got: ${testArg}`
  );
});

// Locked test 1b: a non-default runnerId builds that adapter's command instead of node --test,
// so the live Stop-hook gate never hardcodes node:test against a project using another runner.
test("resolveHookCommand(configDir, testPath, 'vitest') builds the vitest adapter's command", () => {
  const configDir = "/tmp/handcfg-x";
  const testPath = "core/skills/orchestrating-delivery/references/dispatch-hand.test.mjs";

  const command = resolveHookCommand(configDir, testPath, "vitest");

  assert.ok(command.startsWith("npx --no-install vitest run --reporter=json "), `got: ${command}`);
  assert.ok(!command.includes("node --test"), `got: ${command}`);

  const testArg = command.split(" ").pop();
  assert.ok(isAbsolute(testArg) && testArg.endsWith(testPath), `got: ${testArg}`);
});

// Locked test 1c: omitting runnerId preserves the original node --test default (backward compatible).
test("resolveHookCommand defaults to node-test when runnerId is omitted", () => {
  const command = resolveHookCommand("/tmp/handcfg-x", "a/b.test.mjs");
  assert.ok(command.includes("--test"), `got: ${command}`);
  assert.ok(!command.includes("vitest"), `got: ${command}`);
});

// Locked test 2:
// Given the shipped hand-config/settings.json parsed as JSON,
// When its blocking-configuration SHAPE is inspected,
// Then `hooks.Stop` is a non-empty array whose single matcher entry has a
// `hooks[]` command that is a non-empty string containing 'node --test'
// AND that Stop entry carries NO non-blocking bypass field
// (no "blocking": false, no "continueOnError": true, no key disabling blocking).
test("settings.json Stop hook shape is correct and carries no bypass field", () => {
  const settingsPath = join(
    new URL(".", import.meta.url).pathname,
    "settings.json"
  );

  const raw = readFileSync(settingsPath, "utf-8");
  const settings = JSON.parse(raw);

  // hooks.Stop must exist and be a non-empty array
  assert.ok(
    Array.isArray(settings.hooks?.Stop) && settings.hooks.Stop.length > 0,
    "hooks.Stop must be a non-empty array"
  );

  const stopEntry = settings.hooks.Stop[0];

  // Must have hooks array with at least one entry
  assert.ok(
    Array.isArray(stopEntry.hooks) && stopEntry.hooks.length > 0,
    "Stop entry must have a non-empty hooks array"
  );

  const hookCmd = stopEntry.hooks[0];

  // Must be of type "command"
  assert.strictEqual(hookCmd.type, "command", "Hook type must be 'command'");

  // Command must be a non-empty string containing 'node --test'
  assert.ok(
    typeof hookCmd.command === "string" && hookCmd.command.length > 0,
    "Hook command must be a non-empty string"
  );
  assert.ok(
    hookCmd.command.includes("node --test"),
    `Hook command must contain 'node --test', got: ${hookCmd.command}`
  );

  // No bypass fields — blocking is the default; these fields disable it
  assert.ok(
    !("blocking" in hookCmd) || hookCmd.blocking !== false,
    'Hook must not have "blocking": false'
  );
  assert.ok(
    !("continueOnError" in hookCmd) || hookCmd.continueOnError !== true,
    'Hook must not have "continueOnError": true'
  );
  assert.ok(
    !("continueOnError" in stopEntry) || stopEntry.continueOnError !== true,
    'Stop entry must not have "continueOnError": true'
  );
  assert.ok(
    !("blocking" in stopEntry) || stopEntry.blocking !== false,
    'Stop entry must not have "blocking": false'
  );
});
