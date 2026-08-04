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
  // no-ceremony / QUICK have no multi-phase plan loop for the idle motor to drive
  if (state.mode === "no-ceremony" || state.mode === "QUICK") {
    return { action: "none", reason: "mode-without-delivery-loop" };
  }
  if (state.planner_status !== "usable") return { action: "continue", phase: "planner-recovery" };
  if (state.plan_review_verdict === "REVISE") return { action: "continue", phase: "plan-revision" };
  if (state.plan_review_verdict !== "APPROVE") return { action: "continue", phase: "plan-review" };
  // final_review_done is the last host-stamped engineering tick the idle motor trusts;
  // harvest/ship stay same-turn prose after mark final-review — do not re-prompt forever
  if (state.final_review_done === true) return { action: "none", reason: "final-review-done" };
  return { action: "continue", phase: "delivery-loop" };
}

/** @description Fixed continuation instruction; it delegates only the already-authorized delivery loop. */
export function autonomyContinuationPrompt(phase) {
  const action = {
    "planner-recovery": "Repair or complete the planner lifecycle through its existing bounded rail before any downstream dispatch.",
    "plan-review": "Dispatch the required plan-reviewer now. Do not implement before its APPROVE verdict is recorded.",
    "plan-revision": "Use the recorded plan-review result to re-dispatch planner, then re-run plan review through the existing rail.",
    "delivery-loop": "Resume the next mandatory phase of the approved delivery loop. Dispatch the lawful hand or eye; do not skip fidelity, capture, review, or deterministic gates. After mark final-review, finish autonomous demo validation, harvest, and authorized delivery in this same turn before idle — the motor will not re-prompt once final_review_done is stamped.",
  }[phase] ?? "Resume the next mandatory phase of the approved delivery loop.";
  return [
    "[HARNESS_AUTONOMY_CONTINUE]",
    "Autonomy is active for this already-classified feature.",
    action,
    "Do not emit an acknowledgement, status update, or question about engineering. Execute the next lawful action now.",
    "Do not stop before the next lawful action. Stop only for an unresolved product decision that changes the delivered user behavior, or once final_review_done is stamped (then finish harvest/ship in-turn if still open).",
  ].join("\n");
}

/**
 * @description Operator model from a chat.message hook input — whatever they are already using.
 * @param {unknown} model
 * @param {unknown} [variant]
 * @returns {{ providerID: string, modelID: string, variant?: string } | null}
 */
export function readOperatorModel(model, variant) {
  if (!model || typeof model !== "object" || Array.isArray(model)) return null;
  const providerID = typeof model.providerID === "string" ? model.providerID.trim() : "";
  const modelID = typeof model.modelID === "string" ? model.modelID.trim() : "";
  if (!providerID || !modelID) return null;
  /** @type {{ providerID: string, modelID: string, variant?: string }} */
  const out = { providerID, modelID };
  const resolvedVariant = typeof variant === "string" ? variant : model.variant;
  if (typeof resolvedVariant === "string" && resolvedVariant.trim()) out.variant = resolvedVariant.trim();
  return out;
}
