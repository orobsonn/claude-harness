/** @description Pure classification of planner task results into usable plans, provider failures, or invalid plans. */

import { validatePlan } from "../../../shared/lib/validate-plan.mjs";

function responseText(value) {
  try {
    if (typeof value === "string") return value;
    return JSON.stringify(value ?? "");
  } catch {
    return String(value ?? "");
  }
}

function jsonObjects(text) {
  const candidates = [];
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) candidates.push(match[1]);
  candidates.push(text);

  const parsed = [];
  for (const candidate of candidates) {
    try {
      parsed.push(JSON.parse(candidate.trim()));
      continue;
    } catch {
      // Planner replies may append a summary after the JSON object.
    }
    let start = -1;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let i = 0; i < candidate.length; i += 1) {
      const char = candidate[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === "{") {
        if (depth === 0) start = i;
        depth += 1;
      } else if (char === "}" && depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          try {
            parsed.push(JSON.parse(candidate.slice(start, i + 1)));
          } catch {
            // Keep scanning for another complete object.
          }
          start = -1;
        }
      }
    }
  }
  return parsed;
}

/**
 * @description A planner succeeds only with a structurally valid full plan containing at least one task.
 * @param {unknown} response
 * @returns {{ kind: "usable_plan", plan: Record<string, unknown> } | { kind: "invalid_plan", errors: string[] }}
 */
export function classifyPlannerResult(response) {
  try {
    const text = responseText(response);
    const objects = jsonObjects(text);
    let validationErrors = [];
    for (const value of objects) {
      const validated = validatePlan(value, { expect: "full" });
      if (validated.ok && Array.isArray(value.tasks) && value.tasks.length >= 1) {
        return { kind: "usable_plan", plan: value };
      }
      validationErrors = validated.errors;
    }

    return {
      kind: "invalid_plan",
      errors: validationErrors.length > 0 ? validationErrors : ["planner returned no parseable full plan"],
    };
  } catch {
    return { kind: "invalid_plan", errors: ["planner result classification failed"] };
  }
}

/**
 * @description Classify only a structured task-error boundary. Provider-looking prose is never accepted here.
 * @param {unknown} error
 * @returns {{ kind: "provider_failure"|"execution_failure", failureClass: string }}
 */
export function classifyPlannerBoundaryError(error) {
  const text = responseText(error);
  const statusRaw = error && typeof error === "object"
    ? error.statusCode ?? error.status ?? error.data?.statusCode ?? error.data?.status
    : undefined;
  const status = Number(statusRaw ?? text.match(/\b([45]\d\d)\b/)?.[1]);
  if (Number.isFinite(status)) {
    if (status === 401 || status === 403) return { kind: "provider_failure", failureClass: "auth" };
    if (status === 402 || status === 429) return { kind: "provider_failure", failureClass: "credit" };
    if (status === 408 || status === 504) return { kind: "provider_failure", failureClass: "timeout" };
    if (status === 500 || status === 502 || status === 503 || (status >= 505 && status <= 599)) {
      return { kind: "provider_failure", failureClass: "provider" };
    }
    return { kind: "execution_failure", failureClass: "execution" };
  }
  if (/\b(?:unauthori[sz]ed|authentication failed|invalid api key|login required|not authenticated|providerautherror)\b/i.test(text)) {
    return { kind: "provider_failure", failureClass: "auth" };
  }
  if (/\b(?:insufficient (?:credits?|balance)|credits? exhausted|billing limit|quota exceeded|payment required|rate limit)\b/i.test(text)) {
    return { kind: "provider_failure", failureClass: "credit" };
  }
  if (/\b(?:timed? out|timeout|deadline exceeded|request aborted|messageabortederror|gateway timeout)\b/i.test(text)) {
    return { kind: "provider_failure", failureClass: "timeout" };
  }
  if (
    /\b(?:provider unavailable|provider failure|service unavailable|bad gateway|econnreset|econnrefused|connection refused)\b/i.test(text)
  ) {
    return { kind: "provider_failure", failureClass: "provider" };
  }
  return { kind: "execution_failure", failureClass: "execution" };
}

export default { classifyPlannerBoundaryError, classifyPlannerResult };
