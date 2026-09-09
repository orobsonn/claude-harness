import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { decidePiPolicy, isPiReadOnlyReviewerRole, piAuditDir, recordPiPolicyAudit, shouldAuditPiTool } from "../lib/policy.mjs";
import { isPiHeadlessContext, isPiReadTool, piSessionId } from "../lib/pi-adapter-map.mjs";
import { readPiChildIdentity } from "../lib/pi-child-identity.mjs";
import { loadPiGateStateFromDisk } from "../lib/pi-gate-state.mjs";
import { registerPiCommandEvidence } from "../lib/pi-command-evidence.mjs";

const CHILD_READ_IDENTITY_REASON = "Child read tools require an exact valid dispatch identity.";

function parentSessionId(ctx: any) {
  try { return ctx?.sessionManager?.getHeader?.()?.parentSession ?? null; }
  catch { return null; }
}

/** @description Adaptador fino da peça policy: traduz eventos do Pi para a lógica pura de
 * core/pi/lib/policy.mjs. `tool_call` nega antes da execução (nunca `terminate`);
 * `tool_execution_end` grava o recibo imutável de auditoria (fail-open e silencioso) apenas
 * para as tools que a lane Codex audita (hooks.json → "Bash|apply_patch|Agent").
 * O cwd da sessão (ctx.cwd) é repassado à decisão porque o Pi resolve caminho relativo de tool
 * contra ele, não contra o process.cwd() de quem lançou o binário. */
export default function harnessPolicy(pi: ExtensionAPI) {
  registerPiCommandEvidence(pi);
  pi.on("tool_call", (event: any, ctx: any) => {
    const cwd = typeof ctx?.cwd === "string" && ctx.cwd.length > 0 ? ctx.cwd : process.cwd();
    const loaded = loadPiGateStateFromDisk(cwd, { sessionId: piSessionId(ctx) || null });
    if (!loaded.ok && !["read", "grep", "find", "ls", "get_subagent_result"].includes(event?.toolName)) {
      return { block: true, reason: "Ceremony state cannot be read safely; inspect and repair it before further actions." };
    }
    const sessionId = piSessionId(ctx);
    const parentId = parentSessionId(ctx);
    const child = Boolean(parentId);
    const identity: any = child
      ? readPiChildIdentity(cwd, sessionId, { parentSessionId: parentId })
      : null;
    if (child && isPiReadTool(event?.toolName) && !identity?.ok) {
      return { block: true, reason: CHILD_READ_IDENTITY_REASON };
    }
    const reviewerRole = identity?.ok && isPiReadOnlyReviewerRole(identity.record?.role)
      ? identity.record.role
      : null;
    const decision = decidePiPolicy(
      { toolName: event?.toolName, input: event?.input },
      { cwd, projectRoot: cwd, reviewerRole, isChild: child, isHeadless: isPiHeadlessContext(ctx), gateState: loaded.ok ? loaded.state : {} },
    );
    if (decision.block) return { block: true, reason: decision.reason };
    if (decision.inputPatch && event?.input && typeof event.input === "object") {
      Object.assign(event.input, decision.inputPatch);
    }
  });

  pi.on("tool_execution_end", (event: any, ctx: any) => {
    if (!shouldAuditPiTool(event?.toolName)) return;
    const cwd = typeof ctx?.cwd === "string" && ctx.cwd.length > 0 ? ctx.cwd : process.cwd();
    const dir = piAuditDir(cwd);
    if (!dir.ok) return;
    recordPiPolicyAudit({
      sessionId: piSessionId(ctx),
      toolCallId: event?.toolCallId,
      toolName: event?.toolName,
      auditDir: dir.path,
    });
  });
}
