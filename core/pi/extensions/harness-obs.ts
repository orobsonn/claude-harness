import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  extractTaskIds,
  observePiEyeVerdict,
  observePiHandCompletion,
  observePiPlanWrite,
  observePiTaskExecuting,
  piResultText,
} from "../lib/obs.mjs";
import {
  isPiDispatchTool,
  isPiWriteTool,
  piPathsOf,
  piSessionId,
  piSubagentArgs,
} from "../lib/pi-adapter-map.mjs";

/**
 * @description Adaptador fino dos três observadores da lane Pi (obs-hand, obs-eye,
 * obs-plan-write) numa extensão só — o Pi não tem loader com o bug de export múltiplo do OC,
 * então separar em três arquivos só multiplicaria adaptadores.
 *
 * `tool_execution_end` do Pi NÃO carrega `args` (só toolCallId/toolName/result/isError — ver
 * ToolExecutionEndEvent em dist/core/extensions/types.d.ts), então os args do dispatch e da
 * escrita são memorizados em `tool_execution_start` por toolCallId e consumidos no fim. Só
 * tools observadas entram no mapa, e a entrada é sempre removida no fim.
 *
 * Nenhum hook aqui pode bloquear: `tool_execution_start`/`tool_execution_end` são notificações,
 * e toda decisão vive em core/pi/lib/obs.mjs, que é fail-open por construção.
 */
export default function harnessObs(pi: ExtensionAPI) {
  /** args memorizados do início da tool, por toolCallId (apenas dispatch e write/edit). */
  const pendingArgs = new Map<string, any>();

  pi.on("tool_execution_start", (event: any, ctx: any) => {
    try {
      const observed = isPiDispatchTool(event?.toolName) || isPiWriteTool(event?.toolName);
      if (!observed) return;
      pendingArgs.set(event.toolCallId, event?.args);
      if (!isPiDispatchTool(event?.toolName)) return;
      const ids = extractTaskIds(piSubagentArgs(event?.args));
      observePiTaskExecuting({
        projectRoot: ctx?.cwd,
        sessionId: piSessionId(ctx),
        role: ids.role,
        taskId: ids.taskId,
        featureId: ids.featureId || null,
      });
    } catch {
      /* observação nunca bloqueia */
    }
  });

  pi.on("tool_execution_end", (event: any, ctx: any) => {
    try {
      const args = pendingArgs.get(event?.toolCallId);
      pendingArgs.delete(event?.toolCallId);
      const projectRoot = ctx?.cwd;
      const sessionId = piSessionId(ctx);

      if (isPiDispatchTool(event?.toolName)) {
        const dispatch = piSubagentArgs(args);
        const ids = extractTaskIds(dispatch);
        const outputText = piResultText(event?.result);
        observePiHandCompletion({
          projectRoot,
          sessionId,
          role: ids.role,
          taskId: ids.taskId,
          featureId: ids.featureId || null,
          model: ids.model,
          producerCallId: typeof event?.toolCallId === "string" ? event.toolCallId : "",
          outputText,
          background: dispatch.run_in_background === true,
        });
        observePiEyeVerdict({
          projectRoot,
          sessionId,
          role: ids.role,
          featureId: ids.featureId || null,
          responseText: outputText,
        });
        return;
      }

      if (isPiWriteTool(event?.toolName)) {
        const filePath = piPathsOf(event?.toolName, args)[0] ?? "";
        if (!filePath) return;
        observePiPlanWrite({
          filePath,
          sessionId,
          content: args != null && typeof args === "object" ? (args as any).content : undefined,
        });
      }
    } catch {
      /* observação nunca bloqueia */
    }
  });
}
