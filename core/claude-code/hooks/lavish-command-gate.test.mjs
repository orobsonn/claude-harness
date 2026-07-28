/**
 * @description Test suite for lavish-command-gate.mjs — PreToolUse(Bash) hook.
 * Drives decide()/forbiddenLavishSubcommand()/processInput() directly (no subprocess spawn).
 * Run with: node --test core/claude-code/hooks/lavish-command-gate.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { decide, forbiddenLavishSubcommand, processInput } from "./lavish-command-gate.mjs";

const SETTINGS_PATH = fileURLToPath(new URL("../settings.json", import.meta.url));

/**
 * @param {string} command
 */
function makeBashPayload(command) {
  return { session_id: "ses_x", tool_name: "Bash", tool_input: { command } };
}

// --- forbiddenLavishSubcommand ---

test("forbiddenLavishSubcommand: null on non-string / empty command", () => {
  assert.equal(forbiddenLavishSubcommand(undefined), null);
  assert.equal(forbiddenLavishSubcommand(null), null);
  assert.equal(forbiddenLavishSubcommand(42), null);
  assert.equal(forbiddenLavishSubcommand(""), null);
});

test("forbiddenLavishSubcommand: null on ordinary lavish-axi open/poll/export/end", () => {
  assert.equal(forbiddenLavishSubcommand("npx -y lavish-axi docs/prd/x-mockup.html"), null);
  assert.equal(forbiddenLavishSubcommand("npx -y lavish-axi poll docs/prd/x-mockup.html"), null);
  assert.equal(
    forbiddenLavishSubcommand('npx -y lavish-axi poll docs/prd/x-mockup.html --agent-reply "done"'),
    null,
  );
  assert.equal(forbiddenLavishSubcommand("npx -y lavish-axi export docs/prd/x-mockup.html"), null);
  assert.equal(forbiddenLavishSubcommand("npx -y lavish-axi end docs/prd/x-mockup.html"), null);
});

test("forbiddenLavishSubcommand: null when unrelated to lavish-axi entirely", () => {
  assert.equal(forbiddenLavishSubcommand("git status"), null);
  assert.equal(forbiddenLavishSubcommand("echo 'share this with the team'"), null);
});

test('forbiddenLavishSubcommand: "share" on npx -y lavish-axi share', () => {
  assert.equal(
    forbiddenLavishSubcommand("npx -y lavish-axi share docs/prd/x-mockup.html"),
    "share",
  );
});

test('forbiddenLavishSubcommand: "share" survives a pinned version and extra flags', () => {
  assert.equal(
    forbiddenLavishSubcommand("npx -y lavish-axi@1.4.0 share docs/prd/x-mockup.html --password hunter2"),
    "share",
  );
});

test('forbiddenLavishSubcommand: "setup hooks" on lavish-axi setup hooks', () => {
  assert.equal(forbiddenLavishSubcommand("npx -y lavish-axi setup hooks"), "setup hooks");
  assert.equal(forbiddenLavishSubcommand("lavish-axi setup   hooks"), "setup hooks");
});

test("forbiddenLavishSubcommand: catches a forbidden subcommand chained after an allowed one", () => {
  assert.equal(
    forbiddenLavishSubcommand(
      "npx -y lavish-axi docs/prd/x-mockup.html && npx -y lavish-axi share docs/prd/x-mockup.html",
    ),
    "share",
  );
});

test("forbiddenLavishSubcommand: null when 'share' appears in a different shell clause than lavish-axi", () => {
  assert.equal(forbiddenLavishSubcommand("npx -y lavish-axi poll x.html; echo share"), null);
});

// --- decide() ---

test("decide: non-object payload fails open", () => {
  assert.deepEqual(decide(null), { allow: true });
  assert.deepEqual(decide(undefined), { allow: true });
  assert.deepEqual(decide([]), { allow: true });
});

test("decide: allows an ordinary lavish-axi open command", () => {
  const verdict = decide(makeBashPayload("npx -y lavish-axi docs/prd/x-mockup.html"));
  assert.equal(verdict.allow, true);
  assert.equal(verdict.hookSpecificOutput, undefined);
});

test("decide: denies lavish-axi share with a reason naming ht-ml.app", () => {
  const verdict = decide(makeBashPayload("npx -y lavish-axi share docs/prd/x-mockup.html"));
  assert.equal(verdict.allow, false);
  assert.equal(verdict.hookSpecificOutput.permissionDecision, "deny");
  assert.match(verdict.hookSpecificOutput.permissionDecisionReason, /ht-ml\.app/);
});

test("decide: denies lavish-axi setup hooks with a reason naming SessionStart", () => {
  const verdict = decide(makeBashPayload("npx -y lavish-axi setup hooks"));
  assert.equal(verdict.allow, false);
  assert.equal(verdict.hookSpecificOutput.permissionDecision, "deny");
  assert.match(verdict.hookSpecificOutput.permissionDecisionReason, /SessionStart/);
});

test("decide: allows a command that merely mentions lavish-axi in unrelated prose", () => {
  const verdict = decide(makeBashPayload('echo "we do not run lavish-axi setup hooks here"'));
  // The word pair still appears in the same clause — this documents the conservative-deny
  // tradeoff (a prose mention denies too), not a gap: false-positive-deny is the safe direction
  // for a command this narrow and this rarely legitimate outside the two forbidden subcommands.
  assert.equal(verdict.allow, false);
});

// --- processInput ---

test("processInput: malformed JSON fails open (no output)", () => {
  const result = processInput("not json");
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, null);
});

test("processInput: emits hookSpecificOutput JSON on deny", () => {
  const raw = JSON.stringify(makeBashPayload("npx -y lavish-axi share x.html"));
  const result = processInput(raw);
  assert.equal(result.exitCode, 0);
  const parsed = JSON.parse(result.output);
  assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");
});

test("processInput: no output on allow", () => {
  const raw = JSON.stringify(makeBashPayload("npx -y lavish-axi poll x.html"));
  const result = processInput(raw);
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, null);
});

// LOCKED TEST — settings.json wires lavish-command-gate.mjs into the existing Bash matcher,
// without dropping entry-gate.mjs off that same matcher.
test("settings.json: PreToolUse Bash matcher wires lavish-command-gate.mjs alongside entry-gate.mjs", () => {
  const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
  const pre = settings?.hooks?.PreToolUse;
  assert.ok(Array.isArray(pre), "hooks.PreToolUse must be an array");
  const bashEntry = pre.find((e) => e.matcher === "Bash");
  assert.ok(bashEntry, "a 'Bash' matcher must exist under PreToolUse");
  const cmds = bashEntry.hooks.map((h) => h.command).join(" ");
  assert.match(cmds, /entry-gate\.mjs/);
  assert.match(cmds, /lavish-command-gate\.mjs/);
});
