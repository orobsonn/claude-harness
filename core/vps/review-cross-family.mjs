/**
 * @description VPS cross-family auto-merge eligibility gate (HR-2 + HR-9 / #ac-2.3).
 * `crossFamilyEligible(pr, opts)` is fail-open ONLY on a genuinely absent verdict artifact — no
 * verdict at all means Codex never produced a result (no subscription, switch off, unreachable,
 * stale head, empty diff — see run-cron-review.mjs's true-absence branches, which always pair
 * `available:false` with `secondFamilyVerdict:null`). This is a deliberate, accepted trade-off:
 * the operator's Codex budget does not sustain running it on every PR, and auto-merge should not
 * be permanently hostage to that (previously it was — #137 made this hard fail-closed). The
 * moment ANY verdict object exists, the original guarantee is unconditional and unchanged: a
 * non-CLEAN status always blocks, and a verdict paired with `available:false` (a suspicious or
 * stale-looking CLEAN — the anti-spoof guard) is never trusted either. This distinction matters
 * because run-cron-review.mjs's wiring can produce `available:false` together with a REAL
 * `BLOCKED` verdict (one Codex eye failed structurally while the other ran and found a problem —
 * `available = advOk && secOk` folds both eyes into one flag) — that case must still block, it is
 * not the same as genuine absence, even though both share `available:false`. Checking the verdict
 * BEFORE the availability flag is what keeps these two cases apart.
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
  const verdict = resolveVerdict(opts.secondFamilyVerdict, pr);
  if (!verdict) return true; // genuine absence — no artifact at all — fail-open (accepted trade-off)

  const isAvailable = resolveAvailable(opts.available);
  if (!isAvailable) return false; // a verdict exists but isn't trustworthy — never fail-open on this

  return verdict.status === "CLEAN";
}

/**
 * @description Classifies the codex SECURITY eye's FLAT `{available, verdict, issues}` view into
 * `absent` | `clean` | `concern`. Well-formedness is decided on FIELD STRUCTURE only, never on the
 * severity string. Takes no `securityVerdict` param, so the forbidden severity coupling is
 * structurally impossible.
 * @param {{available?: boolean, verdict?: string, issues?: unknown}} sec
 * @returns {"absent" | "clean" | "concern"}
 */
export function classifyCodexSecurityEye(sec) {
  throw new Error("not implemented");
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
