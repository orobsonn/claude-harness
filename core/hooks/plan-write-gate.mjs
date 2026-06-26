/**
 * @description PreToolUse(Write|Edit) hook — deterministic plan-authorship rail.
 *
 * Closes the inline-plan door: the orchestrator (main loop) must NOT write or edit a
 * feature's execution-plan.json itself — only the dispatched `planner` subagent may.
 * This is the deterministic complement to the <PLANNER-ONLY> prose guard in creating-plans.
 *
 * Decision:
 *   DENY a Write/Edit whose tool_input.file_path resolves to an execution-plan.json under
 *   any .claude/plans/ directory, UNLESS the payload carries an own `agent_id` (subagent
 *   context) AND bareRole(agent_type) === 'planner'. All other writes pass freely.
 *
 * Separate file from entry-gate.mjs by SRP: entry-gate gates Agent|Bash and carries the
 * triage/planner/shipper/regate order; mixing the Write/Edit payload shape into that
 * decide() would entangle two unrelated gates.
 *
 * Fail-open contract: exits 0 on ANY parse/infra error; DENY is emitted only in the
 * deliberate decision branch. A buggy gate must never brick file writes.
 *
 * Deny output (stdout, then exit 0):
 *   {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}
 * Allow output: no stdout, exit 0.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bareRole } from "./lib/gate-lib.mjs";

/**
 * Tests whether a file_path resolves to an execution-plan.json under a .claude/plans/ dir.
 * Normalizes separators and resolves '.'/'..' segments first so a traversal variant
 * (e.g. '.claude/plans/x/../y/execution-plan.json') cannot evade the check, while a path
 * that '..'-escapes OUT of plans is correctly treated as a non-plan write.
 * Anchors on PATH COMPONENTS (split on '/'), never substring, so 'xyz.claude/plans' style
 * lookalikes do not match.
 * @param {unknown} filePath
 * @returns {boolean} true iff this is an execution-plan.json under .claude/plans/
 */
function isExecutionPlanPath(filePath) {
  if (typeof filePath !== "string" || filePath.length === 0) {
    return false;
  }
  const norm = path.posix.normalize(filePath.replace(/\\/g, "/"));
  // Case-insensitive: the operator's platform (darwin) is case-insensitive by default, so
  // 'Execution-Plan.json' or '.Claude/plans/' open the SAME real file — match them too.
  const segs = norm.split("/").filter((s) => s.length > 0).map((s) => s.toLowerCase());
  if (segs.length < 2) {
    return false;
  }
  if (segs[segs.length - 1] !== "execution-plan.json") {
    return false;
  }
  const ci = segs.indexOf(".claude");
  return ci !== -1 && segs[ci + 1] === "plans";
}

/**
 * Tests whether a file_path resolves to a JSON file under a .claude/plans/.state/ directory
 * (gate-state.json, triage.json). These files are the deterministic gates' state and must be
 * written ONLY by the stamp-triage/entry-gate hooks (which use fs directly, never a tool call) —
 * never by a Write/Edit tool. A direct tool write would let a caller forge regate_passed /
 * capture_verified / escalation_fallback and launder every rail at once. Case-insensitive and
 * '..'-normalized, same as isExecutionPlanPath.
 * @param {unknown} filePath
 * @returns {boolean} true iff this is a *.json under .claude/plans/.state/
 */
function isStateFilePath(filePath) {
  if (typeof filePath !== "string" || filePath.length === 0) {
    return false;
  }
  const norm = path.posix.normalize(filePath.replace(/\\/g, "/"));
  const segs = norm.split("/").filter((s) => s.length > 0).map((s) => s.toLowerCase());
  if (!segs[segs.length - 1].endsWith(".json")) {
    return false;
  }
  const ci = segs.indexOf(".claude");
  return ci !== -1 && segs[ci + 1] === "plans" && segs[ci + 2] === ".state";
}

/**
 * Content cancela for the model_strategy furo: a planner Write must carry the `hand_tiers`
 * model_strategy (cheap Ollama hands), NEVER the legacy Claude `tiers` shape — which 404s at
 * dispatch because hands always target the Ollama endpoint. This makes the model_strategy shape
 * a DETERMINISTIC rail instead of relying on the planner self-running validate-plan.
 *
 * Only a COMPLETE write (content is a string) is checked — a planner emits the plan via Write,
 * not incremental Edit. An Edit/anomalous payload (no string content) fails OPEN; the spawn-hand
 * Claude-alias guard is the backstop at the consumer. A parse failure on a Write IS a positive
 * invalid signal (a Write carries the whole document) → DENY, not fail-open.
 * @param {unknown} content - payload.tool_input.content
 * @returns {string|null} a deny reason, or null when acceptable / not checkable
 */
export function checkPlanContent(content) {
  if (typeof content !== "string") return null; // Edit / anomalous → fail open
  let plan;
  try {
    plan = JSON.parse(content);
  } catch {
    return "[plan-write-gate] Blocked: the execution-plan.json is not valid JSON — a Write must carry the complete, parseable document.";
  }
  const ms = plan?.model_strategy;
  if (!ms || typeof ms !== "object" || Array.isArray(ms)) {
    return "[plan-write-gate] Blocked: model_strategy is missing or malformed. It must carry `hand_tiers` (the cheap-hand model ladder) plus the 7 Claude eye roles.";
  }
  if (ms.tiers !== undefined) {
    return "[plan-write-gate] Blocked: model_strategy uses the legacy Claude `tiers` shape (e.g. low:haiku / medium:sonnet / high:opus). Cheap hands dispatch to the Ollama endpoint — a Claude model id 404s there. Use `hand_tiers` with model ids that exist in the Ollama endpoint (list with GET /v1/models).";
  }
  if (ms.hand_tiers === undefined) {
    return "[plan-write-gate] Blocked: model_strategy.hand_tiers is required — the executor/sniper resolve their Ollama model from it. Add hand_tiers: { low, medium, high } with real Ollama model ids.";
  }
  return null;
}

/**
 * Pure decision layer — testable without spawning.
 * @param {unknown} payload - The parsed hook payload
 * @returns {{ allow: true }
 *         | { allow: false, hookSpecificOutput: { hookEventName: string, permissionDecision: string, permissionDecisionReason: string } }}
 */
export function decide(payload) {
  // Non-object payload → infra error → fail-open
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { allow: true };
  }

  const filePath = payload?.tool_input?.file_path;

  // Gate-state/triage files under .claude/plans/.state/ are owned by the stamp-triage/entry-gate
  // hooks (fs writes, not tool calls). DENY any tool Write/Edit to them — from the main loop OR a
  // subagent — so a caller can never forge regate_passed/capture_verified/escalation_fallback by
  // overwriting the state file directly (a laundering path stronger than the echo-forgery residual).
  if (isStateFilePath(filePath)) {
    return {
      allow: false,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "[plan-write-gate] Blocked: gate-state/triage files under .claude/plans/.state/ are " +
          "written ONLY by the harness hooks (stamp-triage/entry-gate), never by a Write/Edit tool. " +
          "A direct write could forge the regate/capture/escalation rails. Use the mark.mjs / " +
          "classify.mjs markers, which the hooks observe and stamp authoritatively.",
      },
    };
  }

  // Only gate writes to a feature's execution-plan.json. Everything else passes.
  if (!isExecutionPlanPath(filePath)) {
    return { allow: true };
  }

  // It is a plan write. Allow ONLY the dispatched planner subagent: an own agent_id key
  // (subagent context) AND a normalized role of 'planner'. The main loop (no agent_id) and
  // any other subagent are denied.
  const isSubagent = Object.prototype.hasOwnProperty.call(payload, "agent_id");
  if (isSubagent && bareRole(payload.agent_type) === "planner") {
    // Authorized author — now the CONTENT cancela: reject a legacy/malformed model_strategy
    // before it ever reaches disk, so a Claude-tiers plan can never be executed (the furo).
    const contentReason = checkPlanContent(payload?.tool_input?.content);
    if (contentReason) {
      return {
        allow: false,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: contentReason,
        },
      };
    }
    return { allow: true };
  }

  return {
    allow: false,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        "[plan-write-gate] Blocked: the orchestrator (main loop) must not author or edit the " +
        "execution-plan.json. Plan authorship is planner-only — dispatch the `planner` subagent " +
        "(it runs creating-plans in isolation) to create or revise the plan. If the plan-reviewer " +
        "returned REVISE, re-dispatch the planner in revision mode; do not edit the plan inline.",
    },
  };
}

/**
 * Processes a raw stdin string through the gate.
 * Parse failure → fail-open (exitCode 0, output null).
 * Deny verdict → output is the JSON string to write to stdout.
 * @param {string} rawStr - Raw string from stdin
 * @returns {{ exitCode: 0, output: string|null }}
 */
export function processInput(rawStr) {
  let payload;
  try {
    payload = JSON.parse(rawStr);
  } catch {
    return { exitCode: 0, output: null };
  }

  let verdict;
  try {
    verdict = decide(payload);
  } catch {
    return { exitCode: 0, output: null };
  }

  if (!verdict.allow) {
    return {
      exitCode: 0,
      output: JSON.stringify({ hookSpecificOutput: verdict.hookSpecificOutput }),
    };
  }

  return { exitCode: 0, output: null };
}

// ---------------------------------------------------------------------------
// CLI entry point — guarded so imports from tests do not trigger side effects
// ---------------------------------------------------------------------------

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

  try {
    const result = processInput(raw);
    if (result.output !== null) {
      process.stdout.write(result.output + "\n");
    }
  } catch {
    // Unexpected error — fail-open
  }

  process.exit(0);
}
