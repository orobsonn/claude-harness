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
 * @description Pure RD-1 second-family verdict folder. Folds the codex adversary + security eye
 * outputs into a single `{ status }` verdict object using the injected `securityVerdict` seam.
 * Fail-closed: CLEAN requires both eyes present AND both judged SECURE; any missing eye or any
 * non-SECURE judgement yields BLOCKED, never a false CLEAN. Does no I/O, no spawning, and does not
 * import the optional codex driver.
 *
 * @param {{adversary: {available?: boolean, issues: unknown[]}|null, security: {available?: boolean, issues: unknown[]}|null}} codexEyes
 *   Each eye is `{available?: boolean, issues: unknown[]}`. `available === false` means the eye
 *   never ran and is treated as absent (fail-closed). A missing `available` field counts as present.
 * @param {{securityVerdict: (issues: unknown[]) => string}} opts
 * @returns {{status: "CLEAN" | "BLOCKED"}}
 */
export function deriveSecondFamilyVerdict(codexEyes, { securityVerdict }) {
  const adversary = codexEyes?.adversary;
  const security = codexEyes?.security;

  const present = (e) => Boolean(e) && e.available !== false && Array.isArray(e.issues);
  if (!present(adversary) || !present(security)) {
    return { status: "BLOCKED" };
  }

  const adversaryClean = securityVerdict(adversary.issues) === "SECURE";
  const securitySecure = securityVerdict(security.issues) === "SECURE";

  return { status: adversaryClean && securitySecure ? "CLEAN" : "BLOCKED" };
}
