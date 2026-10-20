/** Distinguish a transport completion from a host-proven writing attempt. */
import { parseHandStatusFromOutput } from "../../opencode/lib/hand-records.mjs";
const TASK_WRITING_ROLES = new Set(["harness-test-author", "harness-executor", "harness-sniper"]);

/** A native no-tool refusal cannot supersede actual oracle authorship.
 * Missing/ambiguous counters and blocked writers that used tools stay conservative.
 * This is only fidelity selection, never capture/implementation approval.
 */
export function isUnwrittenBlockedWriter(role, result, isError = false) {
  if (!TASK_WRITING_ROLES.has(role) || isError === true ||
      result?.details?.status !== "completed" || result.details.subagentType !== role ||
      result.details.toolUses !== 0) return false;
  if (!Array.isArray(result.content)) return false;
  const text = result.content.filter(b => b?.type === "text").map(b => b.text).join("\n");
  return parseHandStatusFromOutput(text) === "BLOCKED";
}

