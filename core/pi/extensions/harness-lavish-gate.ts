import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { lavishDenyReason } from "../../opencode/plugin/lib/lavish-command-decide.mjs";

/**
 * @description Pi lavish-command-gate — adaptador fino da mesma decisão pura da lane OC
 * (core/opencode/plugin/lib/lavish-command-decide.mjs, reusada integralmente por import, sem
 * cópia): nega dois subcomandos de `lavish-axi` que nunca devem rodar sob este harness — `share`
 * (publica o mockup do grill num host de terceiros, ht-ml.app, público por padrão) e
 * `setup hooks` (instala um hook de SessionStart que compete com o próprio entry-policy hook
 * deste harness). O grill/SKILL.md já proíbe os dois em prosa (ver
 * core/*\/skills/grill/references/lavish-usage.md) — esta extensão é o backstop técnico.
 *
 * Espelha a lane OC, onde este gate é um plugin próprio, separado do entry-gate. A peça `policy`
 * da lane Pi também nega os dois subcomandos (herdado do motor de core/codex/hooks/policy.mjs,
 * com outra frase) — cobertura sobreposta tolerada, como na lane Codex.
 *
 * O import da decisão pura é estático de propósito: `tool_call` do Pi é fail-CLOSED (docs
 * extensions.md — "tool_call errors block the tool"), então um import dinâmico dentro do handler
 * transformaria uma falha de resolução do módulo em bloqueio de TODO comando bash. Estático, a
 * falha acontece no load da extensão (fail-open, igual à OC, que importa na fábrica do plugin).
 */

/** @description Whether the Pi tool name is the shell/bash tool whose command must be checked. */
function isPiBashTool(toolName: unknown): boolean {
  if (typeof toolName !== "string") return false;
  const n = toolName.toLowerCase();
  return n === "bash" || n === "shell" || n.endsWith(".bash") || n.endsWith("_bash") || n.endsWith(".shell") || n.endsWith("_shell");
}

/** @description Extracts the shell command string from a Pi bash tool_call input, se presente. */
function piCommandOf(input: unknown): unknown {
  if (input === null || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  return record.command ?? record.cmd;
}

/** @description Thin Pi hook that blocks the two forbidden `lavish-axi` subcommands. */
export default function harnessLavishGate(pi: ExtensionAPI) {
  pi.on("tool_call", (event: any) => {
    if (!isPiBashTool(event?.toolName)) return;
    const reason = lavishDenyReason(piCommandOf(event?.input));
    if (reason) return { block: true, reason };
  });
}

/** @description Exposto apenas para o teste (evita reimplementar os fakes de tool_call). */
export const testApi = Object.freeze({ isPiBashTool, piCommandOf });
