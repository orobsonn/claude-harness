/** Resume an unfinished authorized workflow, never manufacture completion evidence. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { isSafeSessionId, isSafeFeatureId } from "../../shared/lib/feature-id.mjs";
import { isChildSession, piSessionId } from "./pi-adapter-map.mjs";
import { readTaskRunBinding } from "./task-run.mjs";
import { checkScope } from "../../shared/lib/capture-oracle.mjs";

const ENTRY = "harness-delivery-continuation";
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const read = (root, file) => {
  const absolute = path.join(root, file);
  try {
    if (fs.realpathSync(absolute) !== absolute || !fs.statSync(absolute).isFile() || fs.statSync(absolute).size > 4 * 1024 * 1024) return null;
    return JSON.parse(fs.readFileSync(absolute, "utf8"));
  } catch { return null; }
};

// A RED/fixture can advance before freeze commits it. Hash only the admitted
// task's pending bytes: staging, timestamps and runtime files are not progress.
// This is a continuation hint, never capture, fidelity or write authority.
function pendingTaskContent(root, task = {}) {
  const git = args => execFileSync("git", args, { cwd: root, encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"], timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
  const scopes = [...(task.scope_paths ?? []), ...(task.allowed_writes ?? []),
    ...(task.locked_tests ?? []).flatMap(t => [t.path, ...(t.fixture_paths ?? [])])];
  const diff = ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z"];
  const files = [...new Set([
    ...git([...diff, "--cached", "HEAD", "--"]).split("\0"),
    ...git([...diff, "--"]).split("\0"),
    ...git(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0"),
  ])].filter(file => file && checkScope([file], scopes).length === 0 &&
    !/^(?:\.git|\.pi|\.claude|\.codex|\.opencode)(?:\/|$)/.test(file)).sort();
  return files.map(file => {
    const absolute = path.join(root, file);
    try {
      if (fs.realpathSync(path.dirname(absolute)) !== path.dirname(absolute)) return [file, "indirect-path"];
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) return [file, "symlink", hash(fs.readlinkSync(absolute))];
      if (!stat.isFile() || stat.size > 4 * 1024 * 1024) return [file, "unreadable"];
      return [file, stat.mode & 0o111, createHash("sha256").update(fs.readFileSync(absolute)).digest("hex")];
    } catch (error) {
      return [file, error.code === "ENOENT" ? "deleted" : "unreadable"];
    }
  });
}

/** Read-only hints. Existing tools remain the sole approval and scheduling authority. */
export function readDeliveryContinuation(ctx, { readBinding = readTaskRunBinding } = {}) {
  const sessionId = piSessionId(ctx);
  if (isChildSession(ctx) || !isSafeSessionId(sessionId)) return null;
  const root = fs.realpathSync(ctx.cwd);
  if (root !== ctx.cwd) return null;
  const directory = `.pi/harness/state/${sessionId}`;
  const state = read(root, `${directory}/gate-state.json`);
  if (state?.session_id !== sessionId || !isSafeFeatureId(state.feature_id) ||
      !["FULL", "LIGHT"].includes(String(state.mode).toUpperCase())) return null;
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const feature = state.feature_id;
  let stage, progress;
  if (state.task_run) {
    const binding = readBinding(root, sessionId);
    if (!binding.ok) return null;
    const taskId = binding.grant.task_id;
    const key = `${feature}/${taskId}`;
    const pendingContent = pendingTaskContent(root, binding.task);
    const captured = pendingContent.length === 0 && (state.hand_finished ?? []).includes(key) && (state.capture_verified ?? []).includes(`${key}@${head}`);
    const reviews = { ...(state.task_review_evidence?.[key] ?? {}), adversary: state.task_adversary_evidence?.[key] };
    const reviewRequired = state.mode.toUpperCase() === "FULL" || Object.values(reviews).some(Boolean);
    const regated = (state.regate_passed ?? []).includes(`${key}@${head}`);
    if (captured && (!reviewRequired || regated)) return null;
    stage = captured ? "task-reviews" : "task-implementation";
    progress = { taskId, head, captured, pendingContent, fidelity: state.fidelity_pass?.at(-1),
      reviews: Object.fromEntries(Object.entries(reviews).map(([role, r]) => [role, r ? [r.status, r.accepted, r.report_digest, r.reviewed_head_sha] : null])) };
  } else {
    const registry = read(root, `${directory}/task-runs/index.json`);
    if (registry?.parent_session_id !== sessionId || registry.feature_id !== feature || !registry.tasks) return null;
    const shipment = read(root, `${directory}/memory-shipment.json`);
    const finalized = read(root, `${directory}/memory-finalized.json`);
    if (shipment?.written_by === "host-subagent-completion" && shipment.session_id === sessionId &&
        shipment.feature_id === feature && shipment.status === "completed" && shipment.head === head) return null;
    if (finalized?.written_by === "host-memory-finalize" && finalized.session_id === sessionId && finalized.feature_id === feature && finalized.head === head) return null;
    const tasks = Object.values(registry.tasks).map(e => ({ task: e.task_id, status: e.status,
      head: e.integration?.integrated_head ?? e.result?.child_head, reason: e.reason }));
    if (!tasks.length) return null;
    stage = tasks.some(t => t.status !== "integrated") ? "tasks" : state.final_review_done ? "shipping" : "final-review";
    const harvest = read(root, `${directory}/memory-harvest.json`);
    progress = { head, tasks, final: state.final_review_done, harvest: harvest?.apply_status,
      reviews: Object.fromEntries(Object.entries(state.final_review_evidence ?? {}).map(([role, r]) => [role, [r.status, r.accepted, r.report_digest, r.reviewed_head_sha]])) };
  }
  const instructions = {
    "task-implementation": "Continue this same task through the remaining implementation, verification, capture and applicable reviews. Inspect existing pending work first. If the author already produced the required RED or fixture repair, review its fidelity and freeze/commit the authorized tests, then continue the required implementation; do not redispatch authorship just to repeat that work. Repair an incorrect frozen fixture with the existing test-author/reviewer recovery. Preserve valid product work. If an external dependency or authority is genuinely missing, report that exact blocker; do not repeat an unchanged failed action.",
    "task-reviews": "The task has a capture but its local review closure remains pending. Use harness_reviews phase=task, satisfy only affected missing obligations, then record regate-passed. Do not repeat implementation or valid reviews merely to close the task.",
    tasks: "The delivery still has unsettled tasks. Use harness_tasks status to reconcile actual processes and read diagnostics, wait for live tasks, integrate ready results, and recover actionable blockers in the same attempts. Do not end with only a running label.",
    "final-review": "Task integration is not delivery completion. Verify the current aggregate, finish applicable final reviews and final-review marking, then harvest and ship within the existing authorization. Do not reopen integrated tasks without a concrete finding.",
    shipping: "Finish the existing harvest/apply/shipping obligations, reusing valid receipts. A draft PR is a valid headless delivery boundary; never infer merge, release or deployment authorization from this reminder.",
  };
  // Re-running an identical command does not buy another continuation. A first
  // successful verification on this HEAD does count as progress toward closure.
  let commands = [];
  try {
    commands = fs.readdirSync(path.join(root, directory, "evidence")).filter(f => f.endsWith(".json")).slice(-2000)
      .map(f => read(root, `${directory}/evidence/${f}`))
      .filter(e => e?.head_sha === head && e.worktree_dirty === false && e.original_status?.exit_code === 0)
      .map(e => e.command).filter(c => typeof c === "string");
  } catch { /* Evidence is advisory; absence never waives a gate. */ }
  return { sessionId, stage, key: hash({ sessionId, feature, stage, progress, commands: [...new Set(commands)].sort() }), content: instructions[stage] };
}

/** One nudge per unchanged obligation, durable across compaction/restart. */
export function installDeliveryContinuation(pi, { readPending = readDeliveryContinuation, local = false } = {}) {
  let active = local;
  let paused = false;
  const seen = new Set();
  const owned = ctx => !isChildSession(ctx) && isSafeSessionId(piSessionId(ctx));
  const restore = ctx => {
    for (const e of ctx.sessionManager?.getBranch?.() ?? []) {
      if (e.type === "custom" && e.customType === ENTRY && e.data?.sessionId === piSessionId(ctx)) {
        if (e.data.key) seen.add(e.data.key);
        if (e.data.paused !== undefined) paused = e.data.paused;
      }
    }
  };
  const reset = (_event, ctx) => {
    if (!owned(ctx)) return;
    active = local; paused = false; seen.clear(); restore(ctx);
  };
  pi.on("session_start", reset);
  pi.on("session_tree", reset);
  pi.on("input", (event, ctx) => {
    if (!owned(ctx) || !["interactive", "rpc"].includes(event.source)) return;
    // Explicit stop requests remain stops even if the model answers normally.
    if (/^\s*(?:\/abort|\/quit|stop|pause|cancel|pare|pausa|cancele|cancelar|n[aã]o continue|do not continue)\b/i.test(event.text ?? "")) {
      paused = true;
      active = false;
      pi.appendEntry(ENTRY, { sessionId: piSessionId(ctx), paused: true });
    } else if (paused) {
      paused = false;
      active = local;
      pi.appendEntry(ENTRY, { sessionId: piSessionId(ctx), paused: false });
    }
  });
  pi.on("tool_result", (event, ctx) => {
    if (!owned(ctx) || event.isError || paused) return;
    // A fresh workflow action renews existing authorization after a pause.
    if (event.toolName === "harness_tasks" && event.details?.ok &&
        event.details.tasks?.some(t => ["running", "ready", "integrated"].includes(t.status))) {
      active = true;
    }
  });
  return async (event, ctx) => {
    if (!owned(ctx) || !active || paused) return false;
    const last = event.messages?.filter(m => m.role === "assistant").at(-1);
    if (["aborted", "error"].includes(last?.stopReason)) return false;
    try {
      restore(ctx);
      if (paused) return false;
      const pending = readPending(ctx);
      if (!pending) return false;
      if (seen.has(pending.key)) {
        ctx.ui?.notify?.("Harness: a obrigação continua pendente sem progresso. A retomada automática não será repetida; consulte o bloqueio informado.", "warning");
        return false;
      }
      await pi.sendMessage({ customType: ENTRY, content: pending.content, display: true }, { deliverAs: "followUp", triggerTurn: true });
      seen.add(pending.key);
      pi.appendEntry(ENTRY, { sessionId: pending.sessionId, key: pending.key, stage: pending.stage });
      return true;
    } catch (error) {
      ctx.ui?.notify?.(`Harness: não foi possível continuar automaticamente: ${error.message}`, "warning");
      return false;
    }
  };
}
