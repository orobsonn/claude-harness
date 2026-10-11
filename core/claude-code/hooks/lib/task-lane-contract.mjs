/**
 * @description Pure contract of a Claude Code task lane: roles, dispatch markers, model routes,
 * the Bash/Agent/write policy enforced by the lane gate, and the verdict parsers the host
 * inspection uses. No I/O — the gate and the inspection feed it parsed payloads and Git facts.
 */
import path from "node:path";

import { HAND_LADDERS, agentTypeForRung } from "../../../shared/lib/hand-model-ladder.mjs";
import { taskScopeOf } from "../../../shared/lib/task-contract.mjs";
import { resolveEyeTier } from "../../skills/orchestrating-delivery/references/eye-tier.mjs";
import { claudeTaskScopeShape } from "../../skills/creating-plans/references/validate-plan.mjs";

export { claudeTaskScopeShape };

/** Agents a lane may dispatch. The global parent owns planner, plan-reviewer, harvester, shipper. */
export const LANE_ROLES = Object.freeze(["test-author", "compliance", "adversary", "security",
  "executor", "executor-high", "sniper", "sniper-high"]);
export const PRODUCER_ROLES = Object.freeze(["executor", "executor-high", "sniper", "sniper-high"]);
export const HAND_ROLES = Object.freeze(["test-author", ...PRODUCER_ROLES]);
export const EYE_ROLES = Object.freeze(["compliance", "adversary", "security"]);
/** Markers the lane may stamp, always for its own feature/task only. */
export const LANE_MARKERS = Object.freeze(["fidelity-pass", "hand-finished", "capture-verified",
  "regate-pending", "regate-passed", "active-scope"]);

const CONTEXT_MARKER = /\[HARNESS_TASK_CONTEXT\]([\s\S]*?)\[\/HARNESS_TASK_CONTEXT\]/g;
export const FIDELITY_MARKER = "[HARNESS_TASK_FIDELITY]";
export const FINAL_REVIEW_MARKER = "[HARNESS_FINAL_REVIEW]";

/** The one `[HARNESS_TASK_CONTEXT]{"task_id":…}[/HARNESS_TASK_CONTEXT]` of a dispatch prompt. */
export function parseTaskDispatchMarker(prompt) {
  if (typeof prompt !== "string") return { ok: false, reason: "dispatch prompt required" };
  const matches = [...prompt.matchAll(CONTEXT_MARKER)];
  if (matches.length !== 1) return { ok: false, reason: "dispatch must carry exactly one [HARNESS_TASK_CONTEXT] marker" };
  let parsed;
  try {
    parsed = JSON.parse(matches[0][1]);
  } catch {
    return { ok: false, reason: "[HARNESS_TASK_CONTEXT] must contain JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
      Object.keys(parsed).length !== 1 || typeof parsed.task_id !== "string") {
    return { ok: false, reason: '[HARNESS_TASK_CONTEXT] must be exactly {"task_id":"<task-id>"}' };
  }
  return {
    ok: true,
    taskId: parsed.task_id,
    fidelity: prompt.includes(FIDELITY_MARKER),
    finalReview: prompt.includes(FINAL_REVIEW_MARKER),
  };
}

/** Normalized literal scope of a Claude plan task ("" = whole repository). */
export function laneTaskScope(task) {
  return taskScopeOf(claudeTaskScopeShape(task));
}

/** Locked test files and fixtures (the frozen set) of a Claude plan task. */
export function laneFrozenPaths(task) {
  if (task?.no_tests === true) return [];
  return [...new Set((Array.isArray(task?.locked_tests) ? task.locked_tests : []).flatMap((test) => [
    test?.test_path,
    ...(Array.isArray(test?.fixture_paths) ? test.fixture_paths : []),
  ]).filter((item) => typeof item === "string" && item)
    .map((item) => path.posix.normalize(item).replace(/\/$/, "")))];
}

/** Component-wise containment; the empty scope entry covers the whole repository. */
export function pathInScope(file, scopes) {
  const normalized = path.posix.normalize(String(file).replace(/\\/g, "/")).replace(/^\.\//, "").replace(/\/$/, "");
  return scopes.some((scope) => scope === "" || normalized === scope || normalized.startsWith(`${scope}/`));
}

/** Deterministic sensitive-path allowlist (orchestrating-delivery Phase 1 step 4). */
export function isSensitiveTaskScope(scopes) {
  return scopes.some((entry) => {
    const parts = entry.split("/");
    const base = parts.at(-1) ?? "";
    return parts.some((part) => ["auth", "payment", "payments", "billing", "migrations"].includes(part)) ||
      base.startsWith(".env") || base === "package.json" || base.endsWith(".sql");
  });
}

/**
 * Literal model routes for every lane role, derived only from the frozen plan. Hands use the
 * claude ladder rung for the task (executor) or any rung (sniper: severity is per finding).
 */
export function laneDispatchRoutes(plan, task) {
  const tiers = plan?.model_strategy?.hand_tiers ?? {};
  const claude = HAND_LADDERS.claude;
  if (Object.keys(claude).some((tier) => tiers[tier] !== claude[tier])) {
    throw new Error("parallel task lanes require the claude hand family ladder");
  }
  const rung = (role, tier) => ({ agent: agentTypeForRung(role, tiers[tier], tier), model: tiers[tier], tier });
  const executorTier = task.complexity ?? task.severity;
  if (!["low", "medium", "high"].includes(executorTier)) throw new Error("task complexity/severity tier required");
  const scopes = laneTaskScope(task);
  const ms = plan.model_strategy;
  return {
    "test-author": { agent: "test-author", model: "sonnet" },
    compliance: { agent: "compliance", model: ms.compliance },
    adversary: {
      agent: "adversary",
      model: resolveEyeTier({ severity: task.severity, sensitivePath: isSensitiveTaskScope(scopes) }),
      required: task.adversarial?.enabled === true,
    },
    security: { agent: "security", model: ms.security, required: isSensitiveTaskScope(scopes) },
    executor: rung("executor", executorTier),
    sniper: { rungs: ["low", "medium", "high"].map((tier) => rung("sniper", tier)) },
  };
}

/** Is `{subagent_type, model}` exactly one of the routes for that role? */
export function routeAllows(routes, subagentType, model) {
  if (subagentType === "executor" || subagentType === "executor-high") {
    return routes.executor.agent === subagentType && routes.executor.model === model;
  }
  if (subagentType === "sniper" || subagentType === "sniper-high") {
    return routes.sniper.rungs.some((rung) => rung.agent === subagentType && rung.model === model);
  }
  const route = routes[subagentType];
  return Boolean(route) && route.agent === subagentType && route.model === model;
}

// ---------------------------------------------------------------------------
// Bash policy
// ---------------------------------------------------------------------------

const SHELL_CONTROL = /[;&|`\n\r]|\$\(|>|</;
const HARNESS_STATE_WORDS = /task-admission|task-ledger|task-runs\/|gate-state\.json|triage\.json|plan-review-evidence/;
const HARNESS_RUNTIME_PATHS = /\.claude\/(?:hooks|shared|settings|agents|skills|hand-config)(?:\/|\.|\b)/;

/** `node .claude/hooks/mark.mjs <action> …` as the whole command, parsed; otherwise null. */
export function parseMarkCommand(command) {
  if (typeof command !== "string" || SHELL_CONTROL.test(command)) return null;
  const tokens = command.trim().split(/\s+/);
  if (tokens[0] !== "node" || !/^(?:\.\/)?\.claude\/hooks\/mark\.mjs$/.test(tokens[1] ?? "")) return null;
  const flags = {};
  for (let index = 3; index < tokens.length; index += 2) {
    if (!/^--[a-z-]+$/.test(tokens[index] ?? "") || tokens[index + 1] === undefined) return null;
    flags[tokens[index].slice(2)] = tokens[index + 1];
  }
  return { action: tokens[2], flags };
}

/** A literal standalone ancestry query: `git merge-base [--is-ancestor] A B`. */
export function isIsolatedMergeBase(command) {
  return /^[ \t]*git[ \t]+merge-base(?:[ \t]+[A-Za-z0-9_./@~^:+-]+)+[ \t]*$/.test(command);
}

/** Commands that discard working-tree state; repair preservation applies before them. */
export function isDiscardCommand(command) {
  return /\bgit\s+(?:restore|checkout|reset|clean|stash)\b/.test(command);
}

/**
 * Decide a lane Bash command. `identity` = { featureId, taskId, parentRoot }.
 * @returns {null | string} a deny reason, or null to allow.
 */
export function laneBashDenyReason(command, identity) {
  if (typeof command !== "string") return "command must be a string";
  const mark = /mark\.mjs/.test(command) ? parseMarkCommand(command) : null;
  if (/mark\.mjs/.test(command)) {
    if (!mark) return "run each mark.mjs marker alone: `node .claude/hooks/mark.mjs <action> --feature-id <feature> --task-id <task>`, no chaining or redirection";
    if (!LANE_MARKERS.includes(mark.action)) return `marker ${mark.action} belongs to the global parent; a lane may stamp only ${LANE_MARKERS.join(", ")}`;
    if (mark.flags["feature-id"] !== identity.featureId || mark.flags["task-id"] !== identity.taskId) {
      return `markers must name this lane's own feature and task (--feature-id ${identity.featureId} --task-id ${identity.taskId})`;
    }
    if (mark.flags.sha !== undefined) return "markers take no --sha: the host derives commits from its own evidence";
    return null;
  }
  if (/\btasks\.mjs\b/.test(command)) return "task coordination (tasks.mjs) belongs to the global parent";
  if (/\bclassify\.mjs\b/.test(command)) return "classification is fixed by the global parent";
  if (/\b(?:spawn-hand|dispatch-hand|descriptor-emitter|cross-family)\.mjs\b/.test(command)) {
    return "task lanes dispatch hands as Agents (claude family); the spawn-hand path is not available in a lane";
  }
  if (HARNESS_STATE_WORDS.test(command)) return "harness task state is host-owned; do not read or write it from the lane";
  const planRefs = [...command.matchAll(/\.claude\/plans\/([^\s'"]*)/g)].map((match) => match[1]);
  if (planRefs.some((rest) => !(rest === `${identity.featureId}/run` || rest.startsWith(`${identity.featureId}/run/`)))) {
    return `the canonical plan, spec and harness state are read-only for the lane; use the Read tool, and keep scratch files under .claude/plans/${identity.featureId}/run/`;
  }
  if (identity.parentRoot && command.includes(identity.parentRoot)) {
    return "the global parent worktree is outside this task; work only inside the lane worktree";
  }
  if (HARNESS_RUNTIME_PATHS.test(command)) {
    return "the vendored harness (.claude/hooks, shared, settings, agents, skills) is the lane's runtime; read it with the Read tool and never modify it";
  }
  if (/\bgit\s+commit\b[^\n;&|]*--amend\b/.test(command)) {
    return "Do not amend task commits: this can orphan producer evidence. Create a selective follow-up commit instead.";
  }
  if (/(?:^|[^\w.-])git\s+-/.test(command)) return "git global options (-C, -c, --git-dir, …) are not allowed in a lane";
  if (!isIsolatedMergeBase(command) &&
      /(?:^|[^\w-])git\s+(?:push|pull|fetch|merge|rebase|tag|cherry-pick|worktree|switch)\b/.test(command)) {
    return "task lanes cannot integrate, deliver, change branch or move other worktrees; the host owns merges (only a standalone `git merge-base A B` is allowed)";
  }
  if (/(?:^|[^\w-])git\s+checkout\s+(?:-b\b|-B\b|--orphan\b|[^-\s][^\s]*\s*$)/.test(command) && !/\s--\s/.test(command)) {
    return "task lanes stay on their admitted branch; use `git checkout -- <path>` only to restore files";
  }
  if (/\bgh\s+(?:pr|release|issue)\s+(?:create|merge|edit|close|reopen|comment)\b/.test(command) || /\bgh\s+api\b/.test(command)) {
    return "task lanes cannot open, merge or edit PRs, releases or issues";
  }
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?deploy\b/.test(command) || /\bwrangler\s+(?:deploy|publish)\b/.test(command)) {
    return "task lanes cannot deploy";
  }
  return null;
}

/** Write/Edit target policy. `role` = bare agent_type for subagent writes, null for the lane main loop. */
export function laneWriteDenyReason(relativePath, { role, task, featureId }) {
  if (relativePath === null) return "write target must be inside the task worktree";
  const normalized = path.posix.normalize(relativePath.replace(/\\/g, "/"));
  const runDir = `.claude/plans/${featureId}/run`;
  if (role === null) {
    if (normalized === runDir || normalized.startsWith(`${runDir}/`)) return null;
    return `the lane orchestrator writes only its run buffers under ${runDir}/; product and tests are written by the dispatched hands`;
  }
  if (normalized.startsWith(".claude/")) return "hands never write the vendored harness or its state";
  if (role === "test-author") {
    return pathInScope(normalized, laneFrozenPaths(task)) ? null
      : "test-author writes only this task's locked test paths and fixtures";
  }
  if (PRODUCER_ROLES.includes(role)) {
    return pathInScope(normalized, laneTaskScope(task)) ? null
      : "hands write only inside this task's scope_paths (and allowed writes)";
  }
  return `${role} is read-only in a task lane`;
}

// ---------------------------------------------------------------------------
// Verdicts (host inspection reads these from the native stream, never from the lane's prose)
// ---------------------------------------------------------------------------

function lastJsonBlock(text, predicate) {
  let found = null;
  for (const match of String(text ?? "").matchAll(/```json[^\n]*\n([\s\S]*?)```/g)) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && predicate(parsed)) found = parsed;
    } catch { /* not a report */ }
  }
  return found;
}

/** Reviewer outcome for an eye report: { positive, verdict, blocking } or null when unparseable. */
export function parseEyeVerdict(role, text) {
  if (role === "compliance") {
    const matches = [...String(text ?? "").matchAll(/^#*\s*Veredito:\s*(pass|partial|fail)\b/gim)];
    if (!matches.length) return null;
    const verdict = matches.at(-1)[1].toLowerCase();
    return { verdict, positive: verdict === "pass" };
  }
  if (role === "security") {
    const report = lastJsonBlock(text, (block) => ["SECURE", "UNSAFE"].includes(block.verdict) && Array.isArray(block.issues));
    if (!report) return null;
    return { verdict: report.verdict, positive: report.verdict === "SECURE", issues: report.issues.length };
  }
  if (role === "adversary") {
    const report = lastJsonBlock(text, (block) => Array.isArray(block.issues));
    if (!report) return null;
    const blocking = report.issues.filter((issue) => ["high", "medium"].includes(String(issue?.severity).toLowerCase()) &&
      !/^\s*UNARMED\b/.test(String(issue?.description ?? "")));
    return { verdict: blocking.length ? "BLOCKING" : "CLEAR", positive: blocking.length === 0, blocking: blocking.length };
  }
  return null;
}

/** Hand completion status from its structured block (`## Status: DONE` …). */
export function parseHandStatus(text) {
  const matches = [...String(text ?? "").matchAll(/^#*\s*Status:\s*(DONE_WITH_CONCERNS|DONE|NEEDS_CONTEXT|BLOCKED)\b/gm)];
  return matches.length ? matches.at(-1)[1] : null;
}
