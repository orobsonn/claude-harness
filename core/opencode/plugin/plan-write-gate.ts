/**
 * @description OC plan-write-gate — anti-forge + call-keyed dispatch scope rail for official write tools.
 * tool.execute.before: deny throws [plan-write-gate]. Canonical plans are planner-written only.
 * Factory accepts projectRoot / { directory, worktree } so live gate-state load works
 * when an exact dispatch record is stamped; missing session/role/state → scope rail off, anti-forge still runs.
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
  return ["write", "edit", "multiedit", "multi_edit", "write_file", "edit_file", "create_file", "delete", "delete_file"].includes(bare) ||
    n.endsWith(".write") || n.endsWith(".edit") || n.endsWith(".delete") || n.endsWith("_write") || n.endsWith("_edit") || n.endsWith("_delete");
}

function isPlanAuthoringTool(name: unknown): boolean {
  if (typeof name !== "string") return false;
  const bare = name.toLowerCase().split(/[.:/]/).pop() ?? "";
  return ["write", "edit", "multiedit", "multi_edit", "write_file", "edit_file", "create_file", "apply_patch", "applypatch", "patch"].includes(bare);
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

/** @description Extract target file paths from an apply_patch-style unified/envelope patch body. */
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

function unwrapSdkData(value: any): any {
  return value && typeof value === "object" && "data" in value ? value.data : value;
}

/** @description Authenticate one planner Write/Edit against official child and parent Task metadata. */
async function resolveOfficialPlannerIdentity(
  projectRoot: string,
  input: any,
  options: { client?: any; reader?: any } = {},
): Promise<{ ok: true; role: "planner"; parentSessionId: string } | { ok: false; reason: string }> {
  const childSessionId = typeof input?.sessionID === "string" ? input.sessionID : "";
  const callId = typeof input?.callID === "string" ? input.callID : "";
  if (!childSessionId || !callId) return { ok: false, reason: "runtime sessionID/callID unavailable" };
  const reader = options.reader ?? {
    getSession: async (sessionId: string) => unwrapSdkData(await options.client?.session?.get?.({ path: { id: sessionId }, query: { directory: projectRoot } })),
    getMessages: async (sessionId: string) => unwrapSdkData(await options.client?.session?.messages?.({ path: { id: sessionId }, query: { directory: projectRoot } })),
  };
  let session: any;
  try {
    session = await reader.getSession(childSessionId);
  } catch {
    return { ok: false, reason: "official planner metadata unavailable" };
  }
  const parentSessionId = session?.id === childSessionId && typeof session?.parentID === "string" ? session.parentID : "";
  if (!parentSessionId) return { ok: false, reason: "planner child session has no official parent" };
  if (session?.agent !== "planner") return { ok: false, reason: "official child session is not planner" };
  let childMessages: any;
  try {
    childMessages = await reader.getMessages(childSessionId);
  } catch {
    return { ok: false, reason: "official planner metadata unavailable" };
  }
  const writeMatches: any[] = [];
  for (const bundle of Array.isArray(childMessages) ? childMessages : []) {
    for (const part of Array.isArray(bundle?.parts) ? bundle.parts : []) {
      if (
        bundle?.info?.role === "assistant" && bundle?.info?.agent === "planner" &&
        (bundle?.info?.sessionID == null || bundle.info.sessionID === childSessionId) && typeof bundle?.info?.parentID === "string" &&
        part?.type === "tool" && part?.callID === callId &&
        (part?.sessionID == null || part.sessionID === childSessionId) &&
        (part?.messageID == null || part.messageID === bundle.info.id) &&
        String(part?.tool).toLowerCase() === String(input?.tool).toLowerCase()
      ) writeMatches.push({ bundle, part });
    }
  }
  if (writeMatches.length !== 1) return { ok: false, reason: "official planner write call is missing or ambiguous" };
  const childParent = (Array.isArray(childMessages) ? childMessages : []).filter((bundle: any) =>
    bundle?.info?.id === writeMatches[0].bundle.info.parentID && bundle?.info?.role === "user" &&
    (bundle?.info?.sessionID == null || bundle.info.sessionID === childSessionId) && bundle?.info?.agent === "planner",
  );
  if (childParent.length !== 1) return { ok: false, reason: "official planner message relationship conflicts" };
  let parentMessages: any;
  try {
    parentMessages = await reader.getMessages(parentSessionId);
  } catch {
    return { ok: false, reason: "official parent Task metadata unavailable" };
  }
  const dispatches: any[] = [];
  for (const bundle of Array.isArray(parentMessages) ? parentMessages : []) {
    for (const part of Array.isArray(bundle?.parts) ? bundle.parts : []) {
      const toolName = String(part?.tool ?? "").toLowerCase();
      if (
        bundle?.info?.role === "assistant" &&
        (bundle?.info?.sessionID == null || bundle.info.sessionID === parentSessionId) &&
        part?.type === "tool" && ["task", "task_tool", "tasktool"].includes(toolName) &&
        (part?.sessionID == null || part.sessionID === parentSessionId) &&
        (part?.messageID == null || part.messageID === bundle.info.id) &&
        part?.state?.status === "running" && part?.state?.input?.subagent_type === "planner" &&
        part?.state?.metadata?.sessionId === childSessionId
      ) dispatches.push(part);
    }
  }
  return dispatches.length === 1
    ? { ok: true, role: "planner", parentSessionId }
    : { ok: false, reason: "official parent planner Task is missing or ambiguous" };
}

/**
 * @description Builds plan-write-gate hooks (async load of pure decide + resolveHookArgs).
 * When projectRoot is set, loads gate-state by sessionId for the scope rail.
 */
async function createPlanWriteGateHooks(
  projectRoot?: string,
  deps: { client?: any; identityReader?: any; resolveRuntimeIdentity?: any; resolvePlannerIdentity?: any; requireHeartbeat?: boolean } = {},
): Promise<Pick<Hooks, "tool.execute.before">> {
  const { decide, throwIfDenied, extractWritePath, isCanonicalPlanPath } = await import(
    "./lib/plan-write-decide.mjs"
  );
  const { resolveHookArgs } = await import("../lib/obs-emit.mjs");

  const root =
    typeof projectRoot === "string" && projectRoot.length > 0
      ? projectRoot
      : "";
  return {
    "tool.execute.before": async (input: any, output: any) => {
      const writeTool = isWriteTool(input?.tool);
      const patchTool = isPatchTool(input?.tool);
      const bashTool = isBashTool(input?.tool);
      if (!writeTool && !patchTool && !bashTool) return;
      const args = resolveHookArgs(input, output);
      const rawPaths = bashTool
        ? []
        : patchTool
          ? extractPatchPaths(args)
          : extractOfficialWritePaths(args, extractWritePath);
      const canonicalTargets = rawPaths.filter((rawPath) => isCanonicalPlanPath(rawPath));
      // Bash never authors the canonical plan. Write/Edit/apply_patch require an official
      // planner child identity; model-supplied agent aliases are not authority.
      if (bashTool) {
        throwIfDenied(decide({ args }));
        // Bash has only literal anti-forge friction. Resolving a writing-hand
        // identity here can reject read-only verification commands in eye sessions.
        return;
      } else if (isPlanAuthoringTool(input?.tool)) {
        const resolvePlannerIdentity = deps.resolvePlannerIdentity ?? resolveOfficialPlannerIdentity;
        const planner = await resolvePlannerIdentity(root, input, { client: deps.client, args });
        if (planner?.ok && planner.role === "planner") {
          if (rawPaths.length === 0) {
            throw new Error("[plan-write-gate] Blocked: planner authoring exposed no parseable target paths.");
          }
          if (canonicalTargets.length !== rawPaths.length) {
            throw new Error("[plan-write-gate] Blocked: planner may author only canonical execution plans.");
          }
          for (const rawPath of rawPaths) {
            throwIfDenied(decide({ args: { filePath: rawPath } }, { actingRole: "planner" }));
          }
          return;
        }
        if (canonicalTargets.length > 0) {
          throw new Error(`[plan-write-gate] Blocked: official planner identity required (${String(planner?.reason ?? "missing")}).`);
        }
        for (const rawPath of rawPaths) {
          throwIfDenied(decide({ args: { filePath: rawPath } }));
        }
      } else {
        for (const rawPath of rawPaths) {
          throwIfDenied(decide({ args: { filePath: rawPath } }));
        }
      }
      const { resolveScopeRuntimeIdentity } = await import("./lib/scope-runtime-identity.mjs");
      const { normalizeProjectPath } = await import("../lib/dispatch-scope.mjs");
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
      const adapterSession = process.env.HARNESS_DISPATCH_PARENT_SESSION_ID;
      const adapterCallId = process.env.HARNESS_DISPATCH_CALL_ID;
      const resolveRuntimeIdentity = deps.resolveRuntimeIdentity ?? resolveScopeRuntimeIdentity;
      const trusted = await resolveRuntimeIdentity(root, inputRec, {
        client: deps.client,
        reader: deps.identityReader,
        adapterParentSessionId: adapterSession,
        adapterCallId,
      });
      if (!trusted.ok && trusted.conflict === true) throw new Error(`[plan-write-gate] Blocked: trusted writing-hand identity conflicts (${trusted.reason}).`);
      if (!trusted.ok && trusted.verifiedWritingHand === true && trusted.exactRecordMissing === true) throw new Error(`[plan-write-gate] Blocked: exact writing-hand dispatch record required (${trusted.reason}).`);
      if (!trusted.ok && trusted.unavailable === true) console.warn(`[plan-write-gate] scope rail unavailable, allowing: ${trusted.reason}`);
      const actingRole = trusted.ok ? trusted.role : "";
      const isSubagent = trusted.ok;
      const record = trusted.ok ? trusted.record : null;

      if ((writeTool || patchTool) && rawPaths.length === 0) {
        throw new Error("[plan-write-gate] Blocked: official write/patch tool exposed no parseable target paths.");
      }
      for (const rawPath of rawPaths) {
        const normalized = root && record ? normalizeProjectPath(root, rawPath) : { ok: true, path: rawPath };
        const checkedPath = normalized.ok ? normalized.path : rawPath;
        const decision = normalized.ok
          ? decide(
              { args: { filePath: checkedPath }, tool_input: { file_path: checkedPath } },
              { actingRole: actingRole || undefined, isSubagent, dispatchRecord: record },
            )
          : { allow: false, reason: `[plan-write-gate] Blocked: '${rawPath}' is not a safe project path (${normalized.reason}).` };
        const scopeViolation = !normalized.ok || /OUTSIDE|armed hand dispatch|acting role identity/i.test(decision.reason ?? "");
        throwIfDenied(decision);
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
Object.defineProperty(PlanWriteGate, "testApi", { value: Object.freeze({ createPlanWriteGateHooks, resolveOfficialPlannerIdentity }) });

/** @description OC load contract — default export required. */
export default PlanWriteGate;
