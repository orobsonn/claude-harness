/**
 * @description OC plan-write-gate — anti-forge + active_dispatch scope rail for official write tools.
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
  const bare = n.split(/[.:/]/).pop() ?? n;
  return ["write", "edit", "multiedit", "multi_edit", "write_file", "edit_file", "create_file", "delete_file"].includes(bare) ||
    n.endsWith(".write") || n.endsWith(".edit") || n.endsWith("_write") || n.endsWith("_edit");
}

function isPatchTool(name: unknown): boolean {
  if (typeof name !== "string") return false;
  const bare = name.toLowerCase().split(/[.:/]/).pop() ?? "";
  return bare === "apply_patch" || bare === "applypatch" || bare === "patch";
}

/** @description Whether tool is a shell command whose concrete write targets must be scoped. */
function isBashTool(name: unknown): boolean {
  if (typeof name !== "string") return false;
  const n = name.toLowerCase();
  return n === "bash" || n === "shell" || n.endsWith(".bash") || n.endsWith("_bash") || n.endsWith(".shell") || n.endsWith("_shell");
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
function extractPatchPaths(args: Record<string, unknown> | null): string[] {
  const patch = args?.patchText ?? args?.patch ?? args?.diff ?? args?.input;
  if (typeof patch !== "string") return [];
  const paths: string[] = [];
  const add = (raw: string) => {
    const value = raw.trim().replace(/^['"]|['"]$/g, "").replace(/^[ab]\//, "");
    if (value && value !== "/dev/null" && !paths.includes(value)) paths.push(value);
  };
  for (const line of patch.split(/\r?\n/)) {
    const envelope = line.match(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/) ?? line.match(/^\*\*\* Move to:\s*(.+)$/);
    if (envelope) add(envelope[1]);
    const unified = line.match(/^\+\+\+\s+([^\t]+)|^---\s+([^\t]+)/);
    if (unified) add(unified[1] ?? unified[2]);
  }
  return paths;
}

function extractOfficialWritePaths(args: Record<string, unknown> | null, extractWritePath: (payload: unknown) => string): string[] {
  const paths: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === "string" && value && !paths.includes(value)) paths.push(value);
  };
  add(extractWritePath({ args: args ?? {} }));
  const edits = Array.isArray(args?.edits) ? args.edits : Array.isArray(args?.files) ? args.files : [];
  for (const edit of edits) {
    if (edit && typeof edit === "object" && !Array.isArray(edit)) add(extractWritePath({ args: edit }));
  }
  return paths;
}

/**
 * @description Builds plan-write-gate hooks (async load of pure decide + resolveHookArgs).
 * When projectRoot is set, loads gate-state by sessionId for the scope rail.
 */
export async function createPlanWriteGateHooks(
  projectRoot?: string,
  deps: { client?: any; identityReader?: any; resolveRuntimeIdentity?: any; requireHeartbeat?: boolean } = {},
): Promise<Pick<Hooks, "tool.execute.before" | "tool.execute.after" | "event">> {
  const { decide, throwIfDenied, extractWritePath } = await import(
    "./lib/plan-write-decide.mjs"
  );
  const { resolveHookArgs } = await import("./lib/obs-emit.mjs");
  const { loadGateStateFromDisk } = await import("./lib/dual-enforcement.mjs");
  const { invalidateScopeRuntimeIdentity, resolveScopeRuntimeIdentity } = await import("./lib/scope-runtime-identity.mjs");

  const root =
    typeof projectRoot === "string" && projectRoot.length > 0
      ? projectRoot
      : "";
  const { registerScopeComponent, scopeRuntimeCompositionMode } = await import("./lib/scope-runtime-composition.mjs");
  if (root) registerScopeComponent(root, "plan-write-gate");

  return {
    "tool.execute.before": async (input: any, output: any) => {
      const writeTool = isWriteTool(input?.tool);
      const patchTool = isPatchTool(input?.tool);
      const bashTool = isBashTool(input?.tool);
      if (!writeTool && !patchTool && !bashTool) return;
      const args = resolveHookArgs(input, output);
      const {
        appendScopeEvent,
        hasCleanupPending,
        heartbeatActiveDispatch,
        normalizeProjectPath,
        reconcileExpiredDispatch,
      } = await import("./lib/dispatch-scope.mjs");
      const rawPaths = bashTool
        ? []
        : patchTool
          ? extractPatchPaths(args)
          : extractOfficialWritePaths(args, extractWritePath);
      let filePath = rawPaths[0] ?? "";

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
      const adapterSession = process.env.HARNESS_ACTIVE_DISPATCH_SESSION_ID;
      const adapterToken = process.env.HARNESS_ACTIVE_DISPATCH_CLAIM_TOKEN;
      const resolveRuntimeIdentity = deps.resolveRuntimeIdentity ?? resolveScopeRuntimeIdentity;
      const trusted = await resolveRuntimeIdentity(root, inputRec, {
        client: deps.client,
        reader: deps.identityReader,
        adapterParentSessionId: adapterSession,
        adapterToken,
      });
      const mode = root ? scopeRuntimeCompositionMode(root) : "shadow";
      if (!trusted.ok && mode === "enforce" && trusted.notWritingSession !== true) {
        throw new Error(`[plan-write-gate] Blocked: trusted session/message identity unavailable (${trusted.reason}).`);
      }
      let sessionId = trusted.ok ? trusted.parentSessionId : inputRec?.sessionID ?? inputRec?.sessionId ?? null;
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
      const actingRole = trusted.ok ? trusted.role : "";
      const isSubagent = trusted.ok;

      let active = gateState != null && typeof gateState === "object" && !Array.isArray(gateState)
        ? (gateState as Record<string, any>).active_dispatch
        : null;
      if (active && !trusted.ok) {
        throw new Error(`[plan-write-gate] Blocked: trusted writing-session identity required (${trusted.reason}).`);
      }
      if (!trusted.ok && (trusted.boundRequired === true || (adapterSession && adapterToken))) {
        throw new Error(`[plan-write-gate] Blocked: child/adapter dispatch binding invalid (${trusted.reason}).`);
      }
      if (root && typeof sessionId === "string" && hasCleanupPending(root, sessionId)) {
        throw new Error("[plan-write-gate] Blocked: active_dispatch cleanup_pending; authority cleanup must reconcile before writes.");
      }
      if (active && root && typeof sessionId === "string") {
        const heartbeat = heartbeatActiveDispatch(root, {
          sessionId,
          callId: trusted.callId,
          token: trusted.token,
          role: actingRole,
        });
        if (deps.requireHeartbeat !== false && !heartbeat.ok) {
          throw new Error(`[plan-write-gate] Blocked: active dispatch heartbeat rejected (${heartbeat.reason}).`);
        }
        reconcileExpiredDispatch(root, sessionId);
        const refreshed = loadGateStateFromDisk(root, { sessionId });
        if (refreshed.ok) {
          gateState = refreshed.state;
          active = refreshed.state && typeof refreshed.state === "object" && !Array.isArray(refreshed.state)
            ? (refreshed.state as Record<string, any>).active_dispatch
            : null;
        }
      }

      if (active?.status === "stale") {
        throw new Error("[plan-write-gate] Blocked: active_dispatch lease is stale; explicit termination reconciliation required.");
      }

      if ((writeTool || patchTool) &&
        /(?:^|[\\/])execution-plan\.json$/i.test(filePath) &&
        gateState != null &&
        typeof gateState === "object" &&
        !Array.isArray(gateState) &&
        (gateState as Record<string, unknown>).planner_status === "usable"
      ) {
        throw new Error("[plan-write-gate] Blocked: bound execution-plan.json is immutable until a new planner claim.")
      }

      if (bashTool && active) {
        // OC-native: writing-hand Task may run a small allowlist (git inspect + node --test).
        // Blanket bash deny was CC spawn-hand shaped and caused BLOCKED hands + rework.
        const cmd = typeof args?.command === "string" ? args.command.trim() : "";
        // No pipes/chains/redirects in allowlist (anti-forgery).
        const simple = cmd.length > 0 && !/[|;&><`$]/.test(cmd);
        const allowHandBash =
          simple &&
          (/^git\s+(status|diff|log|rev-parse|show)(\s|$)/.test(cmd) ||
            /^node\s+--test(\s|$)/.test(cmd) ||
            /^npx\s+vitest\s+run(\s|$)/.test(cmd) ||
            /^(ls|pwd)(\s|$)/.test(cmd) ||
            /^(cat|head|tail|wc)\s+\S+$/.test(cmd));
        if (allowHandBash) {
          if (mode === "shadow") return;
          return;
        }
        const recorded = appendScopeEvent(root, active, {
          tool: input?.tool,
          paths: [],
          mode,
          reason: "bash-unknown-risk",
        });
        if (!recorded.ok) throw new Error(`[plan-write-gate] Blocked: ${recorded.reason}; shadow evidence is mandatory.`);
        if (mode === "shadow") return;
        throw new Error("[plan-write-gate] Blocked: Bash is disabled during an active writing-hand dispatch except git status/diff/log and node --test. Complete cleanup first for other commands.");
      }
      if (bashTool) return;
      if ((writeTool || patchTool) && rawPaths.length === 0) {
        throw new Error("[plan-write-gate] Blocked: official write/patch tool exposed no parseable target paths.");
      }
      for (const rawPath of rawPaths) {
        const normalized = root && active ? normalizeProjectPath(root, rawPath) : { ok: true, path: rawPath };
        const checkedPath = normalized.ok ? normalized.path : rawPath;
        const decision = normalized.ok
          ? decide(
              { args: { filePath: checkedPath }, tool_input: { file_path: checkedPath } },
              { gateState, actingRole: actingRole || undefined, isSubagent },
            )
          : { allow: false, reason: `[plan-write-gate] Blocked: '${rawPath}' is not a safe project path (${normalized.reason}).` };
        const scopeViolation = !normalized.ok || /OUTSIDE|armed hand dispatch|acting role identity/i.test(decision.reason ?? "");
        if (decision.allow === false && scopeViolation && active && typeof active === "object") {
          const recorded = appendScopeEvent(root, active, {
            tool: input?.tool,
            paths: [checkedPath],
            mode,
            reason: normalized.ok ? "outside-approved-scope" : "unsafe-project-path",
          });
          if (!recorded.ok) throw new Error(`[plan-write-gate] Blocked: ${recorded.reason}; shadow evidence is mandatory.`);
          if (mode === "shadow") continue;
        }
        throwIfDenied(decision);
      }
    },
    "tool.execute.after": async (input: any) => {
      if (!isWriteTool(input?.tool) && !isPatchTool(input?.tool) && !isBashTool(input?.tool)) return;
      invalidateScopeRuntimeIdentity(root, input?.sessionID ?? input?.sessionId, input?.callID ?? input?.callId);
    },
    event: async ({ event }: any) => {
      const part = event?.properties?.part ?? event?.part;
      if (event?.type === "message.part.updated" && part?.type === "tool" && (part?.state?.status === "completed" || part?.state?.status === "error")) {
        invalidateScopeRuntimeIdentity(root, part.sessionID, part.callID);
        return;
      }
      if (event?.type === "session.idle" || event?.type === "session.error" || event?.type === "session.deleted") {
        invalidateScopeRuntimeIdentity(root, event?.properties?.sessionID ?? event?.properties?.info?.id);
      }
    },
  };
}

/**
 * @description OpenCode plugin factory — named const + default (OC load contract).
 * Accepts { directory, worktree } like entry-gate for projectRoot resolution.
 */
export const PlanWriteGate: Plugin = async ({ directory, worktree, client }: any = {}) => {
  const root = resolveProjectRoot(directory, worktree);
  return createPlanWriteGateHooks(root, { client });
};

/** @description OC load contract — default export required. */
export default PlanWriteGate;
