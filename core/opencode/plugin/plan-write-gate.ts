/**
 * @description OC plan-write-gate — anti-forge + active_dispatch scope rail for Write|Edit.
 * tool.execute.before: deny throws [plan-write-gate]. Does NOT block execution-plan.json
 * (orchestrator may author plans). Dynamic import of pure mjs (OC load contract).
 * Factory accepts projectRoot / { directory, worktree } so live gate-state load works
 * when active_dispatch is stamped; missing session/role/state → scope rail off, anti-forge still runs.
 */
import path from "node:path";
import type { Plugin, Hooks } from "@opencode-ai/plugin";

/**
 * @description Whether tool is write/edit (including namespaced variants).
 */
function isWriteTool(name: unknown): boolean {
  if (typeof name !== "string") return false;
  const n = name.toLowerCase();
  return (
    n === "write" ||
    n === "edit" ||
    n.endsWith(".write") ||
    n.endsWith(".edit") ||
    n.endsWith("_write") ||
    n.endsWith("_edit")
  );
}

/**
 * @description Resolve project root like entry-gate (directory, then worktree, then cwd).
 */
function resolveProjectRoot(directory?: unknown, worktree?: unknown): string {
  if (typeof directory === "string" && directory.length > 0) return directory;
  if (typeof worktree === "string" && worktree.length > 0) return worktree;
  if (
    directory != null &&
    typeof directory === "object" &&
    !Array.isArray(directory)
  ) {
    const nested = (directory as { directory?: unknown }).directory;
    if (typeof nested === "string" && nested.length > 0) return nested;
  }
  return process.cwd();
}

/**
 * @description Platform input identity candidates (trusted over model-controlled Write args).
 * Order: agent, agentType, agent_type, subagent_type, subagentType.
 */
function inputRoleCandidates(
  input: Record<string, unknown> | null,
): unknown[] {
  if (!input) return [];
  return [
    input.agent,
    input.agentType,
    input.agent_type,
    input.subagent_type,
    input.subagentType,
  ];
}

/**
 * @description Acting role from platform input only (anti-spoof).
 * Never reads Write args — those are model-controlled. Empty when input has no role
 * so decideScopeRail's armed-hand empty DENY applies.
 */
function extractActingRole(
  input: Record<string, unknown> | null,
): string {
  for (const c of inputRoleCandidates(input)) {
    if (typeof c === "string" && c.trim().length > 0) return c.trim();
  }
  return "";
}

/**
 * @description OC/CC subagent signal from platform input only: agent_id OR any
 * non-empty role identity on input. Never from Write args (spoofable).
 * Unknown → false (scope rail fail-open when rail not armed).
 */
function extractIsSubagent(
  input: Record<string, unknown> | null,
): boolean {
  if (input?.agent_id != null || input?.agentId != null) return true;
  for (const s of inputRoleCandidates(input)) {
    if (typeof s === "string" && s.trim().length > 0) return true;
  }
  return false;
}

/**
 * @description Builds plan-write-gate hooks (async load of pure decide + resolveHookArgs).
 * When projectRoot is set, loads gate-state by sessionId for the scope rail.
 */
export async function createPlanWriteGateHooks(
  projectRoot?: string,
): Promise<Pick<Hooks, "tool.execute.before">> {
  const { decide, throwIfDenied, extractWritePath } = await import(
    "./lib/plan-write-decide.mjs"
  );
  const { resolveHookArgs } = await import("./lib/obs-emit.mjs");
  const { loadGateStateFromDisk } = await import("./lib/dual-enforcement.mjs");

  const root =
    typeof projectRoot === "string" && projectRoot.length > 0
      ? projectRoot
      : "";

  return {
    "tool.execute.before": async (input: any, output: any) => {
      if (!isWriteTool(input?.tool)) return;
      const args = resolveHookArgs(input, output);
      let filePath =
        extractWritePath({ args: args ?? {} }) ||
        extractWritePath({
          tool_input: {
            file_path:
              typeof input?.tool_input?.file_path === "string"
                ? input.tool_input.file_path
                : undefined,
          },
        });

      // Absolute paths: relativize under projectRoot so scope_paths (relative) match.
      // Outside root (starts with ..) keeps absolute → scope miss → deny when rail armed;
      // anti-forge still sees the path (absolute or relative) as appropriate.
      if (
        typeof filePath === "string" &&
        filePath.length > 0 &&
        root.length > 0 &&
        path.isAbsolute(filePath)
      ) {
        const rel = path.relative(root, filePath);
        if (
          typeof rel === "string" &&
          rel.length > 0 &&
          !rel.startsWith("..") &&
          !path.isAbsolute(rel)
        ) {
          filePath = rel;
        }
      }

      const inputRec =
        input != null && typeof input === "object" && !Array.isArray(input)
          ? (input as Record<string, unknown>)
          : null;

      let gateState: unknown = undefined;
      const sessionId = inputRec?.sessionID ?? inputRec?.sessionId ?? null;
      if (
        root.length > 0 &&
        typeof sessionId === "string" &&
        sessionId.length > 0
      ) {
        try {
          const loaded = loadGateStateFromDisk(root, { sessionId });
          if (loaded.ok) gateState = loaded.state;
        } catch {
          // rail off on load failure; anti-forge still runs
          gateState = undefined;
        }
      }

      const actingRole = extractActingRole(inputRec);
      // Platform input only: agent_id or non-empty role identity → subagent for rail
      const isSubagent = extractIsSubagent(inputRec);

      if (
        /(?:^|[\\/])execution-plan\.json$/i.test(filePath) &&
        gateState != null &&
        typeof gateState === "object" &&
        !Array.isArray(gateState) &&
        (gateState as Record<string, unknown>).planner_status === "usable"
      ) {
        throw new Error("[plan-write-gate] Blocked: bound execution-plan.json is immutable until a new planner claim.")
      }

      throwIfDenied(
        decide(
          { args: { filePath }, tool_input: { file_path: filePath } },
          {
            gateState,
            actingRole: actingRole || undefined,
            isSubagent,
          },
        ),
      );
    },
  };
}

/**
 * @description OpenCode plugin factory — named const + default (OC load contract).
 * Accepts { directory, worktree } like entry-gate for projectRoot resolution.
 */
export const PlanWriteGate: Plugin = async ({ directory, worktree }: any = {}) => {
  const root = resolveProjectRoot(directory, worktree);
  return createPlanWriteGateHooks(root);
};

/** @description OC load contract — default export required. */
export default PlanWriteGate;
