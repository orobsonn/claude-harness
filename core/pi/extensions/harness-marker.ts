import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createPiMarkerAuthority, MARKER_TOOL_NAME } from "../lib/marker-authority.mjs";
import { isChildSession, piSessionId } from "../lib/pi-adapter-map.mjs";
import { readPiDispatchRecord, removePiDispatchRecord } from "../lib/pi-state-records.mjs";

const MarkParams = Type.Object({
  action: StringEnum(
    [
      "brainstormed",
      "adversary_fired",
      "fidelity",
      "regate-pending",
      "regate-passed",
      "hand-finished",
      "capture-verified",
      "final-review",
      "demo-done",
    ] as const,
    { description: "Privileged harness marker to persist on the runtime gate-state." },
  ),
  task_id: Type.Optional(Type.String({ description: "Task id for task-scoped markers." })),
  sha: Type.Optional(Type.String({ description: "Commit SHA for SHA-qualified markers." })),
  feature_id: Type.Optional(Type.String({ description: "Untrusted hint; classified runtime identity wins." })),
});

/** @description Adaptador fino da peça marker-authority: traduz eventos do Pi para a lógica pura
 * de core/pi/lib/marker-authority.mjs. `tool_call` autoriza a chamada nativa de `mark` antes da
 * execução (deny vira {block:true,reason}); a tool registrada consome essa autorização exatamente
 * uma vez. Nenhuma decisão vive aqui — o adaptador só traduz. */
export default function harnessMarker(pi: ExtensionAPI) {
  let authority: ReturnType<typeof createPiMarkerAuthority> | undefined;
  let authorityRoot = "";

  // Uma autoridade por raiz de projeto. Trocar de raiz descarta autorizações pendentes
  // (fail-closed: a chamada seguinte cai em 'marker authorization missing…').
  const authorityFor = (ctx: ExtensionContext) => {
    const projectRoot = ctx.cwd;
    if (!authority || authorityRoot !== projectRoot) {
      authorityRoot = projectRoot;
      authority = createPiMarkerAuthority({
        projectRoot,
        readDispatchRecord: readPiDispatchRecord,
        removeDispatchRecord: removePiDispatchRecord,
        readSessionEntries: () => ctx.sessionManager.getEntries(),
      });
    }
    return authority;
  };

  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== MARKER_TOOL_NAME) return;
    const decision = authorityFor(ctx).authorize({
      toolName: event.toolName,
      input: event.input,
      sessionId: piSessionId(ctx),
      toolCallId: event.toolCallId,
    });
    if (decision && decision.ok === false) return { block: true, reason: decision.reason };
  });

  pi.registerTool({
    name: MARKER_TOOL_NAME,
    label: "Harness marker",
    description:
      "Persist a runtime-bound privileged harness marker. No dedicated shell CLI exists; same-user import and instantiation are outside this authority boundary.",
    promptSnippet: "Persist a privileged harness gate marker with mark once its real precondition is satisfied.",
    promptGuidelines: [
      "Call mark only after the step it certifies actually happened; the marker records a fact, it does not create one.",
      "Pass task_id to mark for the task-scoped actions (fidelity, regate-pending, regate-passed, hand-finished, capture-verified).",
      "Only the parent build session may call mark with action=capture-verified.",
    ],
    parameters: MarkParams,
    executionMode: "sequential",

    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const result = authorityFor(ctx).execute({
        toolCallId,
        params,
        sessionId: piSessionId(ctx),
        isChild: isChildSession(ctx),
      });
      return { content: [{ type: "text", text: result.output }], details: result.metadata };
    },
  });
}
