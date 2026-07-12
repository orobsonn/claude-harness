/**
 * @description Pure decide for plan-write-gate parity (OC port of CC plan-write-gate decide).
 * Denies Write/Edit to execution-plan.json, gate-state.json, triage.json under .opencode/plans/
 * except planner role (via task context). Fail-open on infra errors.
 * Mirrors CC #ac-u1.1..#ac-u1.3; adapted paths (.opencode vs .claude).
 */
import path from "node:path";

const FORBIDDEN_STATE_BASENAMES = new Set(["gate-state.json", "triage.json"]);

function pathSegments(filePath) {
  if (typeof filePath !== "string" || filePath.length === 0) return [];
  const norm = path.posix.normalize(filePath.replace(/\\/g, "/"));
  return norm.split("/").filter((s) => s.length > 0).map((s) => s.toLowerCase());
}

function isCarvedOut(filePath) {
  if (typeof filePath !== "string") return false;
  const norm = path.posix.normalize(filePath.replace(/\\/g, "/"));
  if (norm.includes("..")) return false; // traversal → no carve bypass
  const segs = norm.split("/").filter((s) => s.length > 0).map((s) => s.toLowerCase());
  return segs.some((s) => s === "__fixtures__" || s.includes(".test."));
}

function isForbiddenStateBasename(filePath) {
  const segs = pathSegments(filePath);
  if (segs.length === 0) return false;
  return FORBIDDEN_STATE_BASENAMES.has(segs[segs.length - 1]);
}

function isStateFilePath(filePath) {
  if (typeof filePath !== "string" || filePath.length === 0) return false;
  const norm = path.posix.normalize(filePath.replace(/\\/g, "/"));
  if (norm.startsWith("/") || norm.includes("..")) return false; // reject absolute/traversal
  const segs = norm.split("/").filter((s) => s.length > 0).map((s) => s.toLowerCase());
  if (!segs[segs.length - 1].endsWith(".json")) return false;
  const ci = segs.indexOf(".opencode");
  return ci !== -1 && segs[ci + 1] === "plans" && segs[ci + 2] === ".state";
}

function isExecutionPlanPath(filePath) {
  if (typeof filePath !== "string" || filePath.length === 0) return false;
  const norm = path.posix.normalize(filePath.replace(/\\/g, "/"));
  if (norm.startsWith("/") || norm.includes("..")) return false; // reject absolute/traversal
  const segs = norm.split("/").filter((s) => s.length > 0).map((s) => s.toLowerCase());
  if (segs.length < 2) return false;
  if (segs[segs.length - 1] !== "execution-plan.json") return false;
  const ci = segs.indexOf(".opencode");
  return ci !== -1 && segs[ci + 1] === "plans";
}

export function decide(payload) {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { allow: true };
  }
  const filePath = payload?.tool_input?.file_path;
  const carved = isCarvedOut(filePath);
  if (!carved && isForbiddenStateBasename(filePath)) {
    return {
      allow: false,
      hookSpecificOutput: {
        hookEventName: "tool.execute.before",
        permissionDecision: "deny",
        permissionDecisionReason:
          "[plan-write-gate] Blocked: gate-state/triage (basename) written ONLY by harness hooks, never Write/Edit tool.",
      },
    };
  }
  if (!carved && isStateFilePath(filePath)) {
    return {
      allow: false,
      hookSpecificOutput: {
        hookEventName: "tool.execute.before",
        permissionDecision: "deny",
        permissionDecisionReason:
          "[plan-write-gate] Blocked: .opencode/plans/.state/ JSONs written ONLY by harness hooks.",
      },
    };
  }
  if (!isExecutionPlanPath(filePath)) {
    return { allow: true };
  }
  // OC: planner role via task context (agent_type or dispatch marker); main loop denied.
  const isPlanner = payload?.agent_type && payload.agent_type.toLowerCase().includes("planner");
  if (isPlanner) {
    return { allow: true };
  }
  return {
    allow: false,
    hookSpecificOutput: {
      hookEventName: "tool.execute.before",
      permissionDecision: "deny",
      permissionDecisionReason:
        "[plan-write-gate] Blocked: orchestrator must not author execution-plan.json. Planner task only.",
    },
  };
}
