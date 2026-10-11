#!/usr/bin/env node
/**
 * @description Dependency-free validator for execution-plan.json — Claude Harness.
 *
 * This file IS the executable contract. Skills must not assume installed deps
 * (Anthropic best practice), so this validator uses Node builtins only — no zod,
 * no node_modules. Field descriptions live in ../SKILL.md; the rules below are
 * the authoritative gate.
 *
 * Usage:
 *   node validate-plan.mjs <path-to-plan.json>
 *
 * Importable: `validateExecutionPlan(plan)` returns { ok, errors: [{ path, message }] } with the
 * exact rules the CLI applies.
 *
 * Parallel execution (opt-in, `"execution": { "parallel": true }`): tasks that can run together
 * (no depends_on ancestry between them) must have disjoint literal scopes — scope_paths, every
 * locked test_path and fixture_paths — with no globs, no '..', no absolute paths; every task
 * declares depends_on; hands use the claude family ladder (lanes dispatch hands as Agents); a
 * task may declare `"no_tests": true` with `"locked_tests": []` only in a parallel plan. Plans
 * without `execution` are validated exactly as before.
 *
 * Exit codes:
 *   0 — plan is valid (prints "OK")
 *   1 — usage error, unreadable/invalid JSON, or one+ validation errors
 *       (prints each error with its field path)
 */

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { taskScopeOf, taskScopesOverlap } from "../../../../shared/lib/task-contract.mjs";
import { HAND_LADDERS } from "../../../../shared/lib/hand-model-ladder.mjs";

// ---------- Allowed enum values (mirror the documented contract) ----------

// Claude aliases — the only models an EYE role may resolve to. An eye must never
// fall through to a non-Claude (Ollama) model. (Fable 5 was retired; opus is the
// strongest available tier. Add a new Claude model here first to make it routable.)
const CLAUDE_ALIASES = ["haiku", "sonnet", "opus"];
const MODES = ["light", "full"];
const SEVERITIES = ["low", "medium", "high"];
// complexity is the OPTIONAL executor-model axis (reasoning depth), decoupled
// from severity (blast radius / review gating). Absent → dispatch falls back to
// severity. Mirrors TIER_KEYS so tiers[complexity] resolves directly.
const COMPLEXITIES = ["low", "medium", "high"];
const DEMO_TYPES = ["markdown", "smoke", "playwright"];

// task.id must be the SAME kebab-case shape mark.mjs accepts (isSafeFeatureId), so the
// re-gate stamp (mark.mjs regate-pending/passed --task-id <id>) can never silently fail
// on a legit-but-unstampable id (e.g. 'auth_login', 'T1') → no regate_pending → block
// never fires. Over-permissive task.id here is a fail-OPEN of the delivery block.
const TASK_ID_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TASK_ID_MAX_LENGTH = 64;

// Fixed EYE roles in model_strategy — the judging roles. executor/sniper (the
// HANDS) are intentionally absent: they are tier-variable and resolve from the
// active hand tier map — executor from [task.complexity ?? task.severity],
// sniper from [issue.severity] — at dispatch. Every fixed eye role must resolve
// to a Claude alias under BOTH shapes (no eye ever runs on a non-Claude model).
const FIXED_ROLES = [
  "planner",
  "plan-reviewer",
  "compliance",
  "adversary",
  "security",
  "shipper",
  "harvester",
];
const FORBIDDEN_ROLES = ["executor", "sniper"];
const TIER_KEYS = ["low", "medium", "high"];

// ---------- Error collection ----------

/** @description Accumulator that records each failure with a field path. */
class Errors {
  constructor() {
    this.list = [];
  }
  /** @param {string} path Dotted field path. @param {string} message Why it failed. */
  add(path, message) {
    this.list.push({ path, message });
  }
  get empty() {
    return this.list.length === 0;
  }
}

// ---------- Type guards ----------

const isObject = (v) =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isString = (v) => typeof v === "string";
const isBoolean = (v) => typeof v === "boolean";
const isScalar = (v) =>
  typeof v === "string" || typeof v === "number" || typeof v === "boolean";

/**
 * @description Validates that `value` at `path` is a non-empty array of strings.
 * Pushes a precise error otherwise. Returns true when valid.
 */
function checkStringArrayMin1(value, path, errors) {
  if (!Array.isArray(value)) {
    errors.add(path, "must be an array");
    return false;
  }
  if (value.length < 1) {
    errors.add(path, "must have at least 1 item");
    return false;
  }
  let ok = true;
  value.forEach((item, i) => {
    if (!isString(item)) {
      errors.add(`${path}[${i}]`, "must be a string");
      ok = false;
    }
  });
  return ok;
}

/**
 * @description Validates locked_tests: a non-empty array of objects, each with a
 * non-empty `test_path` (the test file the test-author transcribes — frozen; the executor
 * receives it read-only), a non-empty `assertion` (Given/When/Then prose asserting an
 * observable), and an OPTIONAL `fixture_paths` (the enumerated fixture files the test-author
 * may also write, captured in the manifest so the frozen-manifest gate covers them too).
 */
function validateLockedTests(value, path, errors, { noTests = false } = {}) {
  if (!Array.isArray(value)) {
    errors.add(path, "must be an array");
    return;
  }
  if (noTests) {
    if (value.length !== 0) errors.add(path, "must be [] when no_tests is true");
    return;
  }
  if (value.length < 1) {
    errors.add(path, "must have at least 1 item");
    return;
  }
  value.forEach((lt, i) => {
    const p = `${path}[${i}]`;
    if (!isObject(lt)) {
      errors.add(p, "must be an object { test_path, assertion }");
      return;
    }
    if (!isString(lt.test_path) || lt.test_path.length < 1) {
      errors.add(
        `${p}.test_path`,
        "must be a non-empty string — the test file the test-author transcribes (frozen; the executor receives it read-only)"
      );
    }
    if (!isString(lt.assertion) || lt.assertion.length < 1) {
      errors.add(
        `${p}.assertion`,
        "must be a non-empty Given/When/Then string asserting an observable"
      );
    }
    // fixture_paths is OPTIONAL: the enumerated fixtures the test-author writes alongside the
    // frozen test. When present it must be a non-empty array of non-empty strings.
    if (lt.fixture_paths !== undefined) {
      if (!Array.isArray(lt.fixture_paths)) {
        errors.add(`${p}.fixture_paths`, "must be an array of non-empty strings when present");
      } else if (lt.fixture_paths.length < 1) {
        errors.add(`${p}.fixture_paths`, "must have at least 1 item when present");
      } else {
        lt.fixture_paths.forEach((fp, j) => {
          if (!isString(fp) || fp.length < 1) {
            errors.add(`${p}.fixture_paths[${j}]`, "must be a non-empty string");
          }
        });
      }
    }
  });
}

// ---------- model_strategy ----------

/**
 * @description Split-shape HAND tier map: low/medium/high, each a non-empty
 * model id (an Ollama model id is fine — values are NOT constrained to an enum).
 * All three keys are required so the executor/sniper `complexity ?? severity`
 * fallback always resolves within hand_tiers.
 */
function validateHandTiers(handTiers, errors) {
  if (!isObject(handTiers)) {
    errors.add("model_strategy.hand_tiers", "must be an object");
    return;
  }
  for (const key of TIER_KEYS) {
    const v = handTiers[key];
    if (v === undefined) {
      errors.add(`model_strategy.hand_tiers.${key}`, "is required");
    } else if (!isString(v) || v.length < 1) {
      errors.add(
        `model_strategy.hand_tiers.${key}`,
        "must be a non-empty model id string"
      );
    }
  }
}

function validateModelStrategy(ms, errors) {
  if (!isObject(ms)) {
    errors.add("model_strategy", "must be an object");
    return;
  }

  // hand_tiers is the ONLY valid hand-routing shape. The legacy Claude-only
  // `tiers` map is removed: it let the executor/sniper silently resolve to
  // expensive Claude, defeating the cheap-hands default. A Claude hand is still
  // reachable by putting a Claude alias in hand_tiers (values are free model ids).
  if (ms.tiers !== undefined) {
    errors.add(
      "model_strategy.tiers",
      "legacy tiers shape is removed — use hand_tiers (the only valid shape; values are free model ids, a Claude alias is allowed there as an explicit escape)"
    );
  }
  if (ms.hand_tiers === undefined) {
    errors.add(
      "model_strategy.hand_tiers",
      "is required (the only valid hand-routing shape)"
    );
  } else {
    validateHandTiers(ms.hand_tiers, errors);
  }

  // 7 fixed eye roles, each a Claude alias under BOTH shapes — an eye must
  // never resolve to a non-Claude (Ollama) model.
  for (const role of FIXED_ROLES) {
    const v = ms[role];
    if (v === undefined) {
      errors.add(`model_strategy.${role}`, "is a required fixed role");
    } else if (!CLAUDE_ALIASES.includes(v)) {
      errors.add(
        `model_strategy.${role}`,
        `must be a Claude alias (one of ${CLAUDE_ALIASES.join(", ")}) — eyes never resolve to a non-Claude model`
      );
    }
  }

  // executor/sniper must NOT appear as explicit keys under either shape — they
  // are hand roles, resolved from the active tier map at dispatch.
  for (const forbidden of FORBIDDEN_ROLES) {
    if (forbidden in ms) {
      errors.add(
        `model_strategy.${forbidden}`,
        "must not be present (hand role, resolved from the tier map at dispatch)"
      );
    }
  }

  // Unknown-key allowlist: prevents silently ignoring dropped keys (e.g. eye_tiers).
  // FORBIDDEN_ROLES included so they don't double-fire with the loop above.
  const ALLOWED_MS_KEYS = new Set([...FIXED_ROLES, "hand_tiers", ...FORBIDDEN_ROLES]);
  for (const key of Object.keys(ms)) {
    if (!ALLOWED_MS_KEYS.has(key)) {
      errors.add(
        `model_strategy.${key}`,
        `unknown key (eye_tiers was intentionally dropped; eyes resolve from the 7 fixed roles)`
      );
    }
  }
}

// ---------- adversarial ----------

function validateAdversarial(adv, path, errors) {
  if (!isObject(adv)) {
    errors.add(path, "must be an object");
    return;
  }
  if (!isBoolean(adv.enabled)) {
    errors.add(`${path}.enabled`, "must be a boolean");
    return;
  }
  if (adv.enabled === true) {
    // focus required and non-empty only when enabled
    checkStringArrayMin1(adv.focus, `${path}.focus`, errors);
  }
  // Optional: cross_family opts this checkpoint into a second-family (Codex/GPT) adversary run
  // alongside the Claude one. Backward-compatible — absent means "harness default" (on where the
  // codex-adversary module is installed and available; fail-open to Claude-only otherwise).
  if (adv.cross_family !== undefined && !isBoolean(adv.cross_family)) {
    errors.add(`${path}.cross_family`, "must be a boolean when present");
  }
}

// ---------- task ----------

function validateTask(task, index, errors, { parallel = false } = {}) {
  const base = `tasks[${index}]`;
  if (!isObject(task)) {
    errors.add(base, "must be an object");
    return;
  }

  if (!isString(task.id) || task.id.length < 1) {
    errors.add(`${base}.id`, "must be a non-empty string");
  } else if (task.id.length > TASK_ID_MAX_LENGTH || !TASK_ID_REGEX.test(task.id)) {
    errors.add(
      `${base}.id`,
      "must be kebab-case (a-z, 0-9, hyphens only; ≤64 chars) — the same shape mark.mjs accepts so the re-gate stamp never silently fails"
    );
  }
  if (!isString(task.spec) || task.spec.length < 1) {
    errors.add(`${base}.spec`, "must be a non-empty string");
  }
  if (!SEVERITIES.includes(task.severity)) {
    errors.add(`${base}.severity`, `must be one of ${SEVERITIES.join(", ")}`);
  }

  // complexity is optional: absent → executor model falls back to severity.
  if (task.complexity !== undefined && !COMPLEXITIES.includes(task.complexity)) {
    errors.add(`${base}.complexity`, `must be one of ${COMPLEXITIES.join(", ")}`);
  }

  checkStringArrayMin1(task.scope_paths, `${base}.scope_paths`, errors);

  // resolved_judgments: non-empty object of scalar values (no prose-as-object/array)
  if (!isObject(task.resolved_judgments)) {
    errors.add(`${base}.resolved_judgments`, "must be an object");
  } else {
    const keys = Object.keys(task.resolved_judgments);
    if (keys.length === 0) {
      errors.add(`${base}.resolved_judgments`, "must not be empty");
    }
    for (const key of keys) {
      if (!isScalar(task.resolved_judgments[key])) {
        errors.add(
          `${base}.resolved_judgments.${key}`,
          "must be a scalar (string, number, or boolean) — not an object or array"
        );
      }
    }
  }

  // criterion_refs: non-empty array of strings, each matching ^#ac-
  if (checkStringArrayMin1(task.criterion_refs, `${base}.criterion_refs`, errors)) {
    task.criterion_refs.forEach((ref, i) => {
      if (!/^#ac-/.test(ref)) {
        errors.add(`${base}.criterion_refs[${i}]`, 'must start with "#ac-"');
      }
    });
  }

  if (task.no_tests !== undefined) {
    if (!parallel) {
      errors.add(`${base}.no_tests`, 'is only valid in a parallel plan ("execution": {"parallel": true})');
    } else if (task.no_tests !== true) {
      errors.add(`${base}.no_tests`, "must be true when present");
    }
  }
  validateLockedTests(task.locked_tests, `${base}.locked_tests`, errors, {
    noTests: parallel && task.no_tests === true,
  });

  validateAdversarial(task.adversarial, `${base}.adversarial`, errors);

  // depends_on: array of strings (referential integrity checked later, plan-wide)
  if (task.depends_on !== undefined) {
    if (!Array.isArray(task.depends_on)) {
      errors.add(`${base}.depends_on`, "must be an array");
    } else {
      task.depends_on.forEach((dep, i) => {
        if (!isString(dep)) {
          errors.add(`${base}.depends_on[${i}]`, "must be a string");
        }
      });
    }
  }
}

// ---------- plan-wide invariants on depends_on ----------

/**
 * @description Checks depends_on for dangling references and cycles.
 * Skips silently when tasks are malformed (per-task errors already cover that).
 */
function validateDependsOnGraph(tasks, errors) {
  if (!Array.isArray(tasks)) return;

  const ids = new Set();
  for (const t of tasks) {
    if (isObject(t) && isString(t.id)) ids.add(t.id);
  }

  // adjacency: only keep string deps so the DFS below cannot crash
  const adjacency = new Map();
  for (const t of tasks) {
    if (!isObject(t) || !isString(t.id)) continue;
    const deps = Array.isArray(t.depends_on)
      ? t.depends_on.filter(isString)
      : [];
    adjacency.set(t.id, deps);

    for (const dep of deps) {
      if (!ids.has(dep)) {
        errors.add(
          "tasks",
          `task "${t.id}": depends_on references unknown task id "${dep}"`
        );
      }
    }
  }

  // cycle detection via DFS with a recursion stack
  const visited = new Set();

  function hasCycle(node, stack) {
    visited.add(node);
    stack.add(node);
    for (const neighbor of adjacency.get(node) ?? []) {
      if (!adjacency.has(neighbor)) continue; // dangling already reported
      if (!visited.has(neighbor)) {
        if (hasCycle(neighbor, stack)) return true;
      } else if (stack.has(neighbor)) {
        return true;
      }
    }
    stack.delete(node);
    return false;
  }

  for (const id of adjacency.keys()) {
    if (!visited.has(id)) {
      if (hasCycle(id, new Set())) {
        errors.add(
          "tasks",
          `Cycle detected in depends_on graph involving task "${id}"`
        );
        break; // report once, avoid duplicate cycle reports
      }
    }
  }
}

// ---------- parallel execution (opt-in) ----------

/** @description Claude plan task → the shared literal scope (locked_tests use `test_path`). */
export function claudeTaskScopeShape(task) {
  return {
    scope_paths: Array.isArray(task?.scope_paths) ? task.scope_paths : [],
    allowed_writes: Array.isArray(task?.allowed_writes) ? task.allowed_writes : [],
    locked_tests: (Array.isArray(task?.locked_tests) ? task.locked_tests : []).map((lt) => ({
      path: lt?.test_path,
      ...(Array.isArray(lt?.fixture_paths) ? { fixture_paths: lt.fixture_paths } : {}),
    })),
  };
}

/** @description Transitive depends_on ancestors of every task id (malformed edges ignored). */
function ancestorSets(tasks) {
  const deps = new Map(tasks.filter((t) => isObject(t) && isString(t.id))
    .map((t) => [t.id, Array.isArray(t.depends_on) ? t.depends_on.filter(isString) : []]));
  const memo = new Map();
  const visit = (id, stack = new Set()) => {
    if (memo.has(id)) return memo.get(id);
    const out = new Set();
    if (stack.has(id)) return out;
    stack.add(id);
    for (const dep of deps.get(id) ?? []) {
      out.add(dep);
      for (const deeper of visit(dep, stack)) out.add(deeper);
    }
    stack.delete(id);
    memo.set(id, out);
    return out;
  };
  for (const id of deps.keys()) visit(id);
  return memo;
}

function validateExecution(plan, errors) {
  if (plan.execution === undefined) return false;
  if (!isObject(plan.execution)) {
    errors.add("execution", "must be an object");
    return false;
  }
  for (const key of Object.keys(plan.execution)) {
    if (key !== "parallel") errors.add(`execution.${key}`, "unknown key");
  }
  if (!isBoolean(plan.execution.parallel)) {
    errors.add("execution.parallel", "must be a boolean");
    return false;
  }
  return plan.execution.parallel === true;
}

function validateParallelPlan(plan, errors) {
  const handTiers = plan.model_strategy?.hand_tiers;
  const claude = HAND_LADDERS.claude;
  if (isObject(handTiers) && Object.keys(claude).some((tier) => handTiers[tier] !== claude[tier])) {
    errors.add(
      "model_strategy.hand_tiers",
      `parallel task lanes dispatch hands as Agents and require the claude hand family ladder (${JSON.stringify(claude)}); switch with hand-model-ladder.mjs use claude and re-plan`,
    );
  }
  if (!Array.isArray(plan.tasks)) return;
  const scopes = new Map();
  plan.tasks.forEach((task, index) => {
    if (!isObject(task)) return;
    if (!Array.isArray(task.depends_on)) {
      errors.add(`tasks[${index}].depends_on`, "is required in a parallel plan (use [] for none)");
    }
    try {
      taskScopeOf(claudeTaskScopeShape(task));
      if (isString(task.id)) scopes.set(task.id, claudeTaskScopeShape(task));
    } catch (error) {
      errors.add(`tasks[${index}].scope_paths`, error.message);
    }
  });
  const ancestors = ancestorSets(plan.tasks);
  const ids = [...scopes.keys()];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const [a, b] = [ids[i], ids[j]];
      if (ancestors.get(a)?.has(b) || ancestors.get(b)?.has(a)) continue;
      if (taskScopesOverlap(scopes.get(a), scopes.get(b))) {
        errors.add(
          "tasks",
          `tasks "${a}" and "${b}" can run in parallel but their scopes overlap (scope_paths, locked test_path or fixture_paths); make them disjoint or order them with depends_on`,
        );
      }
    }
  }
}

// ---------- final_review / demo ----------

function validateFinalReview(fr, errors) {
  if (!isObject(fr)) {
    errors.add("final_review", "must be an object");
    return;
  }
  if (!isBoolean(fr.compliance)) {
    errors.add("final_review.compliance", "must be a boolean");
  }
  if (!isBoolean(fr.adversary)) {
    errors.add("final_review.adversary", "must be a boolean");
  }
  // security is OPTIONAL (defaults false): planner sets it true when the feature's
  // aggregate scope_paths/tasks hit a security trigger, so the security agent runs
  // feature-wide in the final review (the only security pass LIGHT mode gets).
  if (fr.security !== undefined && !isBoolean(fr.security)) {
    errors.add("final_review.security", "must be a boolean when present");
  }
}

function validateDemo(demo, errors) {
  if (!isObject(demo)) {
    errors.add("demo", "must be an object");
    return;
  }
  if (!DEMO_TYPES.includes(demo.type)) {
    errors.add("demo.type", `must be one of ${DEMO_TYPES.join(", ")}`);
  }
  checkStringArrayMin1(demo.scenarios_from_refs, "demo.scenarios_from_refs", errors);
}

// ---------- root ----------

function validatePlan(plan, errors) {
  if (!isObject(plan)) {
    errors.add("(root)", "plan must be a JSON object");
    return;
  }
  const parallel = validateExecution(plan, errors);

  if (plan.version !== "1.0") {
    errors.add("version", 'must be the literal "1.0"');
  }

  // feature_id: kebab-case slug
  if (!isString(plan.feature_id) || !/^[a-z0-9-]+$/.test(plan.feature_id)) {
    errors.add("feature_id", "must be a kebab-case string (^[a-z0-9-]+$)");
  }

  // created_at: ISO 8601 string. Date.parse accepts ISO with offset or Z.
  if (!isString(plan.created_at) || Number.isNaN(Date.parse(plan.created_at))) {
    errors.add("created_at", "must be an ISO 8601 datetime string");
  }

  if (!MODES.includes(plan.mode)) {
    errors.add("mode", `must be one of ${MODES.join(", ")}`);
  }

  validateModelStrategy(plan.model_strategy, errors);

  if (!Array.isArray(plan.tasks)) {
    errors.add("tasks", "must be an array");
  } else if (plan.tasks.length < 1) {
    errors.add("tasks", "must have at least 1 task");
  } else {
    plan.tasks.forEach((task, i) => validateTask(task, i, errors, { parallel }));
    validateDependsOnGraph(plan.tasks, errors);
  }
  if (parallel) validateParallelPlan(plan, errors);

  validateFinalReview(plan.final_review, errors);
  validateDemo(plan.demo, errors);
}

/**
 * @description Validates a parsed execution plan with the exact rules of the CLI.
 * @param {unknown} plan
 * @returns {{ ok: boolean, errors: Array<{ path: string, message: string }> }}
 */
export function validateExecutionPlan(plan) {
  const errors = new Errors();
  validatePlan(plan, errors);
  return { ok: errors.empty, errors: errors.list };
}

// ---------- main ----------

function isDirectCli() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return process.argv[1] === fileURLToPath(import.meta.url);
  }
}

if (isDirectCli()) {
  const planPath = process.argv[2];
  if (!planPath) {
    process.stderr.write("Usage: node validate-plan.mjs <path-to-plan.json>\n");
    process.exit(1);
  }

  let raw;
  try {
    raw = readFileSync(planPath, "utf8");
  } catch (err) {
    process.stderr.write(
      `[validate-plan] Cannot read file: ${planPath}\n${err.message}\n`
    );
    process.exit(1);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`[validate-plan] Invalid JSON: ${err.message}\n`);
    process.exit(1);
  }

  const errors = new Errors();
  validatePlan(data, errors);

  if (errors.empty) {
    process.stdout.write("OK\n");
    process.exit(0);
  } else {
    process.stderr.write("[validate-plan] INVALID — errors:\n");
    for (const { path, message } of errors.list) {
      process.stderr.write(`  [${path}] ${message}\n`);
    }
    process.exit(1);
  }
}
