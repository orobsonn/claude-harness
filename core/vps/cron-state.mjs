/**
 * @description Scaffold stub for the VPS cron harness's per-issue attempt counter and
 * reviewed-SHA marker. Every export below is a throwing placeholder (`not implemented`) —
 * this file exists only so cron-state.test.mjs can import real named symbols and collect
 * as RED. The executor hand implements the real logic against the contract encoded in
 * cron-state.test.mjs.
 */

/**
 * @description Increments the attempt counter for the given issue.
 * @param {number} issue
 * @param {object} opts
 * @param {string} opts.stateDir
 * @returns {void}
 */
export function increment(issue, opts) {
  throw new Error("not implemented");
}

/**
 * @description Resets the attempt counter for the given issue back to 0.
 * @param {number} issue
 * @param {object} opts
 * @param {string} opts.stateDir
 * @returns {void}
 */
export function reset(issue, opts) {
  throw new Error("not implemented");
}

/**
 * @description Reads the current attempt counter for the given issue (0 if never incremented).
 * @param {number} issue
 * @param {object} opts
 * @param {string} opts.stateDir
 * @returns {number}
 */
export function read(issue, opts) {
  throw new Error("not implemented");
}

/**
 * @description Records that the given PR has been reviewed at the given head SHA.
 * @param {number} pr
 * @param {string} sha
 * @param {object} opts
 * @param {string} opts.stateDir
 * @returns {void}
 */
export function recordReviewed(pr, sha, opts) {
  throw new Error("not implemented");
}

/**
 * @description Returns whether the given PR has already been reviewed at the given head SHA.
 * @param {number} pr
 * @param {string} sha
 * @param {object} opts
 * @param {string} opts.stateDir
 * @returns {boolean}
 */
export function alreadyReviewed(pr, sha, opts) {
  throw new Error("not implemented");
}
