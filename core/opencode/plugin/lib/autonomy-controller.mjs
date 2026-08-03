/** @description Pure recognition and phase projection for OpenCode autonomous delivery. */

const AUTONOMY_PATTERNS = [
  /\b(?:siga|continue|prossiga|avance|rode|roda)\b[\s\S]{0,48}\b(?:aut[oô]nom|implementa[cç][aã]o|entrega|finaliz)/i,
  /\b(?:n[aã]o|nao)\s+(?:pare|me\s+pergunte|perguntar)\b/i,
  /\bsem\s+(?:parar|me\s+perguntar|perguntas)\b/i,
  /\bat[eé]\s+(?:entregar|finalizar|terminar)\b/i,
];

/** @description True when an operator delegates the current engineering delivery loop. */
export function detectsAutonomyDirective(value) {
  if (typeof value !== "string") return false;
  return AUTONOMY_PATTERNS.some((pattern) => pattern.test(value));
}

/** @description Extract the strict plan-reviewer verdict from the first JSON object in a report. */
export function readPlanReviewVerdict(value) {
  if (typeof value !== "string") return null;
  const start = value.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const char = value[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth !== 0) continue;
      try {
        const parsed = JSON.parse(value.slice(start, index + 1));
        const verdict = typeof parsed?.verdict === "string" ? parsed.verdict.trim().toUpperCase() : "";
        return verdict === "APPROVE" || verdict === "REVISE" ? verdict : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** @description Derive one next legal delivery phase without creating a second workflow engine. */
export function decideAutonomyContinuation(state) {
  if (!state || typeof state !== "object" || Array.isArray(state) || state.autonomy_directive !== "enabled") {
    return { action: "none", reason: "disabled" };
  }
  if (state.session_status === "completed") return { action: "none", reason: "completed" };
  if (state.product_decision_pending === true) return { action: "none", reason: "product-decision" };
  if (state.classified !== true) return { action: "none", reason: "unclassified" };
  if (state.planner_status !== "usable") return { action: "continue", phase: "planner-recovery" };
  if (state.plan_review_verdict === "REVISE") return { action: "continue", phase: "plan-revision" };
  if (state.plan_review_verdict !== "APPROVE") return { action: "continue", phase: "plan-review" };
  if (state.final_review_done !== true) return { action: "continue", phase: "delivery-loop" };
  return { action: "continue", phase: "delivery-close" };
}

/** @description Fixed continuation instruction; it delegates only the already-authorized delivery loop. */
export function autonomyContinuationPrompt(phase) {
  const action = {
    "planner-recovery": "Repair or complete the planner lifecycle through its existing bounded rail before any downstream dispatch.",
    "plan-review": "Dispatch the required plan-reviewer now. Do not implement before its APPROVE verdict is recorded.",
    "plan-revision": "Use the recorded plan-review result to re-dispatch planner, then re-run plan review through the existing rail.",
    "delivery-loop": "Resume the next mandatory phase of the approved delivery loop. Dispatch the lawful hand or eye; do not skip fidelity, capture, review, or deterministic gates.",
    "delivery-close": "Finish the remaining autonomous demo, harvest, and authorized delivery steps through their existing rails.",
  }[phase] ?? "Resume the next mandatory phase of the approved delivery loop.";
  return [
    "[HARNESS_AUTONOMY_CONTINUE]",
    "Autonomy is active for this already-classified feature.",
    action,
    "Do not emit an acknowledgement, status update, or question about engineering. Execute the next lawful action now.",
    "Do not stop before the next lawful action. Stop only for an unresolved product decision that changes the delivered user behavior or after the delivery rails are terminal.",
  ].join("\n");
}

/**
 * @description Normalize the operator-selected session model used by autonomy continuation.
 * OpenCode's promptAsync falls back to the agent frontmatter model when body.model is omitted —
 * that silently overwrites a live operator override (e.g. grok → gpt-5.6-terra on build).
 * @param {unknown} value
 * @returns {{ providerID: string, modelID: string, variant?: string } | null}
 */
export function normalizeOperatorSessionModel(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = /** @type {Record<string, unknown>} */ (value);
  const providerID = typeof record.providerID === "string" ? record.providerID.trim() : "";
  const modelID = typeof record.modelID === "string" ? record.modelID.trim() : "";
  if (!providerID || !modelID || providerID.includes("/") || modelID.includes("..")) return null;
  /** @type {{ providerID: string, modelID: string, variant?: string }} */
  const out = { providerID, modelID };
  if (typeof record.variant === "string" && record.variant.trim()) {
    out.variant = record.variant.trim();
  }
  return out;
}

/**
 * @description Fields that pin promptAsync to the operator's live model instead of agent defaults.
 * @param {unknown} operatorModel
 * @returns {{ model: { providerID: string, modelID: string }, agent: "build", variant?: string } | Record<string, never>}
 */
export function continuationPromptModelFields(operatorModel) {
  const model = normalizeOperatorSessionModel(operatorModel);
  if (!model) return {};
  /** @type {{ model: { providerID: string, modelID: string }, agent: "build", variant?: string }} */
  const fields = {
    model: { providerID: model.providerID, modelID: model.modelID },
    agent: "build",
  };
  if (model.variant) fields.variant = model.variant;
  return fields;
}

/**
 * @description Prefer the gate-state snapshot; else the last non-continuation user message model.
 * @param {{ operatorModel?: unknown, messages?: unknown }} input
 * @returns {{ providerID: string, modelID: string, variant?: string } | null}
 */
export function resolveContinuationSessionModel(input) {
  const fromState = normalizeOperatorSessionModel(input?.operatorModel);
  if (fromState) return fromState;
  if (!Array.isArray(input?.messages)) return null;
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    const bundle = input.messages[index];
    const info = bundle && typeof bundle === "object" ? /** @type {Record<string, unknown>} */ (bundle).info ?? bundle : null;
    if (!info || typeof info !== "object" || Array.isArray(info)) continue;
    const record = /** @type {Record<string, unknown>} */ (info);
    if (record.role !== "user") continue;
    const parts = Array.isArray(/** @type {Record<string, unknown>} */ (bundle)?.parts)
      ? /** @type {unknown[]} */ (/** @type {Record<string, unknown>} */ (bundle).parts)
      : [];
    const text = parts
      .map((part) => (part && typeof part === "object" && typeof /** @type {Record<string, unknown>} */ (part).text === "string"
        ? /** @type {string} */ (/** @type {Record<string, unknown>} */ (part).text)
        : ""))
      .join("\n");
    if (text.includes("[HARNESS_AUTONOMY_CONTINUE]")) continue;
    const model = record.model && typeof record.model === "object" && !Array.isArray(record.model)
      ? /** @type {Record<string, unknown>} */ (record.model)
      : record;
    const normalized = normalizeOperatorSessionModel({
      providerID: model.providerID,
      modelID: model.modelID ?? model.id,
      variant: record.variant ?? model.variant,
    });
    if (normalized) return normalized;
  }
  return null;
}
