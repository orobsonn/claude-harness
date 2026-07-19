/** @description Pure authority for who may call classify — top-level build only. Never throws. */

/**
 * @description Decide whether a classify call is allowed.
 * Hands/eyes/child sessions must never start ceremony — only the top-level `build` primary.
 *
 * @param {{
 *   agent?: unknown,
 *   parentSessionId?: unknown,
 *   sessionId?: unknown,
 * }} input
 * @returns {{ ok: true, reason: string } | { ok: false, reason: string }}
 */
export function decideClassifyAuthority(input = {}) {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return { ok: false, reason: "invalid classify authority input" };
    }

    const parent =
      typeof input.parentSessionId === "string" ? input.parentSessionId.trim() : "";
    if (parent) {
      return {
        ok: false,
        reason:
          "classify denied on child session — only the top-level build session may classify; hands/eyes execute their brief only",
      };
    }

    const agentRaw =
      typeof input.agent === "string"
        ? input.agent.trim()
        : typeof input.agentName === "string"
          ? input.agentName.trim()
          : "";
    // Empty agent: allow only when no parent (host may not surface agent on every path).
    // When agent is known, it must be exactly build.
    if (agentRaw) {
      const agent = agentRaw.toLowerCase().replace(/\.md$/, "");
      if (agent !== "build") {
        return {
          ok: false,
          reason: `classify denied for agent '${agentRaw}' — only build (top-level) may classify; this agent must execute its brief only`,
        };
      }
    }

    return { ok: true, reason: "classify-authority-allow" };
  } catch {
    return { ok: false, reason: "classify authority check failed" };
  }
}

export default { decideClassifyAuthority };
