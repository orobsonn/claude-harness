import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentSession, createBashToolDefinition, createReadToolDefinition, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import harnessPolicy from "./harness-policy.ts";
import { writePiChildIdentity } from "../lib/pi-child-identity.mjs";

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-command-evidence-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Evidence Test"], { cwd: root });
  execFileSync("git", ["config", "user.email", "evidence@example.test"], { cwd: root });
  writeFileSync(join(root, "tracked.txt"), "baseline\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "test: baseline"], { cwd: root });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const hooks = new Map();
  harnessPolicy({ on: (name, fn) => hooks.set(name, fn) });
  const context = (session = "task-session") => ({
    cwd: root, hasUI: true,
    sessionManager: { getSessionId: () => session, getSessionFile: () => undefined, getHeader: () => ({}) },
  });
  const raw = Array.from({ length: 2500 }, (_, i) => "evidence-" + i).join("\n") + "\n";
  const nativeSpools = new Set();
  t.after(() => { for (const path of nativeSpools) rmSync(path, { force: true }); });
  async function run(exitCode, { callId = "command-" + exitCode, session, command, timeout, hang = false } = {}) {
    const ctx = context(session);
    writeFileSync(join(root, "command.mjs"), "process.stdout.write(" + JSON.stringify(raw) + "); process.exitCode = " + exitCode + ";\n" + (hang ? "setInterval(() => {}, 1000);\n" : ""));
    const input = { command: command ?? "node command.mjs", ...(timeout ? { timeout } : {}) };
    let result, isError = false;
    try {
      result = await createBashToolDefinition(root).execute(callId, input, undefined, (partialResult) => {
        if (partialResult.details?.fullOutputPath) nativeSpools.add(partialResult.details.fullOutputPath);
        hooks.get("tool_execution_update")?.({ toolName: "bash", toolCallId: callId, partialResult }, ctx);
      }, ctx);
    } catch (error) {
      // The Pi agent converts a native execute exception to this tool result.
      result = { content: [{ type: "text", text: error.message }], details: undefined };
      isError = true;
    }
    const event = { toolName: "bash", toolCallId: callId, input, ...result, isError };
    const patch = await hooks.get("tool_result")?.(event, ctx);
    return { native: event, final: { ...event, ...patch } };
  }
  return { root, head, hooks, context, raw, run };
}

function assertEvidenceIdentity(evidence, f, { command, callId, session = "task-session", kind, exitCode } = {}) {
  assert.equal(evidence.command, command);
  assert.equal(evidence.session_id, session);
  assert.equal(evidence.tool_call_id, callId);
  assert.equal(evidence.worktree_identity_status, "available");
  assert.equal(evidence.worktree_root, f.root);
  assert.equal(evidence.head_sha, f.head);
  assert.equal(evidence.original_status.kind, kind);
  assert.equal(evidence.original_status.is_error, kind !== "success");
  const expectedExit = exitCode ?? (kind === "success" ? 0 : undefined);
  assert.equal(evidence.original_status.exit_code, expectedExit);
  const metadata = JSON.parse(readFileSync(evidence.metadata_path, "utf8"));
  assert.equal(metadata.output_path, evidence.path);
  assert.equal(metadata.output_sha256, evidence.output_sha256);
}

for (const exitCode of [0, 1]) {
  test("native long output with exit " + exitCode + " is readable by the test reviewer on its first call", async (t) => {
    const f = fixture(t);
    const { native, final } = await f.run(exitCode);
    assert.equal(native.isError, exitCode !== 0);
    if (exitCode !== 0) assert.equal(native.details, undefined, "native RED loses final output metadata");
    const evidence = final.details?.command_evidence;
    assert.equal(evidence?.status, "available", "the harness must hand back an accessible artifact");
    assert.ok(evidence.path.startsWith(join(f.root, ".pi/harness/state/task-session/evidence/")));
    assert.equal(readFileSync(evidence.path, "utf8"), f.raw, "the complete raw output is preserved, not its tail");
    assert.equal(final.isError, native.isError);
    assert.deepEqual(final.content.slice(0, native.content.length), native.content);
    assert.ok(final.content.at(-1).text.includes(evidence.path));
    if (exitCode !== 0) assert.match(final.content[0].text, /Command exited with code 1$/);

    assert.equal(writePiChildIdentity(f.root, {
      parentSessionId: "task-session", childSessionId: "test-reviewer", role: "harness-test-reviewer", callId: "review-1",
    }).ok, true);
    const reviewer = { cwd: f.root, hasUI: true, sessionManager: {
      getSessionId: () => "test-reviewer", getHeader: () => ({ parentSession: "task-session" }),
    } };
    const input = { path: evidence.path, offset: 1, limit: 1 };
    assert.equal(f.hooks.get("tool_call")({ toolName: "read", input }, reviewer), undefined);
    const read = await createReadToolDefinition(f.root).execute("review-read-1", input, undefined, undefined, {});
    assert.match(read.content[0].text, /^evidence-0\n/);
    const tail = await createReadToolDefinition(f.root).execute("review-read-2", { ...input, offset: 2500 }, undefined, undefined, {});
    assert.match(tail.content[0].text, /evidence-2499/);
    const metadataInput = { path: evidence.metadata_path, offset: 1, limit: 80 };
    assert.equal(f.hooks.get("tool_call")({ toolName: "read", input: metadataInput }, reviewer), undefined);
    const metadataRead = await createReadToolDefinition(f.root).execute("review-read-metadata", metadataInput, undefined, undefined, {});
    assert.match(metadataRead.content[0].text, /"tool_call_id"/);
    assert.match(metadataRead.content[0].text, /"original_status"/);
  });
}

test("short output stays inline and gains exact command, status, session, call and worktree evidence", async (t) => {
  const f = fixture(t);
  const command = "git log -1 --format=%s";
  const callId = "short-success";
  const { native, final } = await f.run(0, { command, callId });
  assert.equal(final.content[0].text, "test: baseline\n");
  assert.equal(final.isError, native.isError);
  assert.deepEqual(final.content.slice(0, native.content.length), native.content);
  assert.equal(readFileSync(final.details.command_evidence.path, "utf8"), "test: baseline\n");
  assertEvidenceIdentity(final.details.command_evidence, f, { command, callId, kind: "success" });
});

test("short failing output preserves the native error and records its exact exit status", async (t) => {
  const f = fixture(t);
  const command = "git rev-parse --verify missing-evidence-ref";
  const callId = "short-error";
  const { native, final } = await f.run(128, { command, callId });
  assert.equal(native.isError, true);
  assert.equal(final.isError, true);
  assert.deepEqual(final.content.slice(0, native.content.length), native.content);
  assert.equal(readFileSync(final.details.command_evidence.path, "utf8"), native.content[0].text);
  assertEvidenceIdentity(final.details.command_evidence, f, { command, callId, kind: "exit", exitCode: 128 });
});

test("truncated inline output without a validated native spool is unavailable, never partial evidence", async (t) => {
  const f = fixture(t);
  const event = {
    toolName: "bash",
    toolCallId: "truncated-no-spool",
    input: { command: "git diff" },
    content: [{ type: "text", text: "tail only\n[output truncated]" }],
    details: { truncation: { truncated: true } },
    isError: false,
  };
  const patch = await f.hooks.get("tool_result")(event, f.context());
  assert.equal(patch.details.command_evidence.status, "unavailable");
  assert.equal(patch.details.command_evidence.reason, "complete native output unavailable");
  assert.equal(patch.details.command_evidence.path, undefined);
  assert.deepEqual(patch.content.slice(0, event.content.length), event.content);
  assert.doesNotMatch(patch.content.at(-1).text, /Repair the evidence location before review/);
  assert.match(patch.content.at(-1).text, /complete.*inline/i);
});

test("missing Git identity does not discard otherwise complete short native output", async (t) => {
  const f = fixture(t);
  execFileSync("git", ["update-ref", "-d", "refs/heads/main"], { cwd: f.root });
  const { native, final } = await f.run(0, { command: "git status --short", callId: "unborn-head" });
  assert.equal(final.details.command_evidence.status, "available");
  assert.equal(final.details.command_evidence.worktree_identity_status, "unavailable");
  assert.equal(final.details.command_evidence.head_sha, undefined);
  assert.equal(readFileSync(final.details.command_evidence.path, "utf8"), native.content[0].text);
});

test("known credential and diary commands are intentionally not archived without a recovery loop", async (t) => {
  const f = fixture(t);
  for (const [callId, command] of [
    ["credential-command", "sed -n '1,20p' .env"],
    ["diary-command", "cat .pi/harness/state/task-session/shared_context.md"],
    ["environment-command", "printenv"],
    ["auth-token-command", "gh auth token"],
  ]) {
    const event = { toolName: "bash", toolCallId: callId, input: { command }, content: [{ type: "text", text: "private data" }], isError: false };
    const patch = await f.hooks.get("tool_result")(event, f.context());
    assert.equal(patch.details.command_evidence.status, "not-archived");
    assert.equal(patch.details.command_evidence.reason, "credential-or-diary-command");
    assert.equal(patch.details.command_evidence.path, undefined);
    assert.deepEqual(patch.content.slice(0, event.content.length), event.content);
    assert.doesNotMatch(patch.content.at(-1).text, /repair|rerun|retry/i);
  }
});

test("source searches for security words remain ordinary command evidence", async (t) => {
  const f = fixture(t);
  const event = {
    toolName: "bash",
    toolCallId: "harmless-token-search",
    input: { command: "rg -n \"token:\" src" },
    content: [{ type: "text", text: "src/example.ts:1:token: schema field\n" }],
    isError: false,
  };
  const patch = await f.hooks.get("tool_result")(event, f.context());
  assert.equal(patch.details.command_evidence.status, "available");
  assert.equal(readFileSync(patch.details.command_evidence.path, "utf8"), event.content[0].text);
});

test("opaque short commands do not automatically share output with reviewers", async (t) => {
  const f = fixture(t);
  for (const command of ["node -e 'console.log(process.env.API_TOKEN)'", "./custom-private-command"]) {
    const event = { toolName: "bash", toolCallId: "opaque-output", input: { command }, content: [{ type: "text", text: "private-output-fixture" }], isError: false };
    const patch = await f.hooks.get("tool_result")(event, f.context());
    assert.equal(patch.details.command_evidence.status, "not-archived");
    assert.equal(patch.details.command_evidence.path, undefined);
    assert.deepEqual(patch.content.slice(0, event.content.length), event.content);
    assert.equal(patch.isError, undefined);
    assert.doesNotMatch(patch.content.at(-1).text, /repair|rerun|retry|blocked/i);
  }
});

test("short test and typecheck results remain automatically accessible", async (t) => {
  const f = fixture(t);
  for (const command of ["npm test", "npm run typecheck", "pnpm test", "yarn test", "bun test", "node --test test/unit.test.mjs", "npx tsc --noEmit"]) {
    const event = { toolName: "bash", toolCallId: command, input: { command }, content: [{ type: "text", text: "verification output\n" }], isError: false };
    const patch = await f.hooks.get("tool_result")(event, f.context());
    assert.equal(patch.details.command_evidence.status, "available", command);
    assert.equal(readFileSync(patch.details.command_evidence.path, "utf8"), "verification output\n");
  }
});

test("timed out native output remains accessible without being reported as a behavioral RED", async (t) => {
  const f = fixture(t);
  const { native, final } = await f.run(0, { timeout: 2, hang: true });
  assert.equal(final.isError, true);
  assert.match(final.content[0].text, /Command timed out after 2 seconds$/);
  assert.equal(final.details?.command_evidence?.status, "available");
  assert.equal(final.details.command_evidence.original_status.kind, "timeout");
  assert.equal(final.details.command_evidence.original_status.timeout_seconds, 2);
  assert.equal(readFileSync(final.details.command_evidence.path, "utf8"), f.raw);
  assert.deepEqual(final.content.slice(0, native.content.length), native.content);
});

test("stream metadata is scoped to its exact session and call and a foreign result cannot consume it", async (t) => {
  const f = fixture(t);
  const spool = join(tmpdir(), "pi-bash-" + randomBytes(8).toString("hex") + ".log");
  // Exclusive fixture name avoids replacing another process's native evidence.
  writeFileSync(spool, f.raw, { flag: "wx" });
  t.after(() => rmSync(spool, { force: true }));
  const update = { toolName: "bash", toolCallId: "shared-id", partialResult: { details: { fullOutputPath: spool } } };
  f.hooks.get("tool_execution_update")(update, f.context("session-a"));
  const result = { toolName: "bash", toolCallId: "shared-id", input: { command: "npm test" }, content: [{ type: "text", text: "Command exited with code 1" }], isError: true };
  const foreignSession = await f.hooks.get("tool_result")(result, f.context("session-b"));
  assert.equal(foreignSession.details.command_evidence.session_id, "session-b");
  assert.equal(readFileSync(foreignSession.details.command_evidence.path, "utf8"), result.content[0].text);
  const foreignCall = await f.hooks.get("tool_result")({ ...result, toolCallId: "other-id" }, f.context("session-a"));
  assert.equal(foreignCall.details.command_evidence.tool_call_id, "other-id");
  assert.equal(readFileSync(foreignCall.details.command_evidence.path, "utf8"), result.content[0].text);
  const correct = await f.hooks.get("tool_result")(result, f.context("session-a"));
  assert.equal(readFileSync(correct.details.command_evidence.path, "utf8"), f.raw);
  const replay = await f.hooks.get("tool_result")(result, f.context("session-a"));
  assert.equal(readFileSync(replay.details.command_evidence.path, "utf8"), result.content[0].text);
});

test("stdout cannot select a file to copy and native metadata cannot redirect to a symlink", async (t) => {
  const f = fixture(t);
  const source = join(f.root, "synthetic-output.txt");
  writeFileSync(source, "not native output");
  const event = { toolName: "bash", toolCallId: "fake-output", input: { command: "git diff" }, content: [{ type: "text", text: "Full output: " + source }], isError: true };
  const stdoutOnly = await f.hooks.get("tool_result")(event, f.context());
  assert.equal(stdoutOnly.details.command_evidence.status, "available");
  assert.equal(readFileSync(stdoutOnly.details.command_evidence.path, "utf8"), event.content[0].text);
  assert.notEqual(readFileSync(stdoutOnly.details.command_evidence.path, "utf8"), readFileSync(source, "utf8"));
  const link = join(tmpdir(), "pi-bash-" + randomBytes(8).toString("hex") + ".log");
  symlinkSync(source, link);
  t.after(() => rmSync(link, { force: true }));
  const patched = await f.hooks.get("tool_result")({ ...event, details: { fullOutputPath: link } }, f.context());
  assert.equal(patched.details.command_evidence.status, "unavailable");
});

test("large git diff uses the same native evidence path without a separate export protocol", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, "before.txt"), "old\n");
  writeFileSync(join(f.root, "after.txt"), f.raw);
  const { final } = await f.run(1, { command: "git diff --no-index -- before.txt after.txt" });
  assert.equal(final.details?.command_evidence?.status, "available");
  const diff = readFileSync(final.details.command_evidence.path, "utf8");
  assert.match(diff, /^diff --git /);
  assert.match(diff, /\+evidence-0\n/);
  assert.match(diff, /\+evidence-2499\n/);
  assert.equal(final.isError, true, "diff exit 1 must not be turned into command success");
});

test("evidence storage failure preserves the command result and reports the transport failure", async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.root, ".pi/harness/state/task-session"), { recursive: true });
  writeFileSync(join(f.root, ".pi/harness/state/task-session/evidence"), "not a directory");
  const { native, final } = await f.run(1);
  assert.equal(final.details?.command_evidence?.status, "unavailable");
  assert.equal(final.details.command_evidence.path, undefined);
  assert.equal(final.isError, true);
  assert.deepEqual(final.content.slice(0, native.content.length), native.content);
  assert.match(final.content.at(-1).text, /evidence.*unavailable/i);
});

test("a redirected evidence directory is not used to write outside the project", async (t) => {
  const f = fixture(t);
  const outside = mkdtempSync(join(tmpdir(), "pi-evidence-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  mkdirSync(join(f.root, ".pi/harness/state/task-session"), { recursive: true });
  symlinkSync(outside, join(f.root, ".pi/harness/state/task-session/evidence"), "dir");
  const { final } = await f.run(0);
  assert.equal(final.details?.command_evidence?.status, "unavailable");
  assert.equal(final.isError, false);
});

test("native Pi agent event pipeline preserves a long RED through tool_result", { timeout: 15000 }, async (t) => {
  const f = fixture(t);
  const agentDir = join(f.root, "agent-config");
  mkdirSync(agentDir);
  writeFileSync(join(f.root, "command.mjs"), "process.stdout.write(" + JSON.stringify(f.raw) + "); process.exitCode = 1;\n");
  const spools = new Set();
  t.after(() => { for (const file of spools) rmSync(file, { force: true }); });
  const loader = new DefaultResourceLoader({
    cwd: f.root, agentDir, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [harnessPolicy, (pi) => pi.on("tool_execution_update", (event) => {
      if (event.partialResult?.details?.fullOutputPath) spools.add(event.partialResult.details.fullOutputPath);
    })],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models-store.json"),
    refreshOnCreate: false, allowModelNetwork: false,
  });
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("bash", { command: "node command.mjs" }, { id: "native-red" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ]);
  runtime.registerNativeProvider(faux.provider);
  const manager = SessionManager.inMemory(f.root);
  const stateDir = join(f.root, ".pi/harness/state", manager.getSessionId());
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "gate-state.json"), JSON.stringify({ session_id: manager.getSessionId(), feature_id: "evidence", classified: true, mode: "QUICK" }));
  const { session } = await createAgentSession({
    cwd: f.root, agentDir, resourceLoader: loader, modelRuntime: runtime, model: faux.getModel(),
    sessionManager: manager, settingsManager: SettingsManager.inMemory(),
  });
  t.after(() => session.dispose());
  await session.bindExtensions({});
  await session.prompt("Run the synthetic command.", { expandPromptTemplates: false });
  const result = session.messages.find((message) => message.role === "toolResult" && message.toolCallId === "native-red");
  assert.equal(result?.isError, true);
  assert.match(result.content[0].text, /Command exited with code 1$/);
  assert.equal(result.details?.command_evidence?.status, "available");
  assert.equal(readFileSync(result.details.command_evidence.path, "utf8"), f.raw);
});
