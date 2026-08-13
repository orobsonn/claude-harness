/**
 * @description OC session-side observability emitters — pure decides + fail-open append.
 * Producers: classify, obs-plan-write, obs-eye, obs-hand plugins.
 * Event types must match core/vps/notify-telegram FEED_ALLOWLIST.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseTaskDispatchIdentity } from "./task-dispatch-identity.mjs";
import {
  appendEvent as defaultAppendEvent,
  metaExists as defaultMetaExists,
  readEvents as defaultReadEvents,
} from "../../shared/lib/obs-append.mjs";
import { currentAttemptEvents } from "../../shared/lib/obs-attempt.mjs";
import {
  REVIEW_AGENT_ALIASES,
  REVIEW_AGENT_CATALOG,
  reviewAgentIdentity,
} from "../agents/review-catalog.mjs";

const EYE_ROLES = new Set([
  "compliance",
  "security",
  ...Object.keys(REVIEW_AGENT_CATALOG),
  ...Object.keys(REVIEW_AGENT_ALIASES),
]);

/**
 * @description Resolve HARNESS_OBSERVABILITY_RUN_PATH from env.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|null}
 */
export function resolveObsMetaPath(env = process.env) {
  const p = env?.HARNESS_OBSERVABILITY_RUN_PATH;
  return typeof p === "string" && p.length > 0 ? p : null;
}

/**
 * @description Fail-open append when meta exists. Never throws.
 * @param {object} event
 * @param {object} [deps]
 * @returns {boolean}
 */
export function obsAppend(event, deps = {}) {
  try {
    const env = deps.env ?? process.env;
    const metaPath = resolveObsMetaPath(env);
    const exists = deps.metaExists ?? defaultMetaExists;
    if (!exists(metaPath, { existsSync: deps.existsSync ?? existsSync })) return false;
    if (typeof deps.dedupe === "function") {
      const read = deps.readEvents ?? defaultReadEvents;
      const existing = read(metaPath);
      if (deps.dedupe(existing, event)) return false;
    }
    const append = deps.appendEvent ?? defaultAppendEvent;
    append(metaPath, event);
    return true;
  } catch {
    return false;
  }
}

/**
 * @description Dedupe only within the current attempt: plan-created by (type,tasks),
 * spec/final-review by type, task-executing by (type,n).
 * @param {object[]} existing
 * @param {object} event
 * @returns {boolean} true = skip
 */
export function dedupeByType(existing, event) {
  if (!event || typeof event.type !== "string") return false;
  const attempt = currentAttemptEvents(existing);
  if (event.type === "plan-created") {
    return attempt.some((e) => e && e.type === "plan-created" && (e.tasks ?? null) === (event.tasks ?? null));
  }
  if (event.type === "spec-created" || event.type === "final-review-done") {
    return attempt.some((e) => e && e.type === event.type);
  }
  if (event.type === "task-executing" && event.n != null) {
    return attempt.some(
      (e) => e && e.type === "task-executing" && e.n === event.n,
    );
  }
  // plan-reviewed: dedupe identical verdicts emitted structurally by review eyes.
  if (event.type === "plan-reviewed") {
    return attempt.some(
      (e) =>
        e &&
        e.type === "plan-reviewed" &&
        (e.verdict ?? null) === (event.verdict ?? null),
    );
  }
  // hand-ran: same task id
  if (event.type === "hand-ran" && event.task) {
    return attempt.some(
      (e) => e && e.type === "hand-ran" && e.task === event.task,
    );
  }
  return false;
}

/**
 * @param {unknown} mode
 * @returns {{ type: string, mode: string }|null}
 */
export function eventForPipelineType(mode) {
  if (typeof mode !== "string" || !mode.trim()) return null;
  const m = mode.trim();
  const upper = m.toUpperCase();
  const normalized =
    upper === "QUICK" || upper === "LIGHT" || upper === "FULL"
      ? upper
      : m.toLowerCase() === "no-ceremony"
        ? "NO-CEREMONY"
        : m;
  return { type: "pipeline-type", mode: normalized };
}

/**
 * @param {unknown} filePath
 * @returns {{ type: string, tasks?: number }|null}
 */
export function eventForPlanPath(filePath) {
  if (typeof filePath !== "string" || !filePath) return null;
  const norm = filePath.replace(/\\/g, "/");
  const segs = norm.split("/").filter(Boolean).map((s) => s.toLowerCase());
  const oc = segs.indexOf(".opencode");
  if (oc === -1 || segs[oc + 1] !== "plans") return null;
  if (segs[oc + 2] === ".state") return null;
  const base = segs[segs.length - 1] || "";
  if (base === "execution-plan.json") return { type: "plan-created" };
  if (base.includes("spec") && (base.endsWith(".md") || base.endsWith(".json"))) {
    return { type: "spec-created" };
  }
  return null;
}

/**
 * @param {string} planFilePath
 * @param {{ readFileSync?: typeof readFileSync }} [io]
 * @returns {boolean}
 */
export function isFullExecutionPlan(planFilePath, io = {}) {
  try {
    const read = io.readFileSync ?? readFileSync;
    const raw = read(planFilePath, "utf8");
    const j = JSON.parse(raw);
    return Array.isArray(j?.tasks) && j.tasks.length > 0;
  } catch {
    return false;
  }
}

/**
 * @description Canonical plan dir: .opencode/plans/<featureId>
 * @param {string} cwd
 * @param {string} featureId
 * @returns {string|null}
 */
export function planDirForRun(cwd, featureId) {
  if (typeof cwd !== "string" || !cwd) return null;
  if (typeof featureId !== "string" || !featureId) return null;
  return join(cwd, ".opencode", "plans", featureId);
}

/**
 * @description Full plan exists for the classified feature. Missing feature = false.
 * Falls back to gate-state feature_id when featureId empty.
 * @param {{
 *   cwd: string,
 *   sessionId?: string|null,
 *   featureId?: string|null,
 *   isFull?: (p: string) => boolean,
 *   existsSync?: typeof existsSync,
 *   readFileSync?: typeof readFileSync,
 * }} opts
 * @returns {boolean}
 */
export function fullPlanExistsForRun(opts) {
  const {
    cwd,
    sessionId,
    featureId,
    isFull = isFullExecutionPlan,
    existsSync: exists = existsSync,
    readFileSync: read = readFileSync,
  } = opts;
  try {
    const sid = typeof sessionId === "string" ? sessionId : "";
    let fid = typeof featureId === "string" ? featureId : "";
    if (!fid && sid) {
      // gate-state feature_id
      try {
        const gs = join(cwd, ".opencode", "plans", ".state", sid, "gate-state.json");
        if (exists(gs)) {
          const j = JSON.parse(read(gs, "utf8"));
          if (typeof j.feature_id === "string") fid = j.feature_id;
        }
      } catch {
        /* ignore */
      }
    }
    if (fid) {
      const planPath = join(
        cwd,
        ".opencode",
        "plans",
        fid,
        "execution-plan.json",
      );
      if (exists(planPath) && isFull(planPath, { readFileSync: read })) return true;
      return false;
    }
    // No feature: fail closed to "no full plan" (prefer spec-adversary over wrong eye)
    return false;
  } catch {
    return false;
  }
}

/**
 * @description 1-based task index and total from full plan for taskId.
 * @param {string} planFilePath
 * @param {string} taskId
 * @param {{ readFileSync?: typeof readFileSync }} [io]
 * @returns {{ n: number, total: number }|null}
 */
export function taskIndexFromPlan(planFilePath, taskId, io = {}) {
  try {
    if (typeof taskId !== "string" || !taskId) return null;
    const read = io.readFileSync ?? readFileSync;
    const j = JSON.parse(read(planFilePath, "utf8"));
    const tasks = Array.isArray(j?.tasks) ? j.tasks : [];
    if (tasks.length === 0) return null;
    const idx = tasks.findIndex(
      (t) => t && (t.id === taskId || t.task_id === taskId),
    );
    if (idx < 0) return null;
    return { n: idx + 1, total: tasks.length };
  } catch {
    return null;
  }
}

/**
 * @param {unknown} raw
 * @returns {string}
 */
export function bareEyeRole(raw) {
  if (typeof raw !== "string") return "";
  let s = raw.trim();
  if (s.startsWith("@")) s = s.slice(1);
  if (s.includes("/")) s = s.split("/").pop() || s;
  if (s.includes(":")) s = s.slice(s.lastIndexOf(":") + 1);
  s = s.replace(/\.md$/i, "");
  return s.toLowerCase();
}

/**
 * @param {unknown} responseText
 * @returns {'APPROVE'|'REVISE'|null}
 */
export function parseEyeVerdict(responseText) {
  try {
    const text =
      typeof responseText === "string"
        ? responseText
        : responseText == null
          ? ""
          : JSON.stringify(responseText);
    const anchored = text.match(/\bverdict\b[:\s]*["']?(APPROVE|REVISE)\b/i);
    if (anchored) return /** @type {'APPROVE'|'REVISE'} */ (anchored[1].toUpperCase());
    if (/\bREVISE\b/.test(text)) return "REVISE";
    if (/\bAPPROVE\b/.test(text)) return "APPROVE";
    return null;
  } catch {
    return null;
  }
}

/**
 * @param {unknown} roleRaw
 * @param {unknown} responseText
 * @param {{ planExists?: boolean }} [opts]
 * @returns {object|null}
 */
export function eventForEyeRole(roleRaw, responseText, opts = {}) {
  const role = bareEyeRole(roleRaw);
  if (!role || !EYE_ROLES.has(role)) return null;
  const baseRole = reviewAgentIdentity(role)?.logicalRole ?? role;
  if (baseRole === "plan-reviewer") {
    const verdict = parseEyeVerdict(responseText);
    return verdict
      ? { type: "plan-reviewed", verdict, role: baseRole }
      : { type: "plan-reviewed", role: baseRole };
  }
  if (baseRole === "adversary") {
    if (opts.planExists === false) {
      return { type: "spec-adversary", role: baseRole };
    }
    return { type: "eye", role: baseRole };
  }
  return { type: "eye", role: baseRole };
}

/**
 * @param {{ task?: string, model?: string }} args
 * @returns {object|null}
 */
export function eventForHandRan(args = {}) {
  const task = typeof args.task === "string" ? args.task : "";
  if (!task) return null;
  const ev = { type: "hand-ran", task };
  if (typeof args.model === "string" && args.model) ev.model = args.model;
  return ev;
}

/**
 * @param {{ n?: unknown, total?: unknown }} args
 * @returns {object|null}
 */
export function eventForTaskExecuting(args = {}) {
  const n = Number(args.n);
  const total = Number(args.total);
  if (!Number.isInteger(n) || n < 1 || !Number.isInteger(total) || total < 1) return null;
  return { type: "task-executing", n, total };
}

/**
 * @param {unknown} roleRaw
 * @returns {boolean}
 */
export function isEyeRole(roleRaw) {
  return EYE_ROLES.has(bareEyeRole(roleRaw));
}

export { reviewAgentIdentity };

/**
 * @param {unknown} roleRaw
 * @returns {boolean}
 */
export function isHandRole(roleRaw) {
  const bare = bareEyeRole(roleRaw);
  if (!bare) return false;
  if (bare === "test-author" || bare.startsWith("test-author")) return true;
  if (bare === "executor" || bare.startsWith("executor-")) return true;
  if (bare === "sniper" || bare.startsWith("sniper-")) return true;
  return false;
}

/**
 * @param {unknown} input
 * @param {unknown} output
 * @returns {Record<string, unknown>|null}
 */
export function resolveHookArgs(input, output) {
  const o =
    output != null && typeof output === "object" && !Array.isArray(output)
      ? /** @type {Record<string, unknown>} */ (output)
      : null;
  const i =
    input != null && typeof input === "object" && !Array.isArray(input)
      ? /** @type {Record<string, unknown>} */ (input)
      : null;
  const raw = o?.args ?? i?.args ?? i?.toolArgs ?? o?.toolArgs ?? null;
  if (raw != null && typeof raw === "object" && !Array.isArray(raw)) {
    return /** @type {Record<string, unknown>} */ (raw);
  }
  return null;
}

/**
 * @param {Record<string, unknown>|null} args
 * @returns {{ featureId: string, taskId: string, model: string, role: string }}
 */
export function extractTaskIds(args) {
  if (!args) return { featureId: "", taskId: "", model: "", role: "" };
  const nested =
    args.input != null && typeof args.input === "object" && !Array.isArray(args.input)
      ? /** @type {Record<string, unknown>} */ (args.input)
      : null;
  const str = (v) => (typeof v === "string" ? v : "");
  const role = str(
    args.subagent_type ?? args.subagentType ?? args.agent ?? args.role ?? nested?.subagent_type ?? nested?.agent,
  );
  const featureId = str(
    args.feature_id ?? args.featureId ?? args.feature ?? nested?.feature_id ?? nested?.featureId,
  );
  const prompt = str(args.prompt ?? nested?.prompt);
  const marker = parseTaskDispatchIdentity(prompt);
  const taskId = marker.ok
    ? marker.taskId
    : str(args.task_id ?? args.taskId ?? args.task ?? nested?.task_id ?? nested?.taskId);
  const model = str(args.model ?? nested?.model);
  return { featureId, taskId, model, role };
}
