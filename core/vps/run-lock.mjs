/**
 * @description Scaffold stub for the VPS cron harness's single-runner lock. Every export
 * below is a throwing placeholder (`not implemented`) — this file exists only so
 * run-lock.test.mjs can import real named symbols and collect as RED. The executor hand
 * implements the real logic against the contract encoded in run-lock.test.mjs.
 *
 * Persisted holder record shape (JSON, on disk under opts.stateDir):
 *   { pid: number, acquire_ts: number, tmux_session_id?: string }
 * (tmux_session_id is absent until register() has been called.)
 */

/**
 * @description Attempts to acquire the run-lock, reclaiming a stale holder when appropriate.
 * Liveness precedence: once a holder has registered a tmux_session_id, liveness is decided by
 * opts.tmuxHasSession ALONE (the recorded pid is never consulted again). Before registration,
 * liveness is decided by opts.kill on the recorded pid, but only once
 * (opts.now() - holder.acquire_ts) >= opts.registration_grace_seconds — a holder still inside
 * its acquire->register window is never mistaken for dead.
 * @param {object} opts
 * @param {string} opts.stateDir - directory holding the lock file
 * @param {number} opts.pid - caller's own pid, recorded as holder on success
 * @param {() => number} opts.now - clock, returns epoch seconds
 * @param {(pid: number) => void} opts.kill - liveness probe; throws (e.g. ESRCH) when pid is dead
 * @param {(sessionId: string) => boolean} opts.tmuxHasSession - tmux liveness probe
 * @param {number} [opts.registration_grace_seconds] - grace window before an unregistered holder can be reclaimed (default 120)
 * @returns {{acquired: boolean, reclaimedStale?: boolean, acquireTs?: number}}
 */
export function acquire(opts) {
  throw new Error("not implemented");
}

/**
 * @description Attaches a tmux session id to the currently held lock's holder record.
 * @param {string} tmuxId
 * @param {object} opts
 * @param {string} opts.stateDir
 * @returns {void}
 */
export function register(tmuxId, opts) {
  throw new Error("not implemented");
}

/**
 * @description Releases the run-lock iff the recorded holder's acquire_ts matches
 * opts.acquireTs (ownership guard). Idempotent — does not throw when the lock is already absent.
 * @param {object} opts
 * @param {string} opts.stateDir
 * @param {number} opts.acquireTs
 * @returns {void}
 */
export function release(opts) {
  throw new Error("not implemented");
}

/**
 * @description Reads the persisted holder record for the run-lock.
 * @param {object} opts
 * @param {string} opts.stateDir
 * @returns {{pid: number, acquire_ts: number, tmux_session_id?: string} | null}
 */
export function readHolder(opts) {
  throw new Error("not implemented");
}
