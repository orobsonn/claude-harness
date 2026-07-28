/**
 * @description Locked tests for lavish-command-gate (OC deny for `lavish-axi share` /
 * `lavish-axi setup hooks`). Pure decide + hermetic plugin hook with OC arg shapes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { forbiddenLavishSubcommand, lavishDenyReason } from "./lib/lavish-command-decide.mjs";
import { createLavishCommandGateHooks } from "./lavish-command-gate.ts";

// --- pure decide layer (mirrors Claude Code's lavish-command-gate.test.mjs 1:1) ---

test("forbiddenLavishSubcommand: null on ordinary lavish-axi open/poll", () => {
  assert.equal(forbiddenLavishSubcommand("npx -y lavish-axi docs/prd/x-mockup.html"), null);
  assert.equal(forbiddenLavishSubcommand("npx -y lavish-axi poll docs/prd/x-mockup.html"), null);
});

test('forbiddenLavishSubcommand: "share" on npx -y lavish-axi share', () => {
  assert.equal(forbiddenLavishSubcommand("npx -y lavish-axi share docs/prd/x-mockup.html"), "share");
});

test('forbiddenLavishSubcommand: "setup hooks" on lavish-axi setup hooks', () => {
  assert.equal(forbiddenLavishSubcommand("npx -y lavish-axi setup hooks"), "setup hooks");
});

test("lavishDenyReason: null for an allowed command, a string naming ht-ml.app for share", () => {
  assert.equal(lavishDenyReason("npx -y lavish-axi poll x.html"), null);
  assert.match(lavishDenyReason("npx -y lavish-axi share x.html"), /ht-ml\.app/);
});

// --- plugin hook (OC tool.execute.before contract: deny throws) ---

test("tool.execute.before: allows a non-bash tool regardless of args", async () => {
  const hooks = await createLavishCommandGateHooks();
  await assert.doesNotReject(
    hooks["tool.execute.before"](
      { tool: "write" },
      { args: { command: "npx -y lavish-axi share x.html" } },
    ),
  );
});

test("tool.execute.before: allows an ordinary lavish-axi bash command", async () => {
  const hooks = await createLavishCommandGateHooks();
  await assert.doesNotReject(
    hooks["tool.execute.before"](
      { tool: "bash" },
      { args: { command: "npx -y lavish-axi docs/prd/x-mockup.html" } },
    ),
  );
});

test("tool.execute.before: throws on lavish-axi share via bash", async () => {
  const hooks = await createLavishCommandGateHooks();
  await assert.rejects(
    hooks["tool.execute.before"](
      { tool: "bash" },
      { args: { command: "npx -y lavish-axi share docs/prd/x-mockup.html" } },
    ),
    /\[lavish-command-gate\]/,
  );
});

test("tool.execute.before: throws on lavish-axi setup hooks via bash, reading args from input when output lacks them", async () => {
  const hooks = await createLavishCommandGateHooks();
  await assert.rejects(
    hooks["tool.execute.before"](
      { tool: "bash", args: { command: "npx -y lavish-axi setup hooks" } },
      {},
    ),
    /\[lavish-command-gate\]/,
  );
});

test("tool.execute.before: recognizes namespaced bash tool names", async () => {
  const hooks = await createLavishCommandGateHooks();
  await assert.rejects(
    hooks["tool.execute.before"](
      { tool: "harness.bash" },
      { args: { command: "npx -y lavish-axi share x.html" } },
    ),
    /\[lavish-command-gate\]/,
  );
});
