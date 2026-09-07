/**
 * @description OC lavish-command-gate — deterministic deny for two `lavish-axi` subcommands that
 * must never run from this harness: `share` (publishes the grill mockup to a third-party host,
 * ht-ml.app, public by default) and `setup hooks` (installs a SessionStart hook that competes
 * with this harness's own entry-policy hook). grill's SKILL.md already prohibits both in prose
 * (see core/opencode/skills/grill/references/lavish-usage.md) — this plugin is the technical
 * backstop, since `build`'s local bash is generally permitted and prose alone is not a gate.
 *
 * Deliberately its own plugin file (mirrors the existing pattern of many independent single-
 * purpose plugins in this directory: plan-write-gate.ts, agent-idle-nudge.ts, ...)
 * rather than folding into entry-gate.ts's decideBashDelivery — that function is delivery-
 * pipeline ceremony (branch/regate/capture rails), a different concern from a narrow third-
 * party-CLI command deny. tool.execute.before: deny throws `[lavish-command-gate]` (OC contract
 * — a thrown Error blocks the tool call, not the session). Dynamic import of pure mjs (OC load
 * contract, mirrors plan-write-gate.ts).
 */
import type { Plugin, Hooks } from "@opencode-ai/plugin";

/** @description Whether tool is a shell command whose command string must be checked. */
function isBashTool(name: unknown): boolean {
  if (typeof name !== "string") return false;
  const n = name.toLowerCase();
  return n === "bash" || n === "shell" || n.endsWith(".bash") || n.endsWith("_bash") || n.endsWith(".shell") || n.endsWith("_shell");
}

/**
 * @description Builds the lavish-command-gate hook (async load of pure lavishDenyReason).
 */
async function createLavishCommandGateHooks(): Promise<Pick<Hooks, "tool.execute.before">> {
  const { lavishDenyReason } = await import("./lib/lavish-command-decide.mjs");
  const { resolveHookArgs } = await import("../lib/obs-emit.mjs");

  return {
    "tool.execute.before": async (input: any, output: any) => {
      if (!isBashTool(input?.tool)) return;
      const args = resolveHookArgs(input, output);
      const command = args?.command ?? args?.cmd;
      const reason = lavishDenyReason(command);
      if (reason) throw new Error(reason);
    },
  };
}

/**
 * @description OpenCode plugin factory — named const + default (OC load contract).
 */
export const LavishCommandGate: Plugin = async () => {
  return createLavishCommandGateHooks();
};
Object.defineProperty(LavishCommandGate, "testApi", { value: Object.freeze({ createLavishCommandGateHooks }) });

/** @description OC load contract — default export required. */
export default LavishCommandGate;
