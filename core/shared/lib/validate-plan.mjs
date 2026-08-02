/** @description Pure validate-plan module — never throws; returns ValidationResult. Ported per 03 contract. Reuses isSafeFeatureId. Single source for OC + CC. Canonical locked_tests shape: {id, path, assertion, fixture_paths?}. Complexity allowlist: low|medium|high|max. Optional per-task audit marker: resolved_judgments_model_resolved (array of that task's resolved_judgments keys) — OpenCode lane only; the claude-code copy under skills/creating-plans/references does not implement it. */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isSafeFeatureId } from "./feature-id.mjs";
import { APPROVED_HAND_LADDER } from "./hand-model-ladder.mjs";
import { validateRouting } from "./routing-validate.mjs";
import { isCompleteExpectedModelStrategy, projectExpectedModelStrategy } from "./model-strategy-projection.mjs";

/** Shell metacharacters / control chars — free-form shell text is never a locked_tests.command. */
const SHELL_META = /[;&|`$(){}<>\n\r\0]/;

/** Task + plan complexity bands (max maps to executor-high at dispatch). */
const COMPLEXITY_BANDS = ["low", "medium", "high", "max"];
const MODEL_STRATEGY_EYE_KEYS = Object.freeze([
  "planner",
  "plan-reviewer",
  "compliance",
  "adversary",
  "security",
  "shipper",
  "harvester",
]);
const MODEL_STRATEGY_KEYS = new Set(["hand_tiers", ...MODEL_STRATEGY_EYE_KEYS, "fallback"]);

/**
 * @description Validates the frozen R15 strategy shape. This deliberately does not interpret
 * `fallback`: it is recorded plan data, not an executable route.
 * @param {unknown} strategy
 * @param {unknown} expectedStrategy
 * @param {string[]} errors
 */
function validateModelStrategy(strategy, expectedStrategy, errors, expectedSupplied = false) {
  if (!strategy || typeof strategy !== "object" || Array.isArray(strategy)) {
    errors.push("model_strategy must be an object for a full plan");
    return;
  }
  const value = /** @type {Record<string, unknown>} */ (strategy);
  const hasCompleteExpectedStrategy = expectedSupplied && isCompleteExpectedModelStrategy(expectedStrategy);
  if (expectedSupplied && !hasCompleteExpectedStrategy) {
    errors.push("expectedModelStrategy must be a complete authoritative projection");
  }
  const approvedHands = hasCompleteExpectedStrategy
    ? /** @type {Record<string, unknown>} */ (expectedStrategy).hand_tiers
    : APPROVED_HAND_LADDER;
  for (const key of Object.keys(value)) {
    if (!MODEL_STRATEGY_KEYS.has(key)) errors.push(`model_strategy.${key} is not allowed`);
  }
  const handTiers = value.hand_tiers;
  if (!handTiers || typeof handTiers !== "object" || Array.isArray(handTiers)) {
    errors.push("model_strategy.hand_tiers must be an object with low, medium, high");
  } else {
    const tiers = /** @type {Record<string, unknown>} */ (handTiers);
    for (const key of Object.keys(tiers)) {
      if (!Object.hasOwn(approvedHands, key)) errors.push(`model_strategy.hand_tiers.${key} is not allowed`);
    }
    for (const [key, model] of Object.entries(approvedHands)) {
      if (!Object.hasOwn(tiers, key) || tiers[key] !== model) errors.push(`model_strategy.hand_tiers.${key} must equal ${model}`);
    }
  }
  for (const key of MODEL_STRATEGY_EYE_KEYS) {
    if (typeof value[key] !== "string" || value[key].trim().length === 0) {
      errors.push(`model_strategy.${key} must be a non-empty string`);
    }
  }

  if (hasCompleteExpectedStrategy) {
    const expected = /** @type {Record<string, unknown>} */ (expectedStrategy);
    for (const key of MODEL_STRATEGY_EYE_KEYS) {
      if (typeof expected[key] !== "string" || expected[key].trim().length === 0) {
        errors.push(`expectedModelStrategy.${key} must be a non-empty string`);
      } else if (value[key] !== expected[key]) {
        errors.push(`model_strategy.${key} does not match expectedModelStrategy`);
      }
    }
  }
}

/** @description First-existing runtime routing projection for the standalone CLI. */
function runtimeExpectedModelStrategy(root) {
  const vendored = resolve(root, ".opencode", "harness.routing.json");
  const selected = existsSync(vendored) ? vendored : resolve(root, "harness.routing.json");
  if (!existsSync(selected)) return {};
  try {
    const routing = JSON.parse(readFileSync(selected, "utf8"));
    const valid = validateRouting(routing);
    if (!valid.ok) return { error: `selected routing invalid: ${valid.reason}` };
    const projected = projectExpectedModelStrategy(routing);
    return projected.ok ? { expectedModelStrategy: projected.strategy } : { error: projected.reason };
  } catch (error) {
    return { error: `selected routing unreadable: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * @description Repo-relative path hygiene: no absolute, no drive letter, no `..`.
 * @param {string} p
 * @returns {boolean}
 */
function isRepoRelativePath(p) {
  return typeof p === "string" && p.length > 0 && !p.startsWith("/") && !p.includes("..") && !/^[A-Za-z]:/.test(p);
}

/**
 * @description Test-file path allowlist (extension or tests/__tests__ dir segment).
 * @param {string} p
 * @returns {boolean}
 */
function isAllowedTestPath(p) {
  return (
    /\.(test|spec)\.(ts|js|mjs|cjs)$/.test(p) ||
    p.includes("/tests/") ||
    p.includes("/__tests__/")
  );
}

/**
 * @description Tokenize a command string into argv-like tokens (whitespace split).
 * Quotes are not expanded; presence of shell metacharacters is rejected before tokenize.
 * @param {string} command
 * @returns {string[]}
 */
function tokenizeArgv(command) {
  return command.trim().split(/\s+/).filter(Boolean);
}

/**
 * @description Allowlisted locked_tests.command forms only (argv shape, not free shell).
 * Documented runners: `node --test …`, `vitest`/`jest`/`mocha` […],
 * `npx [--no-install] vitest|jest|mocha …`, `npm|pnpm|yarn test` / `run test`,
 * `pnpm exec vitest|jest`, `bun test …`. Rejects any other executable/shape
 * (e.g. `rm -rf core/shared` has no metacharacters but is not a runner).
 * @param {string} command
 * @returns {boolean}
 */
function isAllowlistedLockedTestCommand(command) {
  if (typeof command !== "string" || command.length === 0) return false;
  if (SHELL_META.test(command)) return false;
  const tokens = tokenizeArgv(command);
  if (tokens.length === 0) return false;
  const head = tokens[0];

  // node --test <path…>  (also accept path-qualified node binary)
  if (head === "node" || /(?:^|\/)node$/.test(head)) {
    return tokens.some((t) => t === "--test" || t.startsWith("--test="));
  }

  // direct runners
  if (head === "vitest" || head === "jest" || head === "mocha") return true;

  // npx [--no-install|-y|--yes] <runner> …
  if (head === "npx") {
    let i = 1;
    while (i < tokens.length && (tokens[i] === "--no-install" || tokens[i] === "-y" || tokens[i] === "--yes")) {
      i++;
    }
    const pkg = tokens[i];
    return pkg === "vitest" || pkg === "jest" || pkg === "mocha";
  }

  // npm test | npm run test | npm run-script test  [ -- … ]
  if (head === "npm") {
    if (tokens[1] === "test") return true;
    if ((tokens[1] === "run" || tokens[1] === "run-script") && tokens[2] === "test") return true;
    return false;
  }

  // pnpm test | pnpm run test | pnpm exec vitest|jest
  if (head === "pnpm") {
    if (tokens[1] === "test") return true;
    if (tokens[1] === "run" && tokens[2] === "test") return true;
    if (tokens[1] === "exec" && (tokens[2] === "vitest" || tokens[2] === "jest" || tokens[2] === "mocha")) {
      return true;
    }
    return false;
  }

  // yarn test | yarn run test
  if (head === "yarn") {
    if (tokens[1] === "test") return true;
    if (tokens[1] === "run" && tokens[2] === "test") return true;
    return false;
  }

  // bun test …
  if (head === "bun") {
    return tokens[1] === "test";
  }

  return false;
}

/**
 * @param {unknown} plan
 * @param {{ expect?: "stub"|"full"|"any", expectedModelStrategy?: unknown }} [opts]
 * @returns {{ ok: boolean; errors: string[] }}
 */
export function validatePlan(plan, opts = {}) {
  const errors = [];
  // Coerce malformed opts (null / non-object) — never throw on opts.expect access
  const safeOpts =
    opts && typeof opts === "object" && !Array.isArray(opts) ? opts : {};
  const expect = safeOpts.expect ?? "any";

  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) {
    errors.push("plan must be a non-null object");
    return { ok: false, errors };
  }

  const p = /** @type {any} */ (plan);

  // feature_id
  if (typeof p.feature_id !== "string" || !isSafeFeatureId(p.feature_id)) {
    errors.push("feature_id must be safe kebab-case string");
  }

  // kind / mode detection
  const hasKind = typeof p.kind === "string";
  const kind = hasKind ? p.kind : (Array.isArray(p.tasks) && p.tasks.length > 0 ? "full" : "stub");

  const mode = typeof p.mode === "string" ? p.mode.toLowerCase() : "";
  const isStubMode = ["no-ceremony", "quick", "light", "full"].includes(mode); // triage modes upper in stub

  let effectiveKind = kind;
  if (!hasKind) {
    if (isStubMode && (!Array.isArray(p.tasks) || p.tasks.length === 0)) effectiveKind = "stub";
    else if (Array.isArray(p.tasks) && p.tasks.length > 0) effectiveKind = "full";
  }

  // explicit mode validation per spec
  if (effectiveKind === "full") {
    if (!["light","full"].includes(mode)) errors.push("mode must be light|full for full plan");
  } else if (effectiveKind === "stub") {
    if (!["no-ceremony","quick","light","full"].includes(mode)) errors.push("mode must be no-ceremony|quick|light|full for stub plan");
  }

  if (expect === "stub" && effectiveKind !== "stub") {
    errors.push("expect stub but plan is not stub");
  }
  if (expect === "full" && effectiveKind !== "full") {
    errors.push("expect full but plan is not full");
  }

  if (effectiveKind === "full" && (!Array.isArray(p.tasks) || p.tasks.length === 0)) {
    errors.push("full plan must have non-empty tasks");
  }
  if (effectiveKind === "stub" && expect === "full") {
    errors.push("stub plan invalid under expect full");
  }

  // tasks checks (only if present)
  if (Array.isArray(p.tasks)) {
    const taskIds = new Set();
    for (const [idx, task] of p.tasks.entries()) {
      if (!task || typeof task !== "object") {
        errors.push(`task[${idx}] must be object`);
        continue;
      }
      const t = /** @type {any} */ (task);
      if (typeof t.id !== "string" || !t.id) errors.push(`task[${idx}].id required`);
      else if (!isSafeFeatureId(t.id)) errors.push(`task[${idx}].id must be safe kebab-case`);
      else if (taskIds.has(t.id)) errors.push(`task[${idx}].id duplicate`);
      else taskIds.add(t.id);

      if (!["low", "medium", "high"].includes(t.severity)) errors.push(`task[${idx}].severity must be low|medium|high`);
      if (t.complexity && !COMPLEXITY_BANDS.includes(t.complexity)) {
        errors.push(`task[${idx}].complexity must be low|medium|high|max`);
      }

      if (!Array.isArray(t.scope_paths)) errors.push(`task[${idx}].scope_paths must be array`);
      else if (expect === "full" && t.scope_paths.length === 0) {
        errors.push(`task[${idx}].scope_paths must be non-empty under expect full`);
      }
      if (!Array.isArray(t.criterion_refs)) errors.push(`task[${idx}].criterion_refs must be array`);

      // locked_tests — canonical shape {id, path, assertion, fixture_paths?}
      if (!("locked_tests" in t)) {
        errors.push(`task[${idx}].locked_tests key required (even if empty)`);
      } else if (t.locked_tests === null || !Array.isArray(t.locked_tests)) {
        errors.push(`task[${idx}].locked_tests must be array (not null)`);
      } else {
        const isDocs = t.kind === "docs";
        const noTests = t.no_tests === true;
        if (!isDocs && !noTests && t.locked_tests.length < 1) {
          errors.push(`task[${idx}].locked_tests must have min length 1 unless docs or no_tests:true`);
        }
        if (noTests && t.locked_tests.length !== 0) {
          errors.push(`task[${idx}] no_tests:true requires locked_tests:[]`);
        }
        for (const [ltIdx, lt] of t.locked_tests.entries()) {
          if (!lt || typeof lt !== "object") {
            errors.push(`task[${idx}].locked_tests[${ltIdx}] must be object`);
            continue;
          }
          const ltBase = `task[${idx}].locked_tests[${ltIdx}]`;
          if (typeof lt.id !== "string" || !lt.id) errors.push(`${ltBase}.id required`);

          // Legacy alias: test_path without path fails loudly (do not silent-accept)
          if (typeof lt.path !== "string") {
            if (typeof lt.test_path === "string") {
              errors.push(
                `${ltBase}.path required — use "path" (not legacy "test_path"); canonical shape is {id, path, assertion, fixture_paths?}`
              );
            } else {
              errors.push(`${ltBase}.path required`);
            }
          } else if (!isRepoRelativePath(lt.path)) {
            errors.push(`${ltBase}.path must be repo-relative, no .. or absolute`);
          } else if (!isAllowedTestPath(lt.path)) {
            errors.push(`${ltBase}.path must be allowed test file or tests directory`);
          }

          if (typeof lt.assertion !== "string" || lt.assertion.trim().length === 0) {
            errors.push(`${ltBase}.assertion required (non-empty Given/When/Then string)`);
          }

          if (lt.fixture_paths !== undefined) {
            if (!Array.isArray(lt.fixture_paths)) {
              errors.push(`${ltBase}.fixture_paths must be an array of repo-relative strings when present`);
            } else {
              for (const [fpIdx, fp] of lt.fixture_paths.entries()) {
                if (typeof fp !== "string" || !fp) {
                  errors.push(`${ltBase}.fixture_paths[${fpIdx}] must be a non-empty string`);
                } else if (!isRepoRelativePath(fp)) {
                  errors.push(`${ltBase}.fixture_paths[${fpIdx}] must be repo-relative, no .. or absolute`);
                }
              }
            }
          }

          if (typeof lt.command === "string") {
            // allowlisted runner argv only — metachar denylist alone lets `rm -rf …` through
            if (!isAllowlistedLockedTestCommand(lt.command)) {
              errors.push(
                `${ltBase}.command must be an allowlisted runner argv form (node --test, vitest/jest/mocha, npm/pnpm/yarn/bun test, npx vitest|jest|mocha)`
              );
            }
          }
        }
      }

      // resolved_judgments_model_resolved — OPTIONAL audit marker: which of THIS task's
      // resolved_judgments the engine decided on its own (headless, no operator input).
      // Absent or [] is always valid — no existing plan may break on it.
      if (t.resolved_judgments_model_resolved !== undefined) {
        const mrBase = `task[${idx}].resolved_judgments_model_resolved`;
        const marked = t.resolved_judgments_model_resolved;
        if (!Array.isArray(marked)) {
          errors.push(`${mrBase} must be an array of resolved_judgments keys when present`);
        } else {
          const rj =
            t.resolved_judgments && typeof t.resolved_judgments === "object" && !Array.isArray(t.resolved_judgments)
              ? t.resolved_judgments
              : null;
          for (const [mrIdx, key] of marked.entries()) {
            if (typeof key !== "string" || key.trim().length === 0) {
              errors.push(`${mrBase}[${mrIdx}] must be a non-empty string`);
            } else if (!rj || !Object.prototype.hasOwnProperty.call(rj, key)) {
              errors.push(`${mrBase} orphan key: ${key} — not a key of task[${idx}].resolved_judgments`);
            }
          }
        }
      }

      if (Array.isArray(t.depends_on)) {
        for (const dep of t.depends_on) {
          if (typeof dep !== "string") errors.push(`task[${idx}].depends_on must be string ids`);
        }
      }
    }

    // dangling depends_on (ghost task ids) — after all ids collected
    for (const [idx, task] of p.tasks.entries()) {
      if (!task || typeof task !== "object") continue;
      const t = /** @type {any} */ (task);
      if (!Array.isArray(t.depends_on)) continue;
      for (const dep of t.depends_on) {
        if (typeof dep === "string" && dep && !taskIds.has(dep)) {
          errors.push(`task[${idx}].depends_on dangling ref: ${dep}`);
        }
      }
    }

    // acyclic depends_on (simple check)
    // build graph and detect cycle (DFS basic)
    const graph = new Map();
    for (const t of p.tasks) {
      if (t && t.id) graph.set(t.id, Array.isArray(t.depends_on) ? t.depends_on.filter(d => typeof d === "string") : []);
    }
    const visiting = new Set();
    const visited = new Set();
    function hasCycle(node) {
      if (visiting.has(node)) return true;
      if (visited.has(node)) return false;
      visiting.add(node);
      const deps = graph.get(node) || [];
      for (const d of deps) {
        if (hasCycle(d)) return true;
      }
      visiting.delete(node);
      visited.add(node);
      return false;
    }
    for (const id of graph.keys()) {
      if (hasCycle(id)) {
        errors.push("depends_on contains cycle");
        break;
      }
    }
  }

  // severity / complexity tiers
  if (p.severity && !["low", "medium", "high", "critical"].includes(p.severity)) {
    errors.push("severity must be low|medium|high|critical");
  }
  if (p.complexity && !COMPLEXITY_BANDS.includes(p.complexity)) {
    errors.push("complexity must be low|medium|high|max");
  }

  // R15: every effective full plan has one complete, frozen strategy. Stub plans do not.
  if (effectiveKind === "full") {
    validateModelStrategy(p.model_strategy, safeOpts.expectedModelStrategy, errors, Object.hasOwn(safeOpts, "expectedModelStrategy"));
  }

  // demo shape optional
  if (p.demo && typeof p.demo !== "object") errors.push("demo must be object if present");

  return { ok: errors.length === 0, errors };
}

/**
 * @description Minimal CLI when run as main: `node core/shared/lib/validate-plan.mjs <path-to-plan.json>`.
 * Exit 0 = OK; exit 1 = usage / read / JSON / validation errors.
 */
const isMain =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("validate-plan.mjs") || process.argv[1].endsWith("validate-plan"));

if (isMain) {
  const planPath = process.argv[2];
  if (!planPath) {
    process.stderr.write("Usage: node validate-plan.mjs <path-to-plan.json>\n");
    process.exit(1);
  }
  let raw;
  try {
    raw = readFileSync(resolve(planPath), "utf8");
  } catch (err) {
    process.stderr.write(
      `[validate-plan] Cannot read file: ${planPath}\n${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exit(1);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(
      `[validate-plan] Invalid JSON: ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exit(1);
  }
  const runtimeRouting = runtimeExpectedModelStrategy(process.cwd());
  if (runtimeRouting.error) {
    process.stderr.write(`[validate-plan] INVALID — ${runtimeRouting.error}\n`);
    process.exit(1);
  }
  const result = validatePlan(data, runtimeRouting.expectedModelStrategy
    ? { expect: "full", expectedModelStrategy: runtimeRouting.expectedModelStrategy }
    : { expect: "full" });
  if (result.ok) {
    process.stdout.write("OK\n");
    process.exit(0);
  }
  process.stderr.write("[validate-plan] INVALID — errors:\n");
  for (const e of result.errors) process.stderr.write(`  - ${e}\n`);
  process.exit(1);
}
