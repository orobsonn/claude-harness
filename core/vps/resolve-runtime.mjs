/**
 * @description Resolves the effective runtime for a VPS cron project config.
 * Returns "opencode" (config default) when omitted, nullish, or invalid.
 * Accepts only literal "claude" or "opencode"; else falls back to "opencode".
 * Pure, never throws. Threaded by run-cron-a into dispatch (review path fixed claude).
 */
export function resolveRuntime(config) {
  const r = config && config.runtime;
  if (r === "claude" || r === "opencode") {
    return r;
  }
  return "opencode";
}
