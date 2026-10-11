#!/usr/bin/env node
/**
 * @description Stop + UserPromptSubmit hook — delivery continuation for parallel tasks (port of Pi's
 * lib/delivery-continuation.mjs and the TUI `agent_end` of extensions/harness-task-events.ts).
 * Resume an unfinished authorized workflow; never manufacture completion evidence.
 *
 * LANE (`CLAUDE_HARNESS_TASK_RUN`): when the turn ends before this task's capture (and, in FULL,
 * its reviews and re-gate) is in place, the stop is blocked once per distinct progress state with
 * the stage's instruction. Otherwise the lane is done: a TUI lane (Orca terminal) records the
 * end-of-turn result and ends its own `claude`, as Pi's TUI shuts down at agent_end; a stream-json
 * lane simply stops.
 * PARENT (a task registry for this session): while tasks are unsettled, or everything is
 * integrated but nothing is delivered yet (HEAD on no remote branch), the stop is blocked once per
 * distinct state with the stage's instruction.
 * An explicit stop request typed by the operator ("pare", "stop", "/quit"…) pauses continuation
 * until the next prompt. The hints are advisory: the existing tools stay the only authority.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { isSafeSessionId } from "./lib/gate-lib.mjs";
import { parseMarkCommand } from "./lib/task-lane-contract.mjs";
import { readLaneLedger } from "./lib/task-events.mjs";
import { readTaskRunBinding } from "./lib/task-admission.mjs";
import { finalizeTuiEvents, readTuiJob, tuiLaunchPid } from "./lib/task-tui-events.mjs";
import { TASK_RUN_ENV, isVolatileHarnessPath, laneLedgerFile, sessionStateDir, taskRegistryPath } from "./lib/task-paths.mjs";
import { parseTaskRunEnv } from "./task-gate.mjs";

const STOP_REQUEST = /^\s*(?:\/abort|\/quit|\/exit|stop|pause|cancel|pare|pausa|cancele|cancelar|n[aã]o continue|do not continue)\b/i;
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const git = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }).trim();

export const INSTRUCTIONS = Object.freeze({
  "task-implementation": "Continue this same task through the remaining implementation, verification, capture and applicable reviews (task-runtime). Inspect existing pending work first. If the test-author already produced the required RED or fixture repair, review its fidelity and freeze-commit the authorized tests, then continue the implementation; do not redispatch authorship just to repeat that work. Preserve valid product work. If an external dependency or authority is genuinely missing, return BLOCKED with that exact blocker; do not repeat an unchanged failed action.",
  "task-reviews": "The task has a current capture but its local review closure is pending. Dispatch only the missing eyes on the committed HEAD, resolve findings through the sniper and re-gate, then mark regate-passed. Do not repeat implementation or valid reviews merely to close the task.",
  tasks: "The delivery still has unsettled tasks. Run `node .claude/hooks/tasks.mjs status --json '{}'` to reconcile the real processes and read diagnostics, `wait` for live tasks, integrate ready results and recover actionable blockers in the same attempts. Do not end with only a running label.",
  "final-review": "Task integration is not delivery completion. Verify the current aggregate, finish the applicable final reviews, then harvest and ship within the existing authorization. Do not reopen integrated tasks without a concrete finding. A draft PR is a valid headless delivery boundary; never infer merge, release or deployment authorization.",
});

const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
};

function continuationState(dir) {
  return readJson(path.join(dir, "continuation.json")) ?? { seen: [], paused: false };
}
function saveContinuation(dir, state) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "continuation.json"), JSON.stringify({ seen: state.seen.slice(-200), paused: state.paused }), { mode: 0o600 });
}

function dirtyPaths(root) {
  return [...new Set([
    ...git(root, "diff", "--name-only", "-z", "HEAD", "--").split("\0"),
    ...git(root, "ls-files", "--others", "--exclude-standard", "-z").split("\0"),
  ].filter((name) => name && !isVolatileHarnessPath(name)))].sort();
}

/** Lane hint: null when this task's capture (and FULL closure) is in place at the current HEAD. */
export function laneContinuation(root, binding) {
  const head = git(root, "rev-parse", "HEAD");
  const dirty = dirtyPaths(root);
  const featureId = binding.grant.feature_id;
  const taskId = binding.grant.task_id;
  const ledger = [...readLaneLedger(laneLedgerFile(root, binding.sessionId)).values()].map((pair) => pair.post).filter(Boolean)
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const markOf = (record, action) => record.tool === "Bash" && record.status === "ok" && record.agent_id === null &&
    (() => { const mark = parseMarkCommand(record.command ?? ""); return mark?.action === action && mark.flags["feature-id"] === featureId && mark.flags["task-id"] === taskId; })();
  const writer = (record) => record.tool === "Agent" && record.status === "ok" && /^(?:test-author|executor(?:-high)?|sniper(?:-high)?)$/.test(String(record.subagent_type ?? "").split(":").pop());
  const captureIndex = ledger.findLastIndex((record) => markOf(record, "capture-verified"));
  const capture = ledger[captureIndex];
  const captured = Boolean(capture) && capture.head === head && Array.isArray(capture.dirty) && capture.dirty.length === 0 &&
    dirty.length === 0 && !ledger.slice(captureIndex + 1).some(writer);
  const full = binding.grant.mode === "FULL";
  const eyesAfter = captured ? ledger.slice(captureIndex + 1).filter((record) => record.tool === "Agent" && record.status === "ok" &&
    /^(?:compliance|adversary|security)$/.test(String(record.subagent_type ?? "").split(":").pop())).length : 0;
  const pendingIndex = ledger.findLastIndex((record) => markOf(record, "regate-pending"));
  const regated = pendingIndex < 0 || ledger.slice(pendingIndex + 1).some((record) => markOf(record, "regate-passed"));
  if (captured && (!full || (eyesAfter > 0 && regated))) return null;
  const stage = captured ? "task-reviews" : "task-implementation";
  return { stage, key: hash({ lane: binding.sessionId, stage, head, dirty, calls: ledger.length }), content: INSTRUCTIONS[stage] };
}

/** Parent hint: null when no task was admitted or the delivery reached a remote branch. */
export function parentContinuation(root, sessionId) {
  const registry = readJson(taskRegistryPath(root, sessionId));
  if (!registry || registry.parent_session_id !== sessionId || !registry.tasks || !Object.keys(registry.tasks).length) return null;
  const head = git(root, "rev-parse", "HEAD");
  const tasks = Object.values(registry.tasks).map((entry) => ({ task: entry.task_id, status: entry.status, head: entry.integration?.integrated_head ?? entry.result?.child_head }));
  let delivered = false;
  try { delivered = git(root, "branch", "-r", "--contains", head).length > 0; } catch { delivered = false; }
  if (delivered && !registry.correction_barrier && tasks.every((task) => task.status === "integrated")) return null;
  const stage = tasks.some((task) => task.status !== "integrated") || registry.correction_barrier ? "tasks" : "final-review";
  return { stage, key: hash({ parent: sessionId, stage, head, tasks }), content: INSTRUCTIONS[stage] };
}

function block(reason) {
  return { decision: "block", reason: `[harness-continuation] ${reason}` };
}

/**
 * Decide one hook payload. Returns { output?: object, finalize?: { jobFile } } — `output` is the
 * hook's JSON stdout; `finalize` asks the caller to end this TUI lane.
 */
export function decide(payload, { env = process.env, cwd = process.cwd(), readBinding = readTaskRunBinding } = {}) {
  if (!payload || typeof payload !== "object" || !isSafeSessionId(payload.session_id)) return {};
  const lane = Object.hasOwn(env, TASK_RUN_ENV) ? parseTaskRunEnv(env[TASK_RUN_ENV]) : null;
  if (Object.hasOwn(env, TASK_RUN_ENV) && (!lane || lane.sessionId !== payload.session_id)) return {};
  const root = fs.realpathSync(lane ? lane.cwd : cwd);
  const dir = sessionStateDir(root, payload.session_id);
  const state = continuationState(dir);
  if (payload.hook_event_name === "UserPromptSubmit") {
    const paused = STOP_REQUEST.test(String(payload.prompt ?? ""));
    if (paused !== state.paused && (lane || fs.existsSync(dir))) saveContinuation(dir, { ...state, paused });
    return {};
  }
  if (payload.hook_event_name !== "Stop") return {};
  let pending = null;
  if (lane) {
    const binding = readBinding(root, payload.session_id);
    if (binding?.ok) pending = laneContinuation(root, binding);
  } else {
    pending = parentContinuation(root, payload.session_id);
  }
  if (pending && !state.paused && !state.seen.includes(pending.key)) {
    saveContinuation(dir, { ...state, seen: [...state.seen, pending.key] });
    return { output: block(pending.content) };
  }
  if (lane) {
    const tui = readTuiJob({ env, cwd: root });
    if (tui) return { finalize: { jobFile: tui.jobFile } };
  }
  return {};
}

function isDirectCli() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return process.argv[1] === fileURLToPath(import.meta.url);
  }
}

if (isDirectCli()) {
  let payload = null;
  try { payload = JSON.parse(fs.readFileSync(0, "utf8")); } catch { payload = null; }
  let verdict = {};
  try {
    verdict = decide(payload);
  } catch (error) {
    process.stderr.write(`[harness-continuation] ${error instanceof Error ? error.message : String(error)}\n`);
  }
  if (verdict.output) process.stdout.write(`${JSON.stringify(verdict.output)}\n`);
  if (verdict.finalize) {
    // Pi's TUI shuts down at agent_end; a Claude Code TUI needs its launcher signalled. The host
    // accepts this SIGTERM exit only together with the end-of-turn record written first.
    try {
      const root = fs.realpathSync(parseTaskRunEnv(process.env[TASK_RUN_ENV]).cwd);
      finalizeTuiEvents(payload, { cwd: root });
      const pid = tuiLaunchPid(verdict.finalize.jobFile);
      if (pid) process.kill(pid, "SIGTERM");
      else process.stderr.write("[harness-continuation] TUI launcher not found; close this terminal to end the lane\n");
    } catch (error) {
      process.stderr.write(`[harness-continuation] TUI finalize failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  process.exit(0);
}
