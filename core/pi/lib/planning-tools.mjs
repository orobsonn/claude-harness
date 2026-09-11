/** Advisory planning evidence; never participates in plan approval. */
import { analyzeSource, looksBinary } from "../../claude-code/skills/creating-plans/references/complexity-scorer.mjs";

export const PLANNING_TOOLS = Object.freeze(["harness_complexity", "mv_recall", "mv_get_note", "mp_retrieve"]);
export const isPlanningRole = (role) => role === "harness-planner" || role === "harness-plan-reviewer";

export function scorePlannedChange(input = {}) {
  if (typeof input.source !== "string" || looksBinary(input.source)) return { ok: false, advisory: true, reason: "Supply source text for the planned change." };
  const result = analyzeSource(input.path || "planned-change.ts", input.source);
  const responsibilities = Array.isArray(input.responsibilities) ? input.responsibilities.filter((x) => typeof x === "string") : [];
  return { ...result, ok: true, advisory: true,
    basis: input.whole_file ? "whole-file-approximation" : "planned-change",
    limitation: input.whole_file ? "Approximation from the whole file, not the intended delta; use judgment about planned responsibilities." : "Heuristic over the supplied planned code; it cannot infer missing responsibilities or prove atomicity.",
    responsibilities,
    // Preserve CC scoring and should_split exactly; adapt its numeric task-count hint
    // to Pi's existing outcome/dependency contract, without imposing a task quota.
    split_hint: result.should_split ? `Evaluate independently testable outcomes/dependencies${responsibilities.length ? `: ${responsibilities.join("; ")}` : ""}. Keep a justified shared transaction/invariant atomic; decompose max/x-high work before approval.` : "" };
}

/** MP exposes code, including mutation. Construct one retrieval call from data, never model code. */
export async function planningRetrieval(name, input, call, signal) {
  const unavailable = { available: false, advisory: true, reason: "Planning retrieval unavailable; continue using spec, code and judgment." };
  if (typeof call !== "function") return unavailable;
  let server, tool, args;
  if (name === "mv_recall" && typeof input.query === "string" && input.query.trim()) {
    server = "mv"; tool = "recall"; args = { query: input.query, limit: 5 };
  } else if (name === "mv_get_note" && typeof input.id === "string" && input.id.trim()) {
    server = "mv"; tool = "get_note"; args = { id: input.id };
  } else if (name === "mp_retrieve") {
    const operation = input.operation;
    if (!["grep", "read", "ls", "glob"].includes(operation)) return unavailable;
    const params = operation === "grep" ? { pattern: input.query, path: input.path ?? "/", limit: 5 }
      : operation === "glob" ? { pattern: input.query, limit: 5 }
      : { path: input.path, limit: operation === "read" ? 200 : 5 };
    if (Object.values(params).some((v) => v === undefined)) return unavailable;
    server = "mp"; tool = "code";
    args = { code: `async () => await codemode.${operation}(${JSON.stringify(params)})` };
  } else return unavailable;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  let timer;
  try {
    if (signal?.aborted) return unavailable;
    return await Promise.race([
      Promise.resolve().then(() => call(server, tool, args, controller.signal)).then((result) => result?.isError || result?.details?.error ? unavailable : ({ available: true, advisory: true, result })),
      new Promise((resolve) => { timer = setTimeout(() => { controller.abort(); resolve(unavailable); }, 10000); }),
    ]);
  } catch { return unavailable; }
  finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}
