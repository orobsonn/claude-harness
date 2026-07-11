/**
 * @description Resolves the absolute `node --test <path>` command string for the Stop hook
 * injected into the ephemeral CLAUDE_CONFIG_DIR. Pure function — no side effects, no spawning.
 * The caller (spawn layer) writes the returned string into the ephemeral settings.json at runtime.
 *
 * Design contract (AC v2.3):
 * - Returns an ABSOLUTE `node --test <absolute-test-path>` string.
 * - NEVER uses `${CLAUDE_PROJECT_DIR}` — path is resolved at config-build time from cwd/configDir.
 * - Static test proves SHAPE only; runtime blocking is verified by the operator-gated demo.
 */

import { resolve, isAbsolute } from "node:path";
import { resolveRunnerAdapter, DEFAULT_RUNNER_ID } from "../runner-adapters.mjs";

/**
 * @description Builds the absolute Stop-hook command string for the selected runner adapter
 * (`runner-adapters.mjs`), to be injected into the ephemeral CLAUDE_CONFIG_DIR's settings.json.
 * `runnerId` defaults to `node-test`, so a project with no `.claude/hand-config/test-runner.json`
 * keeps the original `node --test` command unchanged. The Stop hook only needs the adapter's
 * exit code (pass/fail) — it never reads stdout — so the same adapter command used by the
 * pre-spawn dry-run and post-spawn capture is reused here unmodified (one command, one parser,
 * never three sources of truth).
 *
 * @param {string} configDir - Absolute path to the ephemeral config directory (part of the interface
 *   contract, but not used for path resolution; relative testPath is resolved from process.cwd()).
 * @param {string} testPath - Path to the frozen test file — relative (resolved from cwd) or absolute.
 * @param {string} [runnerId] - The selected test-runner adapter id (`runner-adapters.mjs`).
 * @returns {string} The fully-resolved Stop-hook command string. Contains no
 *   `${CLAUDE_PROJECT_DIR}` and no shell variable references.
 */
export function resolveHookCommand(configDir, testPath, runnerId = DEFAULT_RUNNER_ID) {
  // Resolve testPath to absolute.
  // If already absolute, isAbsolute returns true and resolve is a no-op.
  // If relative, resolve from process.cwd() (the project root at config-build time),
  // NOT from configDir — the test lives in the project tree, not inside the ephemeral dir.
  const absoluteTestPath = isAbsolute(testPath)
    ? testPath
    : resolve(process.cwd(), testPath);

  const { bin, args } = resolveRunnerAdapter(runnerId).buildCommand(absoluteTestPath);
  return [bin, ...args].join(" ");
}
