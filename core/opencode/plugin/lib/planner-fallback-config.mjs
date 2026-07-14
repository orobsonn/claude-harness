/** @description Resolve a planner fallback only when routing and agent frontmatter agree on a valid provider/model slug. */

import fs from "node:fs";
import path from "node:path";

export function validProviderModel(value) {
  return typeof value === "string" && /^[^/\s]+\/[^/\s]+$/.test(value);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** @description Return trusted fallback availability plus a persistence-safe diagnostic. */
export function resolvePlannerFallbackConfig(projectRoot) {
  const routing = readJson(path.join(projectRoot, ".opencode", "harness.routing.json"))
    ?? readJson(path.join(projectRoot, "harness.routing.json"));
  const model = routing?.roles?.planner?.fallback?.model;
  if (model == null) return { available: false, model: null, diagnostic: "planner fallback is not configured" };
  if (!validProviderModel(model)) return { available: false, model: null, diagnostic: "planner fallback model must be a non-empty provider/model slug" };
  let agentModel = null;
  try {
    agentModel = fs.readFileSync(path.join(projectRoot, ".opencode", "agents", "planner-fallback.md"), "utf8").match(/^model:\s*(\S+)$/m)?.[1] ?? null;
  } catch {
    // Missing agent is a configuration failure, not provider unavailability.
  }
  if (!validProviderModel(agentModel)) {
    return { available: false, model, diagnostic: "planner-fallback agent has no valid provider/model slug" };
  }
  if (agentModel !== model) {
    return { available: false, model, diagnostic: "planner fallback routing does not match planner-fallback agent model" };
  }
  return { available: true, model, diagnostic: null };
}

export default { resolvePlannerFallbackConfig, validProviderModel };
