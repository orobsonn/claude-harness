import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { decidePiPolicy, piAuditDir, recordPiPolicyAudit, shouldAuditPiTool } from "../lib/policy.mjs";
import { isChildSession, isPiHeadlessContext, piSessionId } from "../lib/pi-adapter-map.mjs";
import { loadPiGateStateFromDisk } from "../lib/pi-gate-state.mjs";

/** @description Adaptador fino da peça policy: traduz eventos do Pi para a lógica pura de
 * core/pi/lib/policy.mjs. `tool_call` nega antes da execução (nunca `terminate`);
 * `tool_execution_end` grava o recibo imutável de auditoria (fail-open e silencioso) apenas
 * para as tools que a lane Codex audita (hooks.json → "Bash|apply_patch|Agent").
 * O cwd da sessão (ctx.cwd) é repassado à decisão porque o Pi resolve caminho relativo de tool
 * contra ele, não contra o process.cwd() de quem lançou o binário. */
export default function harnessPolicy(pi: ExtensionAPI) {
  pi.on("tool_call", (event: any, ctx: any) => {
    const cwd = typeof ctx?.cwd === "string" && ctx.cwd.length > 0 ? ctx.cwd : process.cwd();
    const loaded = loadPiGateStateFromDisk(cwd, { sessionId: piSessionId(ctx) || null });
    if (!loaded.ok && !["read", "grep", "find", "ls", "get_subagent_result"].includes(event?.toolName)) {
      return { block: true, reason: "Ceremony state cannot be read safely; inspect and repair it before further actions." };
    }
    const decision = decidePiPolicy(
      { toolName: event?.toolName, input: event?.input },
      { cwd, isChild: isChildSession(ctx), isHeadless: isPiHeadlessContext(ctx), gateState: loaded.ok ? loaded.state : {} },
    );
    if (decision.block) return { block: true, reason: decision.reason };
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
