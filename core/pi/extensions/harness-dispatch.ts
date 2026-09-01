import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { findShadowedCanonicalRoles, validateSubagentDispatch } from "../lib/dispatch-rail.mjs";

/** @description Thin Pi hook that protects the harness subagent contract. */
export default function harnessDispatch(pi: ExtensionAPI) {
  let shadowedRoles = new Set<string>();

  pi.on("session_start", (_event, ctx) => {
    shadowedRoles = findShadowedCanonicalRoles(ctx.cwd, existsSync);
  });

  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "subagent") return;
    shadowedRoles = findShadowedCanonicalRoles(ctx.cwd, existsSync);
    const result = validateSubagentDispatch(event.input, { shadowedRoles });
    if (!result.ok) return { block: true, reason: `harness dispatch blocked: ${result.reason}` };
  });
}
