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
 * Exit codes:
 *   0 — plan is valid (prints "OK")
 *   1 — usage error, unreadable/invalid JSON, or one+ validation errors
 *       (prints each error with its field path)
 */

import { readFileSync } from "node:fs";

// ---------- Allowed enum values (mirror the documented contract) ----------

const TIERS = ["haiku", "sonnet", "opus"];
const MODES = ["light", "full"];
const SEVERITIES = ["low", "medium", "high"];
// complexity is the OPTIONAL executor-model axis (reasoning depth), decoupled
// from severity (blast radius / review gating). Absent → dispatch falls back to
// severity. Mirrors TIER_KEYS so tiers[complexity] resolves directly.
const COMPLEXITIES = ["low", "medium", "high"];
const DEMO_TYPES = ["markdown", "smoke", "playwright"];

// Fixed roles in model_strategy. executor/sniper are intentionally absent:
// they are tier-variable — executor resolves from tiers[task.complexity ?? task.severity],
// sniper from tiers[issue.severity], at dispatch.
const FIXED_ROLES = [
  "planner",
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

// ---------- model_strategy ----------

function validateModelStrategy(ms, errors) {
  if (!isObject(ms)) {
    errors.add("model_strategy", "must be an object");
    return;
  }

  // tiers: object with low/medium/high, each a valid tier alias
  if (!isObject(ms.tiers)) {
    errors.add("model_strategy.tiers", "must be an object");
  } else {
    for (const key of TIER_KEYS) {
      const v = ms.tiers[key];
      if (v === undefined) {
        errors.add(`model_strategy.tiers.${key}`, "is required");
      } else if (!TIERS.includes(v)) {
        errors.add(
          `model_strategy.tiers.${key}`,
          `must be one of ${TIERS.join(", ")}`
        );
      }
    }
  }

  // 6 fixed roles, each a valid tier alias
  for (const role of FIXED_ROLES) {
    const v = ms[role];
    if (v === undefined) {
      errors.add(`model_strategy.${role}`, "is a required fixed role");
    } else if (!TIERS.includes(v)) {
      errors.add(
        `model_strategy.${role}`,
        `must be one of ${TIERS.join(", ")}`
      );
    }
  }

  // executor/sniper must NOT appear — they are tier-variable, not fixed roles
  for (const forbidden of FORBIDDEN_ROLES) {
    if (forbidden in ms) {
      errors.add(
        `model_strategy.${forbidden}`,
        "must not be present (tier-variable role, resolved from tiers[severity])"
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
}

// ---------- task ----------

function validateTask(task, index, errors) {
  const base = `tasks[${index}]`;
  if (!isObject(task)) {
    errors.add(base, "must be an object");
    return;
  }

  if (!isString(task.id) || task.id.length < 1) {
    errors.add(`${base}.id`, "must be a non-empty string");
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

  checkStringArrayMin1(task.locked_tests, `${base}.locked_tests`, errors);

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
    plan.tasks.forEach((task, i) => validateTask(task, i, errors));
    validateDependsOnGraph(plan.tasks, errors);
  }

  validateFinalReview(plan.final_review, errors);
  validateDemo(plan.demo, errors);
}

// ---------- main ----------

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
