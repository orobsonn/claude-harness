/**
 * @description Oracle for the vps-access-nudge hook. What it pins is that the reminder is a
 * MECHANISM, not prose: the session this exists for never read the playbook, so the fix has to arrive
 * on the failure itself. It also pins the noise contract — a hook that fires on every
 * `command not found` in a repo gets ignored, and an ignored hook is prose again.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { decide, processInput, responseText } from "./vps-access-nudge.mjs";
import { BARRIERS, classifyFailure } from "../skills/connecting-orca/references/orca-doctor.mjs";

const payload = (command, stderr, stdout = "") => ({
  tool_input: { command },
  tool_response: { stdout, stderr },
});

test("the three failures from the incident each inject their own barrier and fix", () => {
  const cases = [
    ["ssh harness-vps hostname", "root@vps: Permission denied (publickey).", "ssh-identity", /IdentitiesOnly/],
    ["ssh harness-vps hostname", "Host key verification failed.", "known-hosts", /ssh-keyscan/],
    ["ssh harness-vps hostname", "ssh: connect to host 100.98.45.37 port 22: Operation not permitted", "sandbox-network", /sandbox/],
  ];
  for (const [command, stderr, id, fixRe] of cases) {
    const d = decide(payload(command, stderr), classifyFailure);
    assert.equal(d.action, "inject", `${id} must nudge`);
    assert.equal(d.barrier.id, id);
    assert.match(d.context, fixRe, "the fix must travel with the nudge, not just the name of the problem");
    assert.match(d.context, /orca-doctor\.mjs/, "the nudge must name the command that diagnoses the rest");
    assert.match(d.context, /NÃO é falta de acesso/, "the wrong conclusion must be refuted in the injected text");
  }
});

test("ambiguous signatures only fire when the command was actually reaching for the VPS", () => {
  // `command not found` in an ordinary build step must never nudge — a hook that cries wolf is a hook
  // the model learns to skip, which puts us back where the incident started.
  assert.equal(decide(payload("npm run build", "sh: 1: vite: command not found"), classifyFailure).action, "none");
  assert.equal(decide(payload("./deploy.sh", "Unknown command: foo"), classifyFailure).action, "none");

  assert.equal(decide(payload("orca repo ls --json", "Unknown command: repo ls"), classifyFailure).action, "inject");
  assert.equal(decide(payload("orca worktree ps", "sh: 1: orca: command not found"), classifyFailure).action, "inject");
  assert.equal(
    decide(payload("ssh 100.98.45.37 true", "ssh: connect to host 100.98.45.37 port 22: Operation not permitted"), classifyFailure).action,
    "inject",
  );
});

test("a successful command, an empty output, or an unknown failure never injects", () => {
  assert.equal(decide(payload("ssh harness-vps true", "", "ok"), classifyFailure).action, "none");
  assert.equal(decide(payload("ssh harness-vps true", ""), classifyFailure).action, "none");
  assert.equal(decide(payload("ssh harness-vps true", "some brand new failure"), classifyFailure).action, "none");
});

test("responseText flattens both delivery shapes PostToolUse uses", () => {
  assert.match(responseText({ tool_response: "Host key verification failed." }), /Host key/);
  assert.match(responseText({ tool_response: { stderr: "Host key verification failed." } }), /Host key/);
  assert.equal(responseText({}), "");
});

test("fail-open: malformed payloads and a missing skill produce no output and never throw", async () => {
  assert.equal(decide(null, classifyFailure).action, "none");
  assert.equal(decide(payload("x", "y"), () => { throw new Error("boom"); }).action, "none");
  assert.deepEqual(await processInput("not json", classifyFailure), { exitCode: 0, output: null });
  assert.deepEqual(await processInput(JSON.stringify(payload("ls", "")), classifyFailure), { exitCode: 0, output: null });
  // No classifier available (skill not vendored) → silent, never a crashed hook.
  assert.deepEqual(await processInput(JSON.stringify(payload("ssh v", "Host key verification failed.")), null), {
    exitCode: 0,
    output: null,
  });
});

test("the signatures come from orca-doctor's table, not from a copy that can drift", async () => {
  // Identity, not equality: the nudge must hand back the very object from BARRIERS, so a fix edited
  // in the table (and pinned against the playbook by the docs oracle) is the fix the operator sees here.
  const d = decide(payload("ssh harness-vps true", "Host key verification failed."), classifyFailure);
  assert.ok(BARRIERS.includes(d.barrier), "the hook must not carry its own copy of the table");

  // And with no classify argument at all, the hook still resolves the real one through its import.
  const result = await processInput(JSON.stringify(payload("ssh v", "Host key verification failed.")));
  assert.match(JSON.parse(result.output).hookSpecificOutput.additionalContext, /ssh-keyscan/);
});

test("processInput emits the PostToolUse additionalContext envelope the runtime expects", async () => {
  const result = await processInput(
    JSON.stringify(payload("ssh harness-vps true", "Host key verification failed.")),
    classifyFailure,
  );
  assert.equal(result.exitCode, 0);
  const parsed = JSON.parse(result.output);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.match(parsed.hookSpecificOutput.additionalContext, /ssh-keyscan/);
});
