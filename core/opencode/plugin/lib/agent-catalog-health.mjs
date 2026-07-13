/**
 * @description Pure advisory check: expected harness agent files under agents dirs.
 * Fail-open — never throws; returns missing list for operator warning.
 */

import fs from "node:fs";
import path from "node:path";

/** Expected harness agent basenames (no .md) for native task dispatch. */
export const EXPECTED_HARNESS_AGENTS = Object.freeze([
  "build",
  "adversary",
  "adversary-openai",
  "planner",
  "plan-reviewer",
  "plan-reviewer-openai",
  "compliance",
  "security",
  "executor-low",
  "executor-medium",
  "executor-high",
  "sniper-low",
  "sniper-medium",
  "sniper-high",
  "test-author",
  "harvester",
  "shipper",
]);

/**
 * @description Candidate agent directories under project root (vendored + source).
 * @param {string} projectRoot
 * @returns {string[]}
 */
export function agentCatalogDirs(projectRoot) {
  const root =
    typeof projectRoot === "string" && projectRoot.length > 0
      ? projectRoot
      : process.cwd();
  return [
    path.join(root, ".opencode", "agents"),
    path.join(root, "core", "opencode", "agents"),
  ];
}

/**
 * @description List expected agents missing from all candidate dirs.
 * An agent is present if any candidate dir has `<name>.md`.
 * @param {string} [projectRoot]
 * @param {{ existsSync?: typeof fs.existsSync, expected?: readonly string[] }} [deps]
 * @returns {{ ok: true, missing: string[], checkedDirs: string[] }}
 */
export function checkAgentCatalogHealth(projectRoot, deps = {}) {
  try {
    const exists = deps.existsSync ?? fs.existsSync;
    const expected = deps.expected ?? EXPECTED_HARNESS_AGENTS;
    const dirs = agentCatalogDirs(projectRoot);
    const missing = [];
    for (const name of expected) {
      const found = dirs.some((dir) => exists(path.join(dir, `${name}.md`)));
      if (!found) missing.push(name);
    }
    return { ok: true, missing, checkedDirs: dirs };
  } catch {
    return { ok: true, missing: [], checkedDirs: [] };
  }
}

/**
 * @description pt-br advisory message when catalog is incomplete.
 * @param {string[]} missing
 * @returns {string}
 */
export function agentCatalogAdvisoryMessage(missing) {
  const list = Array.isArray(missing) ? missing.filter((m) => typeof m === "string") : [];
  if (list.length === 0) return "";
  return (
    `[harness] Catálogo de agents incompleto (faltam: ${list.join(", ")}). ` +
    `Hands/eyes nativos podem não disparar via task. ` +
    `Reabra a sessão depois de re-vendorizar o harness (.opencode/).`
  );
}
