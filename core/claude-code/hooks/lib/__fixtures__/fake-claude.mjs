#!/usr/bin/env node
/**
 * @description Hermetic stand-in for `claude -p` in parallel-task e2e tests. Accepts the exact lane
 * flags (task-launcher.mjs), emulates Claude Code's hook runner against the worktree's VENDORED
 * `.claude/settings.json` (real hooks, real payload shapes from the spike, PreToolUse deny honoured)
 * and emits stream-json in the real format (system/init, assistant tool_use, user tool_result with
 * tool_use_result, result). Each step really happens in the worktree: Bash commands run, subagent
 * writes land on disk. Never used at runtime.
 *
 *   fake-claude.mjs --scenario <scenario.json> <claude -p flags…>
 *
 * Scenario: { "tasks": { "<task-id>": { "launches": [ { "steps": [...], "exit": 0 }, … ] } } } — the task
 * comes from the [HARNESS_TASK_RUN] envelope of --append-system-prompt; invocation N of that task
 * uses launches[N].
 * Steps: {"bash": "<cmd>"} · {"agent": {subagent_type, model, prompt, writes:[{path,content}],
 * report, status, async}} · {"text": "…"} · {"sleep": ms} · {"write": {path, content}} (main loop).
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

const argv = process.argv.slice(2);
const flag = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const scenarioPath = flag("--scenario");
for (const required of ["-p", "--output-format", "--verbose", "--model", "--permission-mode", "--tools", "--allowedTools", "--setting-sources", "--strict-mcp-config", "--append-system-prompt"]) {
  if (!argv.includes(required)) {
    process.stderr.write(`fake-claude: missing ${required}\n`);
    process.exit(2);
  }
}
if (flag("--output-format") !== "stream-json") process.exit(2);
const sessionId = flag("--session-id") ?? flag("--resume");
if (!sessionId) process.exit(2);
const cwd = process.cwd();
const system = flag("--append-system-prompt");
const envelope = JSON.parse(system.slice(system.lastIndexOf("[HARNESS_TASK_RUN]\n") + "[HARNESS_TASK_RUN]".length, system.lastIndexOf("[/HARNESS_TASK_RUN]")));
const taskId = envelope.contract.task.id;
const counterFile = `${scenarioPath}.${taskId}.count`;
const invocation = fs.existsSync(counterFile) ? Number(fs.readFileSync(counterFile, "utf8")) : 0;
fs.writeFileSync(counterFile, String(invocation + 1));
const scenario = JSON.parse(fs.readFileSync(scenarioPath, "utf8"));
const launch = scenario.tasks?.[taskId]?.launches?.[invocation] ?? { steps: [], exit: 0 };
fs.writeFileSync(`${scenarioPath}.${taskId}.argv.${invocation}.json`, JSON.stringify({ argv, sessionId, cwd, resumed: envelope.resumed, env: { CLAUDE_HARNESS_TASK_RUN: process.env.CLAUDE_HARNESS_TASK_RUN } }));

const emit = (event) => process.stdout.write(`${JSON.stringify({ ...event, session_id: sessionId, uuid: randomUUID() })}\n`);
const settings = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(cwd, ".claude", "settings.json"), "utf8")); } catch { return { hooks: {} }; }
})();

function runHooks(event, toolName, payload) {
  const groups = settings.hooks?.[event] ?? [];
  const outputs = [];
  for (const group of groups) {
    const matcher = group.matcher ?? "*";
    if (toolName !== null && matcher !== "*" && matcher !== "" && !new RegExp(`^(?:${matcher})$`).test(toolName)) continue;
    for (const hook of group.hooks ?? []) {
      if (hook.type !== "command") continue;
      const run = spawnSync("sh", ["-c", hook.command], {
        cwd, input: JSON.stringify({ session_id: sessionId, transcript_path: `/fake/${sessionId}.jsonl`, cwd, permission_mode: "acceptEdits", hook_event_name: event, ...payload }),
        env: { ...process.env, CLAUDE_PROJECT_DIR: cwd }, encoding: "utf8", timeout: 60_000,
      });
      outputs.push(run);
    }
  }
  return outputs;
}

function denied(outputs) {
  for (const run of outputs) {
    if (run.status === 2) return run.stderr || "hook exited 2";
    try {
      const parsed = JSON.parse(run.stdout.trim().split("\n").filter(Boolean).at(-1) ?? "{}");
      if (parsed?.hookSpecificOutput?.permissionDecision === "deny") return parsed.hookSpecificOutput.permissionDecisionReason;
    } catch { /* plain stdout */ }
  }
  return null;
}

function toolCall(name, input, perform, { agentId = null, agentType = null, parentToolUseId = null } = {}) {
  const id = `toolu_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const identity = agentId ? { agent_id: agentId, agent_type: agentType } : {};
  emit({ type: "assistant", parent_tool_use_id: parentToolUseId, message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } });
  const reason = denied(runHooks("PreToolUse", name, { tool_name: name, tool_input: input, tool_use_id: id, ...identity }));
  if (reason) {
    const text = `PreToolUse:${name} hook error: ${reason}`;
    emit({ type: "user", parent_tool_use_id: parentToolUseId, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: text }] }, tool_use_result: `Error: ${text}` });
    return { denied: reason };
  }
  const outcome = perform(id);
  if (outcome.error) {
    runHooks("PostToolUseFailure", name, { tool_name: name, tool_input: input, tool_use_id: id, error: outcome.error, is_interrupt: false, ...identity });
    emit({ type: "user", parent_tool_use_id: parentToolUseId, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: outcome.error }] }, tool_use_result: `Error: ${outcome.error}` });
  } else {
    runHooks("PostToolUse", name, { tool_name: name, tool_input: input, tool_use_id: id, tool_response: outcome.response, ...identity });
    emit({ type: "user", parent_tool_use_id: parentToolUseId, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: false, content: outcome.text }] }, tool_use_result: outcome.response });
  }
  return outcome;
}

function bash(command, options) {
  return toolCall("Bash", { command, description: "run" }, () => {
    const run = spawnSync("bash", ["-c", command], { cwd, env: process.env, encoding: "utf8" });
    if (run.status !== 0) return { error: `Exit code ${run.status}\n${run.stderr}${run.stdout}`.trim() };
    return { text: run.stdout.trim(), response: { stdout: run.stdout, stderr: run.stderr, interrupted: false, isImage: false, noOutputExpected: false } };
  }, options);
}

function write(file, content, options) {
  const absolute = path.resolve(cwd, file);
  return toolCall("Write", { file_path: absolute, content }, () => {
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
    return { text: `File created successfully at: ${absolute}`, response: { type: "create", filePath: absolute, content } };
  }, options);
}

function agent(spec) {
  const input = { description: spec.description ?? "task step", prompt: spec.prompt, subagent_type: spec.subagent_type, ...(spec.model ? { model: spec.model } : {}), ...(spec.run_in_background ? { run_in_background: true } : {}) };
  return toolCall("Agent", input, (id) => {
    const agentId = `a${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    runHooks("SubagentStart", null, { agent_id: agentId, agent_type: spec.subagent_type });
    emit({ type: "system", subtype: "task_started", task_id: agentId, tool_use_id: id, subagent_type: spec.subagent_type, is_backgrounded: spec.async === true, prompt: spec.prompt });
    for (const item of spec.writes ?? []) write(item.path, item.content, { agentId, agentType: spec.subagent_type, parentToolUseId: id });
    for (const command of spec.bash ?? []) bash(command, { agentId, agentType: spec.subagent_type, parentToolUseId: id });
    runHooks("SubagentStop", null, { agent_id: agentId, agent_type: spec.subagent_type, stop_hook_active: false, last_assistant_message: spec.report ?? "" });
    const response = spec.async === true
      ? { isAsync: true, status: "async_launched", agentId, description: input.description, prompt: spec.prompt }
      : { status: spec.status ?? "completed", prompt: spec.prompt, agentId, agentType: spec.subagent_type, content: [{ type: "text", text: spec.report ?? "" }], resolvedModel: `claude-${spec.model ?? "sonnet"}` };
    emit({ type: "system", subtype: "task_notification", task_id: agentId, tool_use_id: id, status: response.status });
    return { text: spec.report ?? "", response };
  });
}

emit({ type: "system", subtype: "init", cwd, model: flag("--model"), permissionMode: flag("--permission-mode"), tools: flag("--tools").split(","), mcp_servers: [], claude_code_version: "fake" });
for (const step of launch.steps ?? []) {
  if (step.bash !== undefined) bash(step.bash);
  else if (step.agent) agent(step.agent);
  else if (step.write) write(step.write.path, step.write.content);
  else if (step.text !== undefined) emit({ type: "assistant", parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "text", text: step.text }] } });
  else if (step.sleep) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, step.sleep);
}
const exit = launch.exit ?? 0;
emit({ type: "result", subtype: exit === 0 ? "success" : "error_during_execution", is_error: exit !== 0, num_turns: (launch.steps ?? []).length, result: launch.result ?? "done" });
process.exit(exit);
