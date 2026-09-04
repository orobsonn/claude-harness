import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import harnessClassify from "./harness-classify.ts";

for (const headlessResume of [false, true]) test(`parent suspends locally and resumes the same session (headless=${headlessResume})`, async () => {
  const tools = new Map();
  const handlers = new Map();
  harnessClassify({ registerTool: (tool) => tools.set(tool.name, tool), on: (name, fn) => handlers.set(name, fn) });
  const root = mkdtempSync(join(tmpdir(), "pi-inline-adapter-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    writeFileSync(join(root, ".gitignore"), ".pi/\n");
    execFileSync("git", ["add", ".gitignore"], { cwd: root });
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"], { cwd: root });
    const ctx = { cwd: root, hasUI: true, mode: "tui", sessionManager: { getSessionId: () => "same-local-session", getHeader: () => ({}) } };
    const execute = (input) => tools.get("classify").execute("call", input, undefined, undefined, ctx);
    await execute({ mode: "FULL", feature_id: "inline-example" });
    handlers.get("tool_execution_start")({ toolName: "subagent", toolCallId: "active-eye" });
    assert.equal((await execute({ action: "suspend-inline" })).details.ok, false);
    handlers.get("tool_execution_end")({ toolName: "subagent", toolCallId: "active-eye" });
    const suspended = await execute({ action: "suspend-inline" });
    assert.equal(suspended.details.ok, true);
    assert.equal(suspended.details.ceremonyStatus, "suspended-inline");
    const resumeCtx = { ...ctx, hasUI: !headlessResume, mode: headlessResume ? "print" : "tui" };
    assert.equal(handlers.get("tool_call")({ toolName: "classify", input: { action: "resume-ceremony" } }, resumeCtx), undefined);
    const resumed = await tools.get("classify").execute("resume", { action: "resume-ceremony" }, undefined, undefined, resumeCtx);
    assert.equal(resumed.details.ok, true);
    assert.equal(resumed.details.ceremonyStatus, "active");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("classify adapter enforces headless in both tool hook and execution, retaining local inline", async () => {
  const tools = new Map();
  const handlers = new Map();
  harnessClassify({ registerTool: (tool) => tools.set(tool.name, tool), on: (name, fn) => handlers.set(name, fn) });
  const root = mkdtempSync(join(tmpdir(), "pi-classify-headless-adapter-"));
  const ctx = {
    cwd: root, hasUI: false,
    sessionManager: { getSessionId: () => "headless-adapter", getHeader: () => ({}) },
  };
  const input = { mode: "no-ceremony", feature_id: "inline-test" };
  try {
    assert.equal(handlers.get("tool_call")({ toolName: "classify", input }, ctx)?.block, true);
    assert.equal(handlers.get("tool_call")({ toolName: "classify", input: { action: "suspend-inline", mode: "FULL" } }, ctx)?.block, true);
    const denied = await tools.get("classify").execute("call", input, undefined, undefined, ctx);
    assert.equal(denied.details.error, "headless requires LIGHT or FULL ceremony");
    assert.equal(existsSync(join(root, ".pi")), false);
    const local = { ...ctx, hasUI: true };
    assert.equal(handlers.get("tool_call")({ toolName: "classify", input }, local), undefined);
    const accepted = await tools.get("classify").execute("call", input, undefined, undefined, local);
    assert.equal(accepted.details.mode, "no-ceremony");
    assert.equal(existsSync(join(root, ".pi/harness/state/headless-adapter/gate-state.json")), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
