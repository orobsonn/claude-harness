import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

import { installNativeHarnessAgents } from "../lib/native-bootstrap.mjs";

/**
 * The launcher materializes package defaults in PI_CODING_AGENT_DIR before Pi
 * starts. Do not redirect it here: Pi writes its normal local state there.
 */
function isChildSession(ctx: ExtensionContext): boolean {
  try {
    return Boolean(ctx.sessionManager.getHeader()?.parentSession);
  } catch {
    return true;
  }
}

export default function harnessBootstrap(pi: ExtensionAPI) {
  // O launcher já materializou sua árvore privada. Nesta condição não podemos tocar no estado
  // nativo/global, nem mesmo para "atualizar" arquivos que o launcher controla.
  if (process.env.PI_HARNESS_LAUNCHER === "1") return;

  const installed = installNativeHarnessAgents({ agentDir: getAgentDir() });
  if (!installed.ok) {
    const reason = `[harness-bootstrap] Blocked: native role bootstrap failed (${installed.reason}). Resolve the collision or asset error, then restart Pi.`;
    let reported = false;
    const report = () => {
      if (reported) return;
      reported = true;
      console.error(reason);
    };
    pi.on("before_agent_start", (_event, ctx) => {
      report();
      // `before_agent_start` has no block result and no active Pi run yet. The companion
      // `agent_start` handler below aborts at the first lifecycle point where activeRun exists.
      return { message: { customType: "harness-bootstrap-error", content: reason, display: true } };
    });
    pi.on("agent_start", (_event, ctx) => {
      try {
        ctx.abort();
      } catch {
        // The tool-call block below still prevents any action if a malformed host context cannot abort.
      }
    });
    pi.on("tool_call", () => ({ block: true, terminate: true, reason }));
    return;
  }

  pi.on("before_agent_start", (event: any, ctx) => {
    if (isChildSession(ctx) || typeof event?.systemPrompt !== "string") return;
    return { systemPrompt: `${event.systemPrompt}\n\n${installed.runtimePrompt}` };
  });
}
