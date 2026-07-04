/**
 * @description Machine-origin gate for the independent PR-review phase. Decides whether a PR is
 * eligible for the harness's autonomous review path. This module is SELF-CONTAINED: it owns its
 * own author-gate and branch-prefix constants and never imports private symbols from cron-b.mjs.
 * It is the single origin-eligibility source the review composition consumes.
 *
 * Positive machine-origin signal REQUIRED:
 *   PRIMARY   — branch harness/* (author match alone suffices)
 *   SECONDARY — label harness:autoreview ONLY together with author == authenticated gh-user
 *               AND an engine-known cross-check (engineKnows(pr) returns true)
 *
 * Author must equal the authenticated gh user (never author-only).
 * A human WIP on fix/* is never touched.
 *
 * HR-6 / #ac-5.1
 */

/** @description Head-branch prefix marking a harness-originated PR (primary machine-origin signal). */
const HARNESS_BRANCH_PREFIX = "harness/";

/** @description Head-branch prefix marking a human WIP — never touched by the review phase. */
const HUMAN_WIP_PREFIX = "fix/";

/** @description Label name for the secondary machine-origin signal. */
const AUTOREVIEW_LABEL = "harness:autoreview";

/**
 * @description Resolves the authenticated-user value from opts — accepts either a plain string or
 * a zero-arg function returning a string (for lazy resolution at call time).
 * @param {string|(() => string)} authenticatedUser
 * @returns {string}
 */
function resolveUser(authenticatedUser) {
  if (typeof authenticatedUser === "function") {
    return authenticatedUser();
  }
  return authenticatedUser;
}

/**
 * @description True when the PR's author login matches the authenticated gh-user (case-insensitive).
 * @param {{author?: {login?: string}}} pr
 * @param {string} authenticatedUser
 * @returns {boolean}
 */
function isAuthenticatedAuthor(pr, authenticatedUser) {
  const expected = authenticatedUser.toLowerCase();
  const author = pr && pr.author;
  if (author && typeof author === "object" && typeof author.login === "string") {
    return author.login.toLowerCase() === expected;
  }
  return false;
}

/**
 * @description True when the PR carries the harness:autoreview label.
 * @param {{labels?: Array<{name?: string}>}} pr
 * @returns {boolean}
 */
function hasAutoreviewLabel(pr) {
  const labels = pr && pr.labels;
  if (!Array.isArray(labels)) return false;
  return labels.some(
    (l) => l && typeof l === "object" && l.name === AUTOREVIEW_LABEL
  );
}

/**
 * @description Machine-origin gate — the single eligibility source for the review composition.
 * Returns true only when a positive machine-origin signal is present AND the author matches the
 * authenticated gh-user. Human WIP on fix/* is never eligible.
 *
 * @param {{number: number, headRefName: string, author?: {login?: string}, labels?: Array<{name?: string}>}} pr
 *   PR object shaped like `gh pr view --json number,headRefName,author,labels` output.
 * @param {{authenticatedUser: string|(() => string), engineKnows: (pr: object) => boolean}} opts
 *   - `authenticatedUser`: the gh-user login string, or a zero-arg fn returning it.
 *   - `engineKnows(pr)`: returns whether the PR maps to a harness issue/branch the engine dispatched.
 * @returns {boolean}
 */
export function isReviewEligible(pr, opts) {
  const authenticatedUser = resolveUser(opts.authenticatedUser);

  // Author must match the authenticated gh-user — never author-only.
  if (!isAuthenticatedAuthor(pr, authenticatedUser)) {
    return false;
  }

  const headRefName = pr && typeof pr.headRefName === "string" ? pr.headRefName : "";

  // Human WIP on fix/* is never touched.
  if (headRefName.startsWith(HUMAN_WIP_PREFIX)) {
    return false;
  }

  // PRIMARY signal: branch harness/* — author match alone suffices.
  if (headRefName.startsWith(HARNESS_BRANCH_PREFIX)) {
    return true;
  }

  // SECONDARY signal: harness:autoreview label + engine-known cross-check.
  if (hasAutoreviewLabel(pr) && opts.engineKnows(pr)) {
    return true;
  }

  return false;
}
