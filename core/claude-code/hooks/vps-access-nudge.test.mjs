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

test("a publickey denial from a CODE FORGE never nudges — the delivery loop pushes on every run", () => {
  // Regression: `ssh-identity` was treated as unambiguous, so `git push` failing against GitHub made
  // the hook assert "this is NOT missing access to the VPS" and send the agent to orca-doctor. The
  // hook exists to stop a confident wrong conclusion; manufacturing one in the delivery loop is worse
  // than staying quiet.
  const forge = [
    ["git push", "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository."],
    ["gh pr create --fill", "git@github.com: Permission denied (publickey)."],
    ["git clone git@gitlab.com:acme/app.git", "git@gitlab.com: Permission denied (publickey)."],
    ["ssh -T git@github.com", "git@github.com: Permission denied (publickey)."],
    ["git fetch origin", "Host key verification failed.\nfatal: Could not read from remote repository (github.com)."],
  ];
  for (const [command, stderr] of forge) {
    assert.equal(decide(payload(command, stderr), classifyFailure).action, "none", `must stay silent for: ${command}`);
  }

  // …while the real thing still fires.
  assert.equal(decide(payload("ssh harness-vps hostname", "root@vps: Permission denied (publickey)."), classifyFailure).action, "inject");
  assert.equal(decide(payload("scp file.json harness-vps:/tmp/", "Host key verification failed."), classifyFailure).action, "inject");
});

test("`orca` must be a COMMAND token — /home/orca is the home directory of the playbook's own user", () => {
  // Regression: `\borca\b` matched any path under /home/orca, so a trivial local ENOENT on this very
  // machine fired "isso NÃO é falta de acesso à VPS… instalar o Orca desktop". That is the fastest
  // way to teach the model to ignore the hook, which puts us back at the incident.
  const localNoise = [
    ["node /home/orca/dev/app/build.mjs", "Error: ENOENT: no such file or directory, open '/home/orca/dev/app/x.json'"],
    ["cat /home/orca/notes.md", "cat: /home/orca/notes.md: command not found"],
  ];
  for (const [command, stderr] of localNoise) {
    assert.equal(decide(payload(command, stderr), classifyFailure).action, "none", `must stay silent for: ${command}`);
  }
  assert.equal(decide(payload("orca worktree ps --json", "sh: 1: orca: command not found"), classifyFailure).action, "inject");
  assert.equal(decide(payload("sudo -u orca crontab -l", "Unknown command: x"), classifyFailure).action, "inject");
});

test("a tailnet address identifies the VPS even when it appears only in the OUTPUT", () => {
  // `git fetch` against a repo hosted on the VPS names the host in the error, never in the command.
  const d = decide(
    payload("git fetch origin", "ssh: connect to host 100.98.45.37 port 22: Operation not permitted"),
    classifyFailure,
  );
  assert.equal(d.action, "inject");
  assert.equal(d.barrier.id, "sandbox-network");
});

test("fail-open is real: a hook whose sibling skill is missing exits 0 with no output", async () => {
  // The promise in this file's header ("exits 0 on ANY error") cannot be kept by a static import —
  // a missing module kills the process before any try/catch runs.
  const { loadClassifier } = await import("./vps-access-nudge.mjs");
  assert.equal(typeof await loadClassifier(), "function", "with the skill present it must resolve");
  assert.deepEqual(await processInput(JSON.stringify(payload("ssh v", "Host key verification failed.")), null), {
    exitCode: 0,
    output: null,
  });
});

test("the tailnet's IPv6 ULA identifies the VPS just like its IPv4 range", () => {
  const d = decide(
    payload("git fetch origin", "ssh: connect to host fd7a:115c:a1e0::3f1 port 22: Operation not permitted"),
    classifyFailure,
  );
  assert.equal(d.action, "inject", "an IPv6-only tailnet remote must not be invisible to the nudge");
  assert.equal(decide(payload("curl https://api.example.com", "connect EPERM 93.184.216.34:443"), classifyFailure).action, "none");
});
