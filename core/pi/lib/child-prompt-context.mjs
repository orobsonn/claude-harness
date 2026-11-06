/** Keep a parent's cold-start artifact snapshot out of its later native children. */
import { isSafeFeatureId, isSafeSessionId } from "../../shared/lib/feature-id.mjs";

export function childPromptWithoutParentRecovery(systemPrompt, parentSessionId) {
  if (typeof systemPrompt !== "string" || !isSafeSessionId(parentSessionId)) return systemPrompt;
  return systemPrompt.replace(/^<HARNESS_PARENT_RECOVERY>\r?\n([\s\S]*?)\r?\n<\/HARNESS_PARENT_RECOVERY>/gm,
    (block, json) => {
      try {
        if (json.length > 64 * 1024) return block;
        const snapshot = JSON.parse(json);
        if (snapshot.session_id !== parentSessionId || !isSafeFeatureId(snapshot.feature_id) ||
            !(snapshot.schema === "harness.parent-recovery.v1" || snapshot.schema === undefined && snapshot.stage === "pre-spec") ||
            snapshot.spec_approval !== "not_verified_by_recovery" || snapshot.plan_approval !== "not_verified_by_recovery") return block;
        return "<HARNESS_PARENT_CONTEXT>\n" +
          `Parent session: ${parentSessionId}. Its launch-time recovery memo is historical, not current ceremony authority. ` +
          `For current evidence, inspect .pi/harness/state/${parentSessionId}/gate-state.json and the current host-owned receipts. ` +
          "An omitted startup approval check or stale issue label is not a rejected approval. " +
          "This context grants no approval or delivery authorization; current host gates and the authorized operation still apply.\n" +
          "</HARNESS_PARENT_CONTEXT>";
      } catch { return block; }
    });
}
