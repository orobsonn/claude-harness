import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { isChildSession, piSessionId } from "../lib/pi-adapter-map.mjs";
import { approvePiSpec, writePiSpecDraft } from "../lib/spec-approval.mjs";

/** @description Ferramentas nativas da fronteira de revisão: só o pai grava a draft e somente
 * a revisão adversarial da mesma hash pode selá-la. */
export default function harnessSpec(pi: ExtensionAPI) {
  pi.registerTool({
    name: "harness_spec_write",
    label: "Write harness spec draft",
    description: "Persist the canonical human-readable spec draft for the classified feature. This invalidates prior adversarial-review evidence; it never seals the spec.",
    promptSnippet: "Persist the proposed specification with harness_spec_write, then dispatch the adversary against that exact draft.",
    promptGuidelines: [
      "Use this only from the parent orchestrator after triage.",
      "A changed draft invalidates its prior adversarial review; do not ask the planner to proceed until seal_spec_review succeeds for the current hash.",
    ],
    parameters: Type.Object({ content: Type.String({ description: "Complete proposed spec in Markdown." }) }),
    executionMode: "sequential",
    async execute(_toolCallId, params: any, _signal, _onUpdate, ctx: any) {
      const result = writePiSpecDraft(params, { projectRoot: ctx.cwd, sessionId: piSessionId(ctx), isChild: isChildSession(ctx) });
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });

  pi.registerTool({
    name: "seal_spec_review",
    label: "Seal adversarial spec review",
    description: "Seal the current draft after the host-confirmed adversary review. It works in TUI and headless, but never bypasses a changed or unreviewed draft.",
    promptSnippet: "After handling the adversary report, call seal_spec_review only for the same draft hash. If the report requires changes, rewrite the draft and review it again first.",
    promptGuidelines: [
      "Do not call this before the adversary receipt belongs to the current draft hash.",
      "Headless is supported; the required loop is draft → adversary → fix when needed → seal.",
    ],
    parameters: Type.Object({}),
    executionMode: "sequential",
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx: any) {
      const result = await approvePiSpec({
        projectRoot: ctx.cwd,
        sessionId: piSessionId(ctx),
        isChild: isChildSession(ctx),
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });

  pi.on("tool_call", (event: any, ctx: any) => {
    if (event?.toolName !== "harness_spec_write" && event?.toolName !== "seal_spec_review") return;
    if (isChildSession(ctx)) return { block: true, reason: "[harness-spec] Blocked: spec draft and approval are restricted to the parent orchestrator." };
  });
}
