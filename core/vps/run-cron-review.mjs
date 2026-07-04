/**
 * @description Composition root of the independent PR-review phase: acquires a SEPARATE lock on the
 * review sub-stateDir, honors the kill switch + windowed circuit-breaker (notify on trip), drives
 * cronReview, drains, releases. Scaffold stub — replaced by the executor.
 */
export function runCronReview(config, deps = {}) {
  throw new Error("not implemented");
}
