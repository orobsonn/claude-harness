import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { findShadowedCanonicalRoles, validateSubagentDispatch } from "../lib/dispatch-rail.mjs";
import { isDiscussionRole, isSupportRole } from "../lib/roles.mjs";
import { isChildSession, isPiHeadlessContext, piSessionId, piSubagentArgs } from "../lib/pi-adapter-map.mjs";
import { loadPiGateStateFromDisk } from "../lib/pi-gate-state.mjs";
import { decidePiPlanGate } from "../lib/plan-gate.mjs";

function discussionDenied(ctx: any) {
  if (isPiHeadlessContext(ctx)) return "discussion-local-ui-required";
  if (isChildSession(ctx)) return "discussion-parent-required";
  const loaded: any = loadPiGateStateFromDisk(ctx?.cwd, { sessionId: piSessionId(ctx) ?? null });
  if (loaded?.ok !== true) return "discussion-state-unreadable";
  if (loaded?.ok === true && /^(LIGHT|FULL)$/i.test(String(loaded.state?.mode ?? ""))) return "discussion-active-ceremony";
  return null;
}

/** @description Thin Pi hook that protects the harness subagent contract. */
export default function harnessDispatch(pi: ExtensionAPI) {
  let shadowedRoles = new Set<string>();

  pi.on("session_start", (_event, ctx) => {
    shadowedRoles = findShadowedCanonicalRoles(ctx.cwd, existsSync);
  });

  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "subagent") return;
    shadowedRoles = findShadowedCanonicalRoles(ctx.cwd, existsSync);
    const role = piSubagentArgs(event.input).subagent_type;
    if (isSupportRole(role)) {
      const loaded: any = loadPiGateStateFromDisk(ctx.cwd, { sessionId: piSessionId(ctx) });
      if (isChildSession(ctx) || loaded?.ok !== true || loaded.state?.task_run ||
          !/^(LIGHT|FULL)$/i.test(String(loaded.state?.mode ?? ""))) {
        return { block: true, reason: "harness support requires the global LIGHT/FULL parent; no recursive support dispatch" };
      }
    }
    if (role === "harness-test-author") {
      const canonical: any = decidePiPlanGate({ projectRoot: ctx.cwd, sessionId: piSessionId(ctx), toolName: event.toolName, input: event.input });
      if (canonical.block) return { block: true, reason: canonical.reason };
      // Resolve before routing and native execution; all later hooks/records see
      // the same canonical value. Explicit conflicts were rejected above.
      event.input.complexity = canonical.complexity;
    }
    if (isDiscussionRole(role)) {
      const reason = discussionDenied(ctx);
      if (reason) return { block: true, reason: `harness dispatch blocked: ${reason}` };
    }
    const result = validateSubagentDispatch(event.input, { shadowedRoles });
    if (!result.ok) return { block: true, reason: `harness dispatch blocked: ${result.reason}` };
  });
}
