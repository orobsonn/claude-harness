/**
 * @description VPS cross-family auto-merge eligibility gate (HR-2 + HR-9 / #ac-2.3).
 * `crossFamilyEligible(pr, opts)` is a POSITIVE assertion: auto-merge eligibility requires the
 * second-family (Codex/GPT) verdict artifact to EXIST and be CLEAN. Any absence — unavailable,
 * missing/null verdict, or a non-CLEAN status — returns false (fail-closed), routing the caller
 * to harness:awaiting-merge. Never derive eligibility from a fail-open "Claude ran ok" signal.
 * `opts.available` and `opts.secondFamilyVerdict` are injected seams (boolean or zero/one-arg fn)
 * so this module never hard-imports the gitignored codex driver.
 */

/**
 * @param {boolean | (() => boolean)} available
 * @returns {boolean}
 */
function resolveAvailable(available) {
  return typeof available === "function" ? Boolean(available()) : Boolean(available);
}

/**
 * @param {{status?: string} | null | ((pr: unknown) => ({status?: string} | null))} secondFamilyVerdict
 * @param {unknown} pr
 * @returns {{status?: string} | null}
 */
function resolveVerdict(secondFamilyVerdict, pr) {
  const verdict = typeof secondFamilyVerdict === "function" ? secondFamilyVerdict(pr) : secondFamilyVerdict;
  return verdict ?? null;
}

/**
 * @param {unknown} pr
 * @param {{available: boolean | (() => boolean), secondFamilyVerdict: ({status?: string} | null) | ((pr: unknown) => ({status?: string} | null))}} opts
 * @returns {boolean}
 */
export function crossFamilyEligible(pr, opts) {
  const isAvailable = resolveAvailable(opts.available);
  if (!isAvailable) return false;

  const verdict = resolveVerdict(opts.secondFamilyVerdict, pr);
  if (!verdict) return false;

  return verdict.status === "CLEAN";
}

/**
 * @description Scaffold stub — replaced by the executor with the real RD-1 implementation.
 */
export function deriveSecondFamilyVerdict() {
  throw new Error("deriveSecondFamilyVerdict not implemented");
}
