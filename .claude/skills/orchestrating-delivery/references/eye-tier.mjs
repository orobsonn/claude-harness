/**
 * @description Deterministic per-dispatch tier resolver for a per-task JUDGMENT EYE
 * (adversary). Change 1 (process-eye-routing) routes the per-task eye by BLAST RADIUS
 * instead of running opus everywhere, so a long delivery of mostly low/medium tasks
 * stops paying for opus at every checkpoint — while grave/high-severity tasks keep opus.
 *
 * The tier is a pure function of the task, so the routing is PROVABLE (a deterministic
 * rail), never left to the sonnet orchestrator's judgment — mirroring `hand_tiers` for
 * hands. The agent frontmatter default stays `opus`, so the two BOUNDARY gates
 * (upfront spec-adversary, final dual-review) need no override; this resolver produces
 * the per-dispatch override ONLY for the per-task eye.
 *
 * Rule (opus on grave; sonnet floor otherwise — never below sonnet, SKILL.md:62):
 *   boundary        -> opus   (highest-leverage boundary gate — never flexed down)
 *   sensitivePath   -> opus   (grave by construction — auth/payment/billing/sql/...)
 *   severity=high   -> opus   (severity IS the blast-radius axis; a HIGH-severity,
 *                              LOW-complexity task — one line, huge blast — is exactly
 *                              the case an AND-gate would wrongly drop to sonnet)
 *   otherwise       -> sonnet (the floor; an eye NEVER resolves to haiku or Ollama)
 *
 * Note the omission by design: complexity does NOT lower the tier below sonnet, and
 * there is no haiku branch — the trivial-end saving comes from the planner NOT enabling
 * the per-task adversary on a trivial task (`adversarial.enabled=false`), never from a
 * sub-sonnet rubber-stamp eye.
 */

/**
 * @typedef {Object} EyeTierInput
 * @property {boolean} [boundary]      True for the upfront spec-adversary or the final dual-review gate.
 * @property {boolean} [sensitivePath] True when the task's scope_paths hit the sensitive-path allowlist.
 * @property {"low"|"medium"|"high"|string} [severity] The task's blast-radius tier.
 */

/**
 * Resolves the Claude tier for a per-task judgment eye dispatch.
 * @param {EyeTierInput} input
 * @returns {"opus"|"sonnet"} A Claude tier — never haiku, never a non-Claude/Ollama id.
 */
export function resolveEyeTier({ boundary = false, sensitivePath = false, severity } = {}) {
  if (boundary === true) return "opus";
  if (sensitivePath === true) return "opus";
  // Normalize before comparing so 'High'/'HIGH'/' high ' can never misroute a grave task
  // DOWN to sonnet (the dangerous direction). The default-to-sonnet on an unknown severity is
  // only safe under the harness's fixed low|medium|high vocabulary — if severity aliases
  // (critical/P0/sev1) are ever introduced, map them here explicitly.
  if (typeof severity === "string" && severity.toLowerCase().trim() === "high") return "opus";
  return "sonnet";
}
