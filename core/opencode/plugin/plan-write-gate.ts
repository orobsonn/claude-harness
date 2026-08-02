/**
 * @description OC plan-write-gate — anti-forge + call-keyed dispatch scope rail for official write tools.
 * tool.execute.before: deny throws [plan-write-gate]. Canonical plans are host-written only.
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

/**
 * @description Builds plan-write-gate hooks (async load of pure decide + resolveHookArgs).
 * When projectRoot is set, loads gate-state by sessionId for the scope rail.
 */
async function createPlanWriteGateHooks(
  projectRoot?: string,
  deps: { client?: any; identityReader?: any; resolveRuntimeIdentity?: any; requireHeartbeat?: boolean } = {},
): Promise<Pick<Hooks, "tool.execute.before">> {
  const { decide, throwIfDenied, extractWritePath } = await import(
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
      // R14 is an owner fact: deny canonical model writes before resolving identity,
      // scope, heartbeat, or gate-state. Bash matching is deliberately literal best-effort.
      if (bashTool) {
        throwIfDenied(decide({ args }));
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

      // After the early canonical-path friction, ordinary Bash remains outside the scope rail —
      // Claude Code parity (#484). The removed OC-only blanket deny caused blocked hands and
      // rework on normal git/node commands.
      if (bashTool) return;
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
Object.defineProperty(PlanWriteGate, "testApi", { value: Object.freeze({ createPlanWriteGateHooks }) });

/** @description OC load contract — default export required. */
export default PlanWriteGate;
