import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  executePiClassify,
  piClassifyChildDenyReason,
} from "../lib/classify.mjs";
import { isChildSession, piSessionId } from "../lib/pi-adapter-map.mjs";

/**
 * @description Adaptador fino da peça classify: registra a tool nativa `classify` no Pi
 * (espelho de core/opencode/tools/classify.ts, que é uma tool nativa do OC) e instala o
 * rail (belt) no `tool_call` que nega classify em sessão filha antes mesmo do execute.
 * Nenhuma decisão vive aqui — tudo em core/pi/lib/classify.mjs.
 *
 * Autoridade: o Pi não tem nome de agente 'build' no principal, então o único sinal
 * confiável de pai vs filho é a presença de `parentSession` no header da sessão
 * (pi-subagents cria filhos in-process e faz bind das mesmas extensões).
 */
export default function harnessClassify(pi: ExtensionAPI) {
  pi.registerTool({
    name: "classify",
    label: "Classify",
    description:
      "Classify the current request into a triage mode and persist session triage state. " +
      "The model passes { mode, feature_id } where mode ∈ { no-ceremony, QUICK, LIGHT, FULL }. " +
      "Returns the stable <directory>/.pi/harness/plans/<feature_id>/execution-plan.json path and " +
      "echoed { mode, feature_id, action } metadata. Classification never creates or changes the plan.",
    parameters: Type.Object({
      mode: Type.String({
        description: "Classification mode: no-ceremony | QUICK | LIGHT | FULL",
      }),
      feature_id: Type.String({
        description:
          "Feature identifier in kebab-case (e.g. user-auth-revamp). Path separators, uppercase, and underscores are rejected.",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return executePiClassify(params, {
        projectRoot: ctx.cwd,
        sessionId: piSessionId(ctx),
        isChild: isChildSession(ctx),
      });
    },
  });

  // Belt: nega a chamada da tool em sessão filha antes do execute, com o texto da lane OC.
  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "classify") return;
    if (!isChildSession(ctx)) return;
    return { block: true, reason: piClassifyChildDenyReason() };
  });
}
