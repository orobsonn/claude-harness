/**
 * @description VPS cron harness — Cron A ENTRYPOINT (task-4), the single scheduled job. Flow:
 *   1. Acquire the per-project run-lock ATOMICALLY as the FIRST action, before any `gh` query —
 *      no TOCTOU window where two fires could both query the issue tracker unlocked. If a live
 *      lock is already held, exit without touching `gh`.
 *   2. Ensure the `harness:blocked` label exists (idempotent `gh label create harness:blocked
 *      --force`) before selecting any issue.
 *   3. Query open `harness:ready` issues, EXCLUDING any also carrying `harness:in-progress` or
 *      `harness:blocked`, and pick the OLDEST eligible one.
 *   4. No eligible issue -> release the lock and exit WITHOUT calling dispatch (a fire with no
 *      work is a no-op: no relabel, no dispatch).
 *   5. Otherwise relabel the picked issue `harness:ready` -> `harness:in-progress` BEFORE any
 *      worktree/session creation, then invoke cron-a-dispatch (task-5), handing it the chosen
 *      issue and the ALREADY-HELD run-lock handle acquire() returned — dispatch never re-acquires,
 *      it only does its phase-2 register().
 *
 * STUB — throws. Real implementation lands with the executor hand; this scaffold exists only so
 * cron-a-select.test.mjs (the frozen oracle) collects and runs RED.
 *
 * @param {object} opts - Injected seams: project, stateDir, runLock.{acquire,release}, gh,
 *   dispatch. See cron-a-select.test.mjs for the exact fake shapes this must satisfy.
 * @returns {{ ok: boolean, dispatched?: boolean, issue?: { number: number, labels: string[] } }}
 */
export function cronASelect(opts) {
  throw new Error("cronASelect: not implemented");
}
