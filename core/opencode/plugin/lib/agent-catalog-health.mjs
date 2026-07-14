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
  "adversary-family-1",
  "adversary-family-2",
  "planner",
  "plan-reviewer",
  "plan-reviewer-openai",
  "plan-reviewer-family-1",
  "plan-reviewer-family-2",
  "compliance",
  "security",
  "executor-low",
  "executor-medium",
  "executor-high",
  "executor-low-spawn",
  "executor-medium-spawn",
  "executor-high-spawn",
  "sniper-low",
  "sniper-medium",
  "sniper-high",
  "sniper-low-spawn",
  "sniper-medium-spawn",
  "sniper-high-spawn",
  "test-author",
  "test-author-spawn",
  "harvester",
  "shipper",
]);

/**
 * @description Authoritative agent directory under project root.
 * @param {string} projectRoot
 * @returns {string[]}
 */
export function agentCatalogDirs(projectRoot, exists = fs.existsSync) {
  const root =
    typeof projectRoot === "string" && projectRoot.length > 0
      ? projectRoot
      : process.cwd();
  const runtimeAgents = path.join(root, ".opencode", "agents");
  // A present runtime catalog is authoritative, including when it is incomplete.
  // Falling back here would hide a partial vendor operation from the operator.
  if (exists(runtimeAgents)) return [runtimeAgents];
  return [path.join(root, "core", "opencode", "agents")];
}

/**
 * @description List expected agents missing from the authoritative catalog.
 * @param {string} [projectRoot]
 * @param {{ existsSync?: typeof fs.existsSync, expected?: readonly string[] }} [deps]
 * @returns {{ ok: true, missing: string[], checkedDirs: string[] }}
 */
export function checkAgentCatalogHealth(projectRoot, deps = {}) {
  try {
    const exists = deps.existsSync ?? fs.existsSync;
    const expected = deps.expected ?? EXPECTED_HARNESS_AGENTS;
    const dirs = agentCatalogDirs(projectRoot, exists);
    const missing = [];
    for (const name of expected) {
      const found = exists(path.join(dirs[0], `${name}.md`));
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
    `Hands/eyes nativos podem não disparar via task. Re-vendorize o harness (.opencode/) e reabra a sessão. ` +
    `Agents já carregados não são atualizados nesta sessão.`
  );
}
