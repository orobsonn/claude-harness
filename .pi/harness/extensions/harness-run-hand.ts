import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { piSessionId } from "../lib/pi-adapter-map.mjs";
import { createPiRunHandTool, RUN_HAND_TOOL_NAME } from "../lib/run-hand.mjs";

const RunHandParams = Type.Object({
  descriptor: Type.String({
    description:
      "Path to the hand descriptor JSON (same shape the OC lane passes to --descriptor): feature_id, task_id, freeze_commit_sha, role, model (openai-codex/*), brief, no_tests, frozen_paths, locked_test.",
  }),
});

/** @description Adaptador fino da peça run-hand: traduz eventos do Pi para a lógica pura de
 * core/pi/lib/run-hand.mjs. `tool_call` autoriza a chamada nativa de `run_hand` antes da execução
 * (deny vira {block:true,reason}, fail-CLOSED em descriptor ilegível); a tool registrada consome
 * essa autorização exatamente uma vez. Nenhuma decisão vive aqui — o adaptador só traduz. */
export default function harnessRunHand(pi: ExtensionAPI) {
  let authority: ReturnType<typeof createPiRunHandTool> | undefined;
  let authorityRoot = "";

  // Uma autoridade por raiz de projeto. Trocar de raiz descarta autorizações pendentes
  // (fail-closed: a chamada seguinte cai em 'run_hand authorization missing…').
  const authorityFor = (ctx: ExtensionContext) => {
    const projectRoot = ctx.cwd;
    if (!authority || authorityRoot !== projectRoot) {
      authorityRoot = projectRoot;
      authority = createPiRunHandTool({ projectRoot });
    }
    return authority;
  };

  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== RUN_HAND_TOOL_NAME) return;
    const decision = authorityFor(ctx).authorize({
      toolName: event.toolName,
      input: event.input,
      sessionId: piSessionId(ctx),
      toolCallId: event.toolCallId,
    });
    if (decision && decision.ok === false) return { block: true, reason: decision.reason };
  });

  pi.registerTool({
    name: RUN_HAND_TOOL_NAME,
    label: "Harness cheap hand",
    description:
      "Dispatch a scoped cheap hand headlessly and capture its result independently. DONE never comes from the hand's prose or its process exit code — only from the shared capture oracle.",
    promptSnippet:
      "Dispatch a scoped cheap hand with run_hand once its locked test is frozen and the fidelity-pass is stamped.",
    promptGuidelines: [
      "Write the descriptor JSON first; run_hand reads it and refuses an unreadable or invalid one.",
      "An executor hand is refused until fidelity-pass for the exact feature/task is stamped; dispatch the test-author first.",
      "Route the hand with an openai-codex/* model; no other provider is approved on this lane.",
    ],
    parameters: RunHandParams,
    executionMode: "sequential",

    async execute(toolCallId, _params, _signal, _onUpdate, ctx) {
      const result = await authorityFor(ctx).execute({
        toolCallId,
        sessionId: piSessionId(ctx),
      });
      return { content: [{ type: "text", text: result.output }], details: result.metadata };
    },
  });
}
