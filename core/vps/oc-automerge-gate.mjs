/**
 * @description Pure fail-closed gate for OpenCode-driven auto-merge. For any config where the
 * effective runtime is not "opencode", short-circuits to `true` BEFORE any filesystem read — so the
 * generic Claude-family auto-merge path stays byte-identical to today (the gate is a no-op for it).
 * For OC-driven configs, reads the manually-maintained status mirror
 * `core/opencode/oc-automerge-preconditions.json` ({ T12, T13, T15 } booleans) and returns `true`
 * ONLY when all three are `true`. A not-green flag, a missing file, an unreadable/malformed file, or
 * a missing key returns `false` — default-deny, never default-allow.
 *
 * The effective runtime is resolved via `resolveRuntime(config)`, which defaults to "opencode" when
 * `runtime` is omitted, nullish, or invalid — matching the dispatch in `run-cron-a.mjs`.
 *
 * `deps` exists for testability — every unit test injects fakes instead of touching real disk.
 * @param {{ runtime?: string, driver?: string }} config
 * @param {{ existsSync?: Function, readFileSync?: Function, statusFilePath?: string }} [deps]
 * @returns {boolean}
 */
import { existsSync as realExistsSync, readFileSync as realReadFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRuntime } from "./resolve-runtime.mjs";

const DEFAULT_STATUS_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "opencode",
  "oc-automerge-preconditions.json"
);

export function ocAutoMergeGateOpen(config, deps = {}) {
  // Non-OC config: no-op gate, byte-identical generic auto-merge path. Short-circuit BEFORE any
  // filesystem read so the status file is never touched for Claude-family configs.
  if (resolveRuntime(config) !== "opencode") {
    return true;
  }

  const existsSync = deps.existsSync ?? realExistsSync;
  const readFileSync = deps.readFileSync ?? realReadFileSync;
  const statusFilePath = deps.statusFilePath ?? DEFAULT_STATUS_PATH;

  try {
    if (!existsSync(statusFilePath)) return false;
    const status = JSON.parse(readFileSync(statusFilePath, "utf8"));
    return status.T12 === true && status.T13 === true && status.T15 === true;
  } catch {
    // Unreadable or malformed JSON (or a thrown existsSync/readFileSync) — default-deny.
    // A missing key does not throw: `undefined === true` is false, so the conjunction above
    // already returns false without entering this block.
    return false;
  }
}