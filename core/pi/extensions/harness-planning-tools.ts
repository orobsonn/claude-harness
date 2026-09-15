import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import * as nodeModule from "node:module";
import { fileURLToPath } from "node:url";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PLANNING_TOOLS, isPlanningRole, planningRetrieval, scorePlannedChange } from "../lib/planning-tools.mjs";
import { readPiChildIdentity } from "../lib/pi-child-identity.mjs";
import { piSessionId } from "../lib/pi-adapter-map.mjs";
import { resolveVerifiedPiRuntime } from "../lib/pi-runtime-cache.mjs";
import { decidePiPolicy } from "../lib/policy.mjs";
import { analyzePiPlan } from "../lib/plan-analysis.mjs";

/** Reuse the operator-installed adapter; absence is normal, and no MCP mutation tool is registered. */
export default async function harnessPlanningTools(pi: ExtensionAPI, deps: any = {}) {
  let call = deps.call;
  let loading: Promise<void> | undefined;
  let shutdown: any;
  let closed = false;
  if (!Object.hasOwn(deps, "call")) pi.on("session_shutdown", async (event, ctx) => {
    closed = true;
    await shutdown?.(event, ctx);
  });
  async function loadAdapter(ctx: any) {
    try {
      const factory = deps.adapterFactory ?? await (async () => {
        const profile = join(homedir(), ".pi/agent");
        const config = JSON.parse(readFileSync(join(profile, "mcp.json"), "utf8"));
        const requireAdapter = nodeModule.createRequire(join(profile, "npm/package.json"));
        const runtime: any = resolveVerifiedPiRuntime();
        if (!runtime.ok) throw Error("Pi runtime unavailable");
        const requireRuntime = nodeModule.createRequire(runtime.paths.piPackage);
        const { createJiti } = requireRuntime("jiti");
        const runtimeLoader = createJiti(runtime.paths.piPackage);
        const alias = Object.fromEntries(["@earendil-works/pi-ai/compat", "@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "@sinclair/typebox"].map((name) => [name, fileURLToPath(runtimeLoader.esmResolve(name))]));
        const adapter: any = await createJiti(import.meta.url, { alias }).import(requireAdapter.resolve("pi-mcp-adapter"));
        const mcpServers = Object.fromEntries(["mv", "mp"].filter((name) => config.mcpServers?.[name]).map((name) => [name, { ...config.mcpServers[name], lifecycle: "lazy", directTools: false }]));
        return adapter.createMcpAdapter({ config: { mcpServers, settings: { ...config.settings, directTools: false, scriptMode: false, sampling: false, elicitation: false, hostConfigDiscovery: "off", requestTimeoutMs: 10000 } } });
      })();
      let proxyTool: any;
      let start: any;
      const proxy = new Proxy(pi, { get(target, key) {
        if (key === "on") return (event: string, handler: any) => {
          if (event === "session_start") start = handler;
          if (event === "session_shutdown") shutdown = handler;
        };
        if (key === "registerTool") return (tool: any) => { if (tool.name === "mcp") proxyTool = tool; };
        if (["registerCommand", "registerShortcut", "registerFlag", "setActiveTools", "sendMessage"].includes(String(key))) return () => {};
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      } });
      factory(proxy);
      if (closed) { await shutdown?.({ type: "session_shutdown" }, ctx); return; }
      await start?.({ type: "session_start", reason: "startup" }, ctx);
      call = async (server: string, tool: string, args: any, signal: AbortSignal, ctx: any) => {
        if (!proxyTool) throw Error("MCP unavailable");
        const result = await proxyTool.execute("harness-planning-retrieval", { server, tool, args: JSON.stringify(args) }, signal, undefined, ctx);
        return result;
      };
    } catch { /* Optional host integration; use the spec and code when absent. */ }
  }
  const schemas: any = {
    harness_plan_analysis: Type.Object({ feature_id: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    harness_complexity: Type.Object({ path: Type.String({ minLength: 1 }), responsibilities: Type.Optional(Type.Array(Type.String())) }, { additionalProperties: false }),
    mv_recall: Type.Object({ query: Type.String() }),
    mv_get_note: Type.Object({ id: Type.String() }),
    mp_retrieve: Type.Object({ operation: Type.Union([Type.Literal("grep"), Type.Literal("read"), Type.Literal("ls"), Type.Literal("glob")]), query: Type.Optional(Type.String()), path: Type.Optional(Type.String()) }),
  };
  for (const name of PLANNING_TOOLS) pi.registerTool({
    name, label: name,
    description: name === "harness_plan_analysis" ? "Read-only evidence from the canonical draft/current plan by feature_id: declared dependencies, shared scopes, frozen owners, shared criteria and exact literal path references in named files. Not an architectural score, resolved import graph or approval gate. No writes or MCP required; inspect coverage and limitations." : name === "harness_complexity" ? "Pass an existing file path. The host reads the file and returns its complexity using the exact Claude Code scorer. No inline source or pseudocode. File complexity is advisory, not task complexity or an approval gate." : name === "mp_retrieve" ? "Read-only MP code adapter: grep, read, ls or glob. No model-supplied code or writes. Optional, best effort." : `Optional read-only Mind Vault ${name.slice(3)}. Spec and code remain authoritative.`,
    parameters: schemas[name],
    async execute(_id: string, input: any, signal: AbortSignal | undefined, _update: any, ctx: any) {
      const identity: any = readPiChildIdentity(ctx.cwd, piSessionId(ctx), { parentSessionId: ctx.sessionManager?.getHeader?.()?.parentSession });
      let result: any = { available: false, advisory: true, reason: "Planning tools belong to planner and plan-reviewer." };
      if (identity?.ok && isPlanningRole(identity.record.role)) {
        if (name === "harness_plan_analysis") result = analyzePiPlan({ root: ctx.cwd, featureId: input.feature_id });
        else if (name !== "harness_complexity") result = await planningRetrieval(name, input, async (...args: any[]) => {
          if (!Object.hasOwn(deps, "call") && !closed) await (loading ??= loadAdapter(ctx));
          if (typeof call !== "function" || closed || signal?.aborted) throw Error("MCP unavailable");
          return call(...args, ctx);
        }, signal);
        else try {
          if (typeof input.path !== "string" || !input.path.trim() || Object.hasOwn(input, "source")) throw Error("Supply an existing file path; inline source and pseudocode are not accepted. For new files, use engineering judgment.");
          const decision = decidePiPolicy({ toolName: "read", input: { path: input.path } }, { cwd: ctx.cwd, projectRoot: ctx.cwd, reviewerRole: "harness-plan-reviewer" });
          if (decision.block) throw Error(decision.reason);
          const target = resolve(ctx.cwd, input.path);
          if (statSync(target).size > 262144) throw Error("File too large for advisory scoring; continue using code inspection and engineering judgment.");
          result = scorePlannedChange({ path: relative(ctx.cwd, target), responsibilities: input.responsibilities, source: readFileSync(target, "utf8"), whole_file: true });
        } catch (error) { result = { ok: false, advisory: true, reason: String(error) }; }
      }
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });
}
