/**
 * @description VPS memory guard — a pure, fail-open predicate that decides whether the runtime
 * has enough free memory to proceed with a dispatch, plus its default free-memory reader and
 * threshold constant. Import-only: consumed by cron-a-dispatch.mjs, never operator-run, so this
 * module has no CLI entry block.
 */

import os from "node:os";

/**
 * @description Best-effort per-process memory guard. Returns `true` (proceed) whenever the
 * inputs cannot be trusted to make a safe abort decision — a non-finite `freeBytes` reading
 * (unreadable / not yet sampled) or a disabled threshold (`thresholdBytes` <= 0 or non-finite) —
 * and only returns `false` (abort) when a genuine finite `freeBytes` reading (including a real
 * `0`) is below a genuine positive `thresholdBytes`. Fail-open is load-bearing: an unreadable
 * reading must never be treated as "not enough memory".
 *
 * Caveat: this is a best-effort, single-process optimization — it does NOT prevent cross-project
 * co-spawn (multiple unrelated projects racing to dispatch on the same host at once). Preventing
 * that would require a shared memory semaphore across projects, which is out of scope here.
 *
 * @param {{ freeBytes: number | null | undefined, thresholdBytes: number }} args
 * @returns {boolean} true to proceed with dispatch, false to abort (genuine near-OOM)
 */
export function hasEnoughFreeMemory({ freeBytes, thresholdBytes }) {
  if (!Number.isFinite(freeBytes)) return true;
  if (!Number.isFinite(thresholdBytes) || thresholdBytes <= 0) return true;
  return freeBytes >= thresholdBytes;
}

/**
 * @description Thin wrapper over `os.freemem()` — the only `node:os` consumer this module
 * introduces. Kept as a named export so callers can inject a fake reading in tests without
 * mocking `node:os` directly.
 * @returns {number} current free system memory, in bytes
 */
export function defaultFreeMem() {
  return os.freemem();
}

/**
 * @description Default free-memory threshold, in bytes: 768 MiB (805306368). The incident this
 * guard responds to failed at ~550 MB free; 768 MiB leaves margin above that danger zone.
 * Empirically, `os.freemem()` reports available-like memory on this VPS (~6.5 GB free on a
 * healthy host), so the guard is a no-op in the common case and only fires near genuine OOM.
 */
export const DEFAULT_MEM_GUARD_BYTES = 805306368;
