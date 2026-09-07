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
import { bareRole, isSafeSessionId, readGateState } from "./lib/gate-lib.mjs";
import {
  formatApprovedLadder,
  formatAllApprovedLadders,
  readActiveHandFamily,
  ladderFor,
  HAND_FAMILY_CONFIG_PATH,
} from "../shared/lib/hand-model-ladder.mjs";

/**
 * @description Hand roles whose subagent writes are constrained to the active dispatch's scope_paths
 * (A3). test-author is NOT scoped — it only authors tests. Only executor/sniper write implementation.
 */
const SCOPE_RAIL_ROLES = new Set(["executor", "sniper"]);

/**
 * @description True iff `normPathLower` (a normalized, lowercased relative path) is INSIDE the scope
 * entry — equal to it, or under it as a directory prefix. A file entry (src/a.ts) matches only by
 * equality; a directory entry (src) matches any path beneath it. Case-insensitive (the operator's
 * platform is), '..'-normalized.
 * @param {string} normPathLower
 * @param {unknown} entry
 * @returns {boolean}
 */
function scopeContains(normPathLower, entry) {
  if (typeof entry !== "string" || entry.length === 0) return false;
  const s = path.posix.normalize(entry.replace(/\\/g, "/")).toLowerCase();
  if (s.length === 0) return false;
  if (normPathLower === s) return true;
  const prefix = s.endsWith("/") ? s : `${s}/`;
  return normPathLower.startsWith(prefix);
}

/**
 * @description The A3 deterministic scope_paths write rail. Returns a DENY verdict when a SUBAGENT
 * write (own agent_id) by an executor/sniper hand targets a path outside the active dispatch's
 * scope_paths AND allowed_writes; otherwise null (allow / rail off). Fail-OPEN on every "unknown
 * scope" condition — non-subagent, non-hand role, missing/unsafe session_id, absent/malformed
 * active_dispatch, a role mismatch, or a non-string file_path — so it never bricks a legit write.
 * @param {object} payload - the PreToolUse Write/Edit payload
 * @param {(sessionId: string) => object} readGateStateFn
 * @returns {null | { allow: false, hookSpecificOutput: object }}
 */
function checkScopeRail(payload, readGateStateFn) {
  // Only a SUBAGENT write (own agent_id) by an executor/sniper hand is scoped.
  if (!Object.prototype.hasOwnProperty.call(payload, "agent_id")) return null;
  const role = bareRole(payload.agent_type);
  if (!SCOPE_RAIL_ROLES.has(role)) return null;

  const sessionId = payload.session_id;
  if (!isSafeSessionId(sessionId)) return null; // missing/unsafe session → fail-open

  let gateState = {};
  try {
    gateState = readGateStateFn(sessionId);
  } catch {
    return null; // fail-open
  }
  const ad = gateState?.active_dispatch;
  if (!ad || typeof ad !== "object" || Array.isArray(ad)) return null; // absent/malformed → fail-open
  if (ad.role !== role) return null; // scope belongs to a different acting role → fail-open

  const scopePaths = Array.isArray(ad.scope_paths) ? ad.scope_paths : null;
  if (scopePaths === null || scopePaths.length === 0) return null; // malformed → fail-open
  const allowedWrites = Array.isArray(ad.allowed_writes) ? ad.allowed_writes : [];

  const filePath = payload?.tool_input?.file_path;
  if (typeof filePath !== "string" || filePath.length === 0) return null; // fail-open

  const normPathLower = path.posix.normalize(filePath.replace(/\\/g, "/")).toLowerCase();
  const inScope = scopePaths.some((s) => scopeContains(normPathLower, s));
  const inAllowed = allowedWrites.some((s) => scopeContains(normPathLower, s));
  if (inScope || inAllowed) return null; // inside scope/allowed → allow

  return {
    allow: false,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        `[plan-write-gate] Blocked: ${role} hand write to '${filePath}' is OUTSIDE its dispatch scope. ` +
        `The active dispatch (${ad.feature_id}/${ad.task_id}) is scoped to: ${scopePaths.join(", ")}` +
        (allowedWrites.length ? ` (plus allowed writes: ${allowedWrites.join(", ")})` : "") +
        ". Stay inside scope_paths, or fold this path into the plan's scope deliberately before writing it.",
    },
  };
}

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
 * The sensitive gate-state basenames. A Write/Edit whose basename is one of these is denied in ANY
 * path (not only under .claude/plans/.state/) — the `.state/` anchor is cwd-relative (stateDirFor is
 * a relative path resolved against process.cwd()), so a homonym written to the worktree cwd or any
 * sibling dir could become the file the gate actually reads and forge every absolution at once. The
 * basename rail closes that; the carve-out (isCarvedOut) exempts test fixtures that never reach the
 * real gate.
 */
const FORBIDDEN_STATE_BASENAMES = new Set(["gate-state.json", "triage.json"]);

/**
 * Splits a file_path into normalized, lowercased, non-empty path segments — the shared primitive
 * for the path/basename checks. Normalizes separators and resolves '.'/'..' first so a traversal
 * variant cannot evade a check. Returns [] for a non-string/empty path.
 * @param {unknown} filePath
 * @returns {string[]}
 */
function pathSegments(filePath) {
  if (typeof filePath !== "string" || filePath.length === 0) {
    return [];
  }
  const norm = path.posix.normalize(filePath.replace(/\\/g, "/"));
  return norm.split("/").filter((s) => s.length > 0).map((s) => s.toLowerCase());
}

/**
 * Carve-out for the state-file rails (#ac-1.2): a homonymous state file that lives under a
 * `__fixtures__/` dir OR whose path carries a `*.test.*` segment is a TEST artifact — it never
 * resolves to the real gate, so gating it would false-block the harness's own test suite. Matches a
 * `__fixtures__` path segment or any segment containing `.test.` (e.g. `foo.test.mjs`,
 * `gate-state.test.json`). Real runtime state paths never carry either token.
 * @param {unknown} filePath
 * @returns {boolean}
 */
function isCarvedOut(filePath) {
  const segs = pathSegments(filePath);
  return segs.some((s) => s === "__fixtures__" || s.includes(".test."));
}

/**
 * Tests whether a file_path's BASENAME is one of the forbidden gate-state basenames, in ANY path.
 * @param {unknown} filePath
 * @returns {boolean}
 */
function isForbiddenStateBasename(filePath) {
  const segs = pathSegments(filePath);
  if (segs.length === 0) {
    return false;
  }
  return FORBIDDEN_STATE_BASENAMES.has(segs[segs.length - 1]);
}

/**
 * Tests whether a file_path resolves to a file under `.claude/hand-config/` — the operator's
 * hand configuration (`hands.json`, which family the authoring rail approves; `test-runner.json`,
 * which command the frozen-test gate runs). Both DECIDE what a gate enforces, so a tool write to
 * either would let the gated party pick its own gate: a hand that can rewrite `hands.json` moves
 * the ladder the plan-write gate validates against, and one that can rewrite `test-runner.json`
 * moves the command that proves its work green. The operator changes these through the CLI
 * (`node .claude/shared/lib/hand-model-ladder.mjs use <family>`), never through Write/Edit.
 * @param {unknown} filePath
 * @returns {boolean}
 */
function isHandConfigPath(filePath) {
  const segs = pathSegments(filePath);
  const i = segs.indexOf(".claude");
  return i !== -1 && segs[i + 1] === "hand-config" && segs.length > i + 2;
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
 * @param {{ readActiveFamily?: () => { family: string } }} [deps] - injectable toggle reader.
 * @returns {string|null} a deny reason, or null when acceptable / not checkable
 */
export function checkPlanContent(content, { readActiveFamily = readActiveHandFamily } = {}) {
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
  // The legacy shape is rejected by SHAPE, never by its values — `haiku`/`sonnet` are legitimate
  // claude-family rungs now, so only the key `tiers` still identifies the retired form.
  if (ms.tiers !== undefined) {
    return "[plan-write-gate] Blocked: model_strategy uses the legacy Claude `tiers` shape (e.g. low:haiku / medium:sonnet / high:opus). Use `hand_tiers`, the only valid hand-routing shape.";
  }
  if (ms.hand_tiers === undefined) {
    return `[plan-write-gate] Blocked: model_strategy.hand_tiers is required — the executor/sniper resolve their hand model from it. Add hand_tiers: { low, medium, high } from an approved ladder (${formatAllApprovedLadders()}).`;
  }
  // #ac-2.1: the VALUES, not just the shape. A tier pinned to an unapproved id (gpt-oss, whose
  // tool-calling collapses in an agentic loop; a retired id; opus) is caught HERE, when the planner
  // writes the plan — not after a whole run has burned on it.
  //
  // EQUALITY with the ACTIVE family's ladder, not mere membership: the claude ladder pins the same
  // id on medium and high, so a membership check would wave through a FLAT `{low: sonnet, medium:
  // sonnet, high: sonnet}` — an escalation ladder with no escalation in it. This is also the ONE
  // place the operator's toggle is read: it decides what a NEW plan may pin, never how a frozen
  // plan dispatches (that follows from the ids the plan already carries).
  let active;
  try {
    active = readActiveFamily();
  } catch (err) {
    return `[plan-write-gate] Blocked: ${err instanceof Error ? err.message : String(err)} Fix ${HAND_FAMILY_CONFIG_PATH} before writing a plan.`;
  }
  const ht = ms.hand_tiers;
  if (!ht || typeof ht !== "object" || Array.isArray(ht)) {
    return `[plan-write-gate] Blocked: model_strategy.hand_tiers must be an object mapping low/medium/high to the active ${active.family} ladder (${formatApprovedLadder(active.family)}).`;
  }
  const ladder = ladderFor(active.family);
  for (const tier of Object.keys(ht)) {
    if (!Object.hasOwn(ladder, tier)) {
      return `[plan-write-gate] Blocked: model_strategy.hand_tiers.${tier} is not a rung — expected exactly low, medium and high.`;
    }
  }
  for (const [tier, model] of Object.entries(ladder)) {
    if (ht[tier] !== model) {
      return `[plan-write-gate] Blocked: model_strategy.hand_tiers.${tier} = ${JSON.stringify(ht[tier])} — the active hand family is ${active.family}, whose ladder is ${formatApprovedLadder(active.family)}. Either pin that ladder, or switch families with \`node .claude/shared/lib/hand-model-ladder.mjs use <family>\` before planning.`;
    }
  }
  return null;
}

/**
 * Pure decision layer — testable without spawning.
 * @param {unknown} payload - The parsed hook payload
 * @returns {{ allow: true }
 *         | { allow: false, hookSpecificOutput: { hookEventName: string, permissionDecision: string, permissionDecisionReason: string } }}
 */
export function decide(payload, deps = {}) {
  const { readGateStateFn = readGateState, readActiveFamilyFn = readActiveHandFamily } = deps;

  // Non-object payload → infra error → fail-open
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { allow: true };
  }

  const filePath = payload?.tool_input?.file_path;

  // Carve-out (#ac-1.2): a __fixtures__/*.test.* homonym is a test artifact that never reaches the
  // real gate — exempt it from BOTH state-file rails below so the harness's own suite is not
  // false-blocked. Real runtime state paths never carry either token.
  const carved = isCarvedOut(filePath);

  // Basename rail (#ac-1.1): DENY a Write/Edit whose BASENAME is a sensitive gate-state file
  // (gate-state.json / triage.json) in ANY path — not only under .claude/plans/.state/. The
  // stateDir anchor is cwd-relative, so a homonym written elsewhere (worktree cwd, a sibling dir)
  // could become the file the gate actually reads and forge every absolution. The path rail below
  // stays as defense-in-depth for other *.json state files under .state/.
  if (!carved && isForbiddenStateBasename(filePath)) {
    return {
      allow: false,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "[plan-write-gate] Blocked: a gate-state/triage file (by basename) is written ONLY by the " +
          "harness hooks (stamp-triage/entry-gate), never by a Write/Edit tool — in ANY path. A direct " +
          "write anywhere could become the file the gate reads (the stateDir is cwd-relative) and forge " +
          "the regate/capture/escalation absolutions. Use the mark.mjs / classify.mjs markers.",
      },
    };
  }

  // Gate-state/triage files under .claude/plans/.state/ are owned by the stamp-triage/entry-gate
  // hooks (fs writes, not tool calls). DENY any tool Write/Edit to them — from the main loop OR a
  // subagent — so a caller can never forge regate_passed/capture_verified/escalation_fallback by
  // overwriting the state file directly (a laundering path stronger than the echo-forgery residual).
  if (!carved && isStateFilePath(filePath)) {
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

  // Hand-config files decide what the gates enforce — never writable by a tool call. Same
  // absolute-security tier as the state-file rails above (not scope-relaxed), and same test
  // carve-out so the harness's own fixtures are never false-blocked.
  if (!carved && isHandConfigPath(filePath)) {
    return {
      allow: false,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "[plan-write-gate] Blocked: .claude/hand-config/ decides which ladder the authoring rail " +
          "approves (hands.json) and which command the frozen-test gate runs (test-runner.json). " +
          "A Write/Edit here would let the gated party choose its own gate. Change the hand family " +
          "with `node .claude/shared/lib/hand-model-ladder.mjs use <family>`.",
      },
    };
  }

  // A3 scope rail: an executor/sniper SUBAGENT write outside its dispatch's scope_paths/allowed_writes
  // is denied. Runs AFTER the state-file rails (those are absolute security, never scope-relaxed) and
  // BEFORE the plan-authorship rail. Fail-open when scope is unknown (see checkScopeRail).
  const scopeDeny = checkScopeRail(payload, readGateStateFn);
  if (scopeDeny) {
    return scopeDeny;
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
    const contentReason = checkPlanContent(payload?.tool_input?.content, { readActiveFamily: readActiveFamilyFn });
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
