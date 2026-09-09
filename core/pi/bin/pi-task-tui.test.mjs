/** Native Pi InteractiveMode through the supervised task worker, without provider/network calls. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";
import { startTaskProcess, readTaskProcess, taskGroupMembers } from "../lib/task-process.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const quote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("native Pi TUI records tool evidence and shuts down after its positional task", {
  skip: process.platform !== "linux" || !fs.existsSync("/usr/bin/script"),
  timeout: 30000,
}, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-native-task-tui-"));
  let pty;
  let launch;
  t.after(() => {
    if (launch && fs.existsSync(launch.process_path)) {
      const identity = JSON.parse(fs.readFileSync(launch.process_path, "utf8"));
      for (const member of taskGroupMembers(identity.process_group)) {
        try { process.kill(member.pid, "SIGKILL"); } catch {}
      }
    }
    pty?.kill("SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(dir, "fixture.txt"), "native-tool-result\n");
  // A project resource makes a trust prompt possible; --no-approve must avoid any pause.
  fs.mkdirSync(path.join(dir, ".pi"));
  fs.writeFileSync(path.join(dir, ".pi/settings.json"), "{}");
  const fixtureExtension = path.join(dir, "provider.ts");
  fs.writeFileSync(fixtureExtension, `
import { createAssistantMessageEventStream } from ${JSON.stringify(path.join(root, "node_modules/@earendil-works/pi-ai/dist/index.js"))};
export default function (pi) {
  pi.registerProvider("task-tui-fixture", {
    baseUrl: "http://fixture.invalid", apiKey: "fixture-only", api: "task-tui-fixture-api",
    models: [{ id: "fixture", name: "Task TUI fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const done = context.messages.some((message) => message.role === "toolResult");
        const content = done ? [{ type: "text", text: "NATIVE_TUI_COMPLETE" }]
          : [{ type: "toolCall", id: "native-read", name: "read", arguments: { path: "fixture.txt" } }];
        const output = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: done ? "stop" : "toolUse", timestamp: Date.now() };
        stream.push({ type: "start", partial: output });
        if (done) stream.push({ type: "text_delta", contentIndex: 0, delta: content[0].text, partial: output });
        stream.push({ type: "done", reason: output.stopReason, message: output });
        stream.end();
      });
      return stream;
    },
  });
}
`);
  let terminalOutput = "";
  let closed;
  launch = await startTaskProcess({
    jobDir: path.join(dir, "job"), runId: "native-tui", cwd: dir,
    command: process.execPath,
    args: [path.join(root, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
      "--offline", "--no-extensions", "--no-skills", "--no-context-files", "--no-approve",
      "-e", fixtureExtension, "-e", path.join(root, "core/pi/extensions/harness-task-events.ts"),
      "--provider", "task-tui-fixture", "--model", "fixture", "--thinking", "off",
      "Read fixture.txt and finish."],
    presentation: "tui", timeoutMs: 20000,
    launchTerminal: async (request) => {
      const command = [request.command, ...request.args].map(quote).join(" ");
      pty = spawn("/usr/bin/script", ["-qefc", command, path.join(dir, "terminal.log")], {
        cwd: dir, stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, TERM: "xterm-256color", PI_CODING_AGENT_DIR: path.join(dir, "agent"),
          PI_CODING_AGENT_SESSION_DIR: path.join(dir, "sessions") },
      });
      pty.stdout.on("data", (chunk) => { terminalOutput += chunk.toString(); });
      pty.stderr.on("data", (chunk) => { terminalOutput += chunk.toString(); });
      closed = new Promise((resolve, reject) => {
        pty.once("error", reject);
        pty.once("close", (code) => resolve(code));
      });
      return { terminal_handle: "native-pty", surface: "visible" };
    },
  });
  let status;
  for (let count = 0; count < 240; count++) {
    status = readTaskProcess(launch);
    if (status.terminal) break;
    await pause(100);
  }
  assert.equal(status.terminal, true, terminalOutput.slice(-4000));
  assert.equal(status.result?.timedOut, false, terminalOutput.slice(-4000));
  assert.equal(status.result?.exitCode, 0, terminalOutput.slice(-4000));
  assert.equal(await closed, 0);
  assert.match(terminalOutput, /\x1b\[/, "Pi must render the native terminal interface");
  assert.match(terminalOutput, /NATIVE_TUI_COMPLETE/);
  assert.doesNotMatch(terminalOutput, /Trust project folder\?/);
  assert.doesNotMatch(terminalOutput, /\[tool\] read/);
  const events = fs.readFileSync(launch.events_path, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(events[0].type, "session");
  assert.equal(events[0].cwd, dir);
  const toolStart = events.find((event) => event.type === "tool_execution_start");
  const toolEnd = events.find((event) => event.type === "tool_execution_end");
  assert.equal(toolStart?.toolName, "read");
  assert.equal(toolEnd?.toolCallId, toolStart.toolCallId);
  assert.equal(toolEnd?.isError, false);
  assert.match(JSON.stringify(toolEnd.result), /native-tool-result/);
  const sessionFile = fs.readdirSync(path.join(dir, "sessions")).find((name) => name.endsWith(".jsonl"));
  const header = JSON.parse(fs.readFileSync(path.join(dir, "sessions", sessionFile), "utf8").split("\n")[0]);
  assert.deepEqual(events[0], header, "receipt identity is the real persisted Pi header");
});
