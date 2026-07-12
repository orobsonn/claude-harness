/**
 * @description OC session-side observability emitters — pure decides + fail-open append.
 * Producers: classify, mark-gate, obs-plan-write plugin, obs-eye plugin.
 * Event types must match core/vps/notify-telegram FEED_ALLOWLIST.
 */
import { existsSync } from "node:fs";
import {
  appendEvent as defaultAppendEvent,
  metaExists as defaultMetaExists,
} from "../../../shared/lib/obs-append.mjs";

const EYE_ROLES = new Set([
  "compliance",
  "adversary",
  "security",
  "plan-reviewer",
  "plan-reviewer-openai",
  "adversary-openai",
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
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   appendEvent?: typeof defaultAppendEvent,
 *   metaExists?: typeof defaultMetaExists,
 *   existsSync?: typeof existsSync,
 * }} [deps]
 * @returns {boolean} true if append attempted (meta present)
 */
export function obsAppend(event, deps = {}) {
  try {
    const env = deps.env ?? process.env;
    const metaPath = resolveObsMetaPath(env);
    const exists = deps.metaExists ?? defaultMetaExists;
    if (!exists(metaPath, { existsSync: deps.existsSync ?? existsSync })) return false;
    const append = deps.appendEvent ?? defaultAppendEvent;
    append(metaPath, event);
    return true;
  } catch {
    return false;
  }
}

/**
 * @description Build pipeline-type event from classify mode.
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
 * @description Map a written path to plan-created / spec-created / null.
 * @param {unknown} filePath
 * @returns {{ type: string, tasks?: number }|null}
 */
export function eventForPlanPath(filePath) {
  if (typeof filePath !== "string" || !filePath) return null;
  const norm = filePath.replace(/\\/g, "/");
  const base = norm.split("/").pop() || "";
  const lower = base.toLowerCase();
  if (lower === "execution-plan.json") return { type: "plan-created" };
  if (lower.includes("spec") && (lower.endsWith(".md") || lower.endsWith(".json"))) {
    return { type: "spec-created" };
  }
  // path segment: .../specs/... or *spec*.md under plans
  if (norm.includes("/plans/") && /spec/i.test(norm) && (lower.endsWith(".md") || lower.endsWith(".json"))) {
    return { type: "spec-created" };
  }
  return null;
}

/**
 * @description Bare role from subagent_type (strip @ and path).
 * @param {unknown} raw
 * @returns {string}
 */
export function bareEyeRole(raw) {
  if (typeof raw !== "string") return "";
  let s = raw.trim();
  if (s.startsWith("@")) s = s.slice(1);
  if (s.includes("/")) s = s.split("/").pop() || s;
  // strip .md
  s = s.replace(/\.md$/i, "");
  return s.toLowerCase();
}

/**
 * @description Parse APPROVE|REVISE from eye response text.
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
 * @description Map eye role + response to outbox event.
 * @param {unknown} roleRaw
 * @param {unknown} responseText
 * @param {{ planExists?: boolean }} [opts]
 * @returns {object|null}
 */
export function eventForEyeRole(roleRaw, responseText, opts = {}) {
  const role = bareEyeRole(roleRaw);
  if (!role || !EYE_ROLES.has(role)) return null;
  const baseRole = role.replace(/-openai$/, "");
  if (baseRole === "plan-reviewer") {
    const verdict = parseEyeVerdict(responseText);
    return verdict
      ? { type: "plan-reviewed", verdict, role: baseRole }
      : { type: "plan-reviewed", role: baseRole };
  }
  if (baseRole === "adversary") {
    // Pre-plan adversary → spec-adversary (CC naming in eye-append); drain also knows spec-adversaried
    if (opts.planExists === false) {
      return { type: "spec-adversary", role: baseRole };
    }
    return { type: "eye", role: baseRole };
  }
  return { type: "eye", role: baseRole };
}

/**
 * @description hand-ran event after hand-finished mark.
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
 * @description task-executing event.
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
 * @description Whether role string is an observability eye.
 * @param {unknown} roleRaw
 * @returns {boolean}
 */
export function isEyeRole(roleRaw) {
  return EYE_ROLES.has(bareEyeRole(roleRaw));
}
