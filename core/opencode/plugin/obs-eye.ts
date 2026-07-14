/**
 * @description Post-task observability for eye agents (OC port of CC obs-eye-append).
 * tool.execute.after: args from output.args. Full plan scoped to session+feature (not global scan).
 * Also extends the hook with a deterministic dual-eye nudge (compute → persist → mutate) for
 * eligible primary review eyes (family 1, including compatibility aliases) — see
 * ./lib/dual-nudge.mjs for the pure, atomic gate-state read-decide-write.
 * Default export is the OC plugin load contract.
 */
import type { Plugin, Hooks } from "@opencode-ai/plugin";

const FALSY_ENV_VALUES = new Set(["", "0", "false", "off", "no"]);

/**
 * @description True when HARNESS_CODEX_ADVERSARY is set to a non-falsy sentinel.
 * @param {string|undefined} raw
 * @returns {boolean}
 */
function isCrossFamilyEnabled(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  return !FALSY_ENV_VALUES.has(raw.toLowerCase());
}

function isTaskTool(name: unknown): boolean {
  if (typeof name !== "string") return false;
  const n = name.toLowerCase();
  return n === "task" || n === "agent" || n.endsWith(".task") || n.endsWith(".agent");
}

function extractResponse(input: any, output: any): string {
  try {
    const r =
      output?.output ??
      output?.content ??
      output?.result ??
      input?.tool_response ??
      input?.result ??
      "";
    return typeof r === "string" ? r : JSON.stringify(r ?? "");
  } catch {
    return "";
  }
}

/**
 * @description Build after-hooks for eye outbox events.
 */
export async function createObsEyeHooks(
  dir?: string,
): Promise<Pick<Hooks, "tool.execute.after">> {
  const {
    eventForEyeRole,
    isEyeRole,
    isHandRole,
    obsAppend,
    dedupeByType,
    fullPlanExistsForRun,
    resolveHookArgs,
    extractTaskIds,
    bareEyeRole,
    reviewAgentIdentity,
  } = await import("./lib/obs-emit.mjs");
  const cwd = typeof dir === "string" && dir ? dir : process.cwd();
  return {
    "tool.execute.after": async (input: any, output: any) => {
      try {
        if (!isTaskTool(input?.tool)) return;
        const args = resolveHookArgs(input, output);
        const ids = extractTaskIds(args);
        if (!isEyeRole(ids.role)) return;
        // hands handled by obs-hand
        if (isHandRole(ids.role)) return;
        const text = extractResponse(input, output);
        const sessionId =
          typeof input?.sessionID === "string" ? input.sessionID : null;
        const planExists = fullPlanExistsForRun({
          cwd,
          sessionId,
          featureId: ids.featureId || null,
        });
        const ev = eventForEyeRole(ids.role, text, { planExists });
        if (ev) obsAppend(ev, { dedupe: dedupeByType });

        // Deterministic dual-eye nudge — catalog primary eyes only; family 2 never triggers it.
        try {
          const bareRole = bareEyeRole(ids.role);
          const reviewIdentity = reviewAgentIdentity(bareRole);
          const logicalRole = reviewIdentity?.logicalRole ?? bareRole;
          const rawPhase =
            typeof args?.phase === "string" && args.phase.length > 0
              ? args.phase
              : null;
          const phase =
            rawPhase ??
            (logicalRole === "plan-reviewer"
              ? "plan"
              : planExists
                ? "task"
                : "spec");
          if (
            reviewIdentity?.primary === true &&
            sessionId &&
            phase &&
            ids.featureId &&
            ids.taskId
          ) {
            const { applyDualNudge } = await import("./lib/dual-nudge.mjs");
            const { gateStatePath } = await import(
              "../../shared/lib/path-helpers.mjs"
            );
            const crossFamilyEnabled = isCrossFamilyEnabled(
              process.env.HARNESS_CODEX_ADVERSARY,
            );
            const nudge = applyDualNudge({
              role: logicalRole,
              featureId: ids.featureId,
              taskId: ids.taskId,
              phase,
              crossFamilyEnabled,
              gateStatePath: () =>
                gateStatePath({ projectRoot: cwd, runtime: "opencode", sessionId }),
            });
            // STEP 3 (MUTATE): only after a successful persist — never before, never on deny.
            if (nudge.ok) {
              if (!output.metadata || typeof output.metadata !== "object") {
                output.metadata = {};
              }
              output.metadata.dual_nudge = nudge.message;
            }
          }
        } catch {
          /* fail-open — dual-nudge never blocks observability */
        }
      } catch {
        /* fail-open */
      }
    },
  };
}

export const obsEye: Plugin = async ({ directory }) =>
  createObsEyeHooks(typeof directory === "string" ? directory : undefined);

/** @description OC load contract — default export required. */
export default obsEye;
