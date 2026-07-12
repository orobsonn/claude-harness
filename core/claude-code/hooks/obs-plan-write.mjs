/**
 * @description PostToolUse(Write) hook that emits the SESSION-SIDE border checkpoints — spec-created
 * and plan-created — the moment the planner writes `.claude/plans/<feature>/spec.md` or
 * `execution-plan.json`. Replaces the cron-side `deriveBorderCheckpoints` file-scan as the PRIMARY
 * source of these two events.
 *
 * Why session-side: the drain-derived scan appended these checkpoints at DRAIN time (a later tick),
 * so they landed OUT OF ORDER relative to the immediate session-side events (pipeline-type,
 * spec-adversary, plan-reviewed) — the feed could show "spec atacada" before "spec pronta". Emitting
 * on the Write puts them in real pipeline order: pipeline-type → spec-created → spec-adversary →
 * plan-created → plan-reviewed → … The drain scan stays as a fail-open FALLBACK (its own
 * append-if-absent dedupe means this hook and it never double-emit).
 *
 * Contract (mirrors obs-eye-append / stamp-triage): append-only, NO hookSpecificOutput, fail-open —
 * exits 0 on ANY error, never blocks a Write. Dedupe by type (one spec-created / one plan-created
 * per run) so a re-plan (planner rewrites execution-plan.json under REVISE) does not double-emit.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendEvent as defaultAppendEvent,
  readEvents as defaultReadEvents,
} from "../vps/obs-outbox.mjs";

/**
 * @description Splits a file_path into lowercased, '..'-normalized path components anchored under
 * `.claude/plans/`. Returns the segment array + the index of `.claude`, or null when the path is not
 * under a `.claude/plans/` dir. Mirrors plan-write-gate's traversal-safe, component-anchored check.
 * @param {unknown} filePath
 * @returns {{ segs: string[], ci: number } | null}
 */
function plansPathParts(filePath) {
  if (typeof filePath !== "string" || filePath.length === 0) return null;
  const norm = path.posix.normalize(filePath.replace(/\\/g, "/"));
  const segs = norm.split("/").filter((s) => s.length > 0).map((s) => s.toLowerCase());
  const ci = segs.indexOf(".claude");
  if (ci === -1 || segs[ci + 1] !== "plans") return null;
  return { segs, ci };
}

/** @description True iff file_path is an execution-plan.json under .claude/plans/ (not under .state/). */
function isExecutionPlanPath(filePath) {
  const parts = plansPathParts(filePath);
  if (!parts) return false;
  const { segs, ci } = parts;
  return segs[segs.length - 1] === "execution-plan.json" && segs[ci + 2] !== ".state";
}

/** @description True iff file_path is a spec.md under .claude/plans/ (a feature spec, never .state/). */
function isSpecPath(filePath) {
  const parts = plansPathParts(filePath);
  if (!parts) return false;
  const { segs, ci } = parts;
  return segs[segs.length - 1] === "spec.md" && segs[ci + 2] !== ".state";
}

/** @description Task count from a written execution-plan.json content, or null if unparseable. Pure. */
function countTasks(content) {
  try {
    const parsed = typeof content === "string" ? JSON.parse(content) : content;
    return Array.isArray(parsed?.tasks) ? parsed.tasks.length : null;
  } catch {
    return null;
  }
}

/**
 * @description Pure decision: which border checkpoint (if any) this Write produces. Never throws.
 * @param {unknown} payload
 * @returns {{ action: 'append', event: object } | { action: 'none' }}
 */
export function decide(payload) {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { action: "none" };
  }
  // Write authors the whole document (Edit is not how a planner emits spec/plan); gate to Write.
  if (payload.tool_name !== "Write") return { action: "none" };
  const filePath = payload?.tool_input?.file_path;

  if (isExecutionPlanPath(filePath)) {
    const tasks = countTasks(payload?.tool_input?.content);
    return { action: "append", event: tasks != null ? { type: "plan-created", tasks } : { type: "plan-created" } };
  }
  if (isSpecPath(filePath)) {
    return { action: "append", event: { type: "spec-created" } };
  }
  return { action: "none" };
}

/**
 * @description Production entry: parse stdin, decide, append-if-absent to the run outbox. Fail-open.
 * @param {string} rawStr
 * @param {object} [deps]
 * @returns {{ exitCode: number }}
 */
export function processInput(rawStr, deps) {
  try {
    const payload = JSON.parse(rawStr);
    const d = decide(payload);
    if (d.action !== "append") return { exitCode: 0 };

    const env = (deps && deps.env) ? deps.env : process.env;
    const metaPath = env.HARNESS_OBSERVABILITY_RUN_PATH;
    if (typeof metaPath !== "string" || metaPath.length === 0) return { exitCode: 0 };

    const existsSync = (deps && deps.existsSync) ? deps.existsSync : fs.existsSync;
    if (!existsSync(metaPath)) return { exitCode: 0 };

    const readEvents = (deps && deps.readEvents) ? deps.readEvents : defaultReadEvents;
    const appendEvent = (deps && deps.appendEvent) ? deps.appendEvent : defaultAppendEvent;

    // Dedupe by type: one spec-created / one plan-created per run (a REVISE re-plan rewrites the
    // execution-plan.json, which must not emit a second plan-created).
    const existing = readEvents(metaPath) || [];
    if (existing.some((e) => e && e.type === d.event.type)) return { exitCode: 0 };

    appendEvent(metaPath, d.event);
    return { exitCode: 0 };
  } catch {
    return { exitCode: 0 };
  }
}

// CLI entry — guarded so test imports never trigger side effects.
function isDirectCli() {
  if (!process.argv[1]) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try {
    return fs.realpathSync(process.argv[1]) === modulePath;
  } catch {
    return process.argv[1] === modulePath;
  }
}

if (isDirectCli()) {
  let raw = "";
  try {
    raw = fs.readFileSync(0, "utf8");
  } catch {
    process.exit(0);
  }
  processInput(raw);
  process.exit(0);
}
