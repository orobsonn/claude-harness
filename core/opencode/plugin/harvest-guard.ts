/**
 * @description OC harvest-guard — deny harvester task dispatch when findings.md is not a usable file.
 * Thin plugin shell: pure logic lives in ./lib/harvest-findings.mjs (named exports break OC 1.18 plugin loader).
 */
import type { Plugin } from "@opencode-ai/plugin"

export const harvestGuard: Plugin = async ({ directory, worktree }: any) => {
  if (process.env.OC_HARVEST_GUARD_OFF === "1") return {}
  const { createHarvestGuardHooks, resolveProjectRoot } = await import("./lib/harvest-findings.mjs")
  return createHarvestGuardHooks(resolveProjectRoot(directory, worktree))
}

/** @description OC load contract — default export required; keep this file free of extra named exports. */
export default harvestGuard
