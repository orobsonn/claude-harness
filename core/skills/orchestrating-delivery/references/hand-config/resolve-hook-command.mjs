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

/**
 * @description Resolves the node binary absolute path for the current runtime.
 * @returns {string} Absolute path to the node executable.
 */
function resolveNodeBin() {
  // process.execPath is the absolute path of the running Node.js binary.
  return process.execPath;
}

/**
 * @description Builds the absolute `node --test <absolute-test-path>` command string
 * to be injected as the Stop-hook command in the ephemeral CLAUDE_CONFIG_DIR's settings.json.
 *
 * @param {string} configDir - Absolute path to the ephemeral config directory (part of the interface
 *   contract, but not used for path resolution; relative testPath is resolved from process.cwd()).
 * @param {string} testPath - Path to the frozen test file — relative (resolved from cwd) or absolute.
 * @returns {string} The fully-resolved `<node> --test <absolute-test-path>` command string.
 *   Contains no `${CLAUDE_PROJECT_DIR}` and no shell variable references.
 */
export function resolveHookCommand(configDir, testPath) {
  const nodeBin = resolveNodeBin();

  // Resolve testPath to absolute.
  // If already absolute, isAbsolute returns true and resolve is a no-op.
  // If relative, resolve from process.cwd() (the project root at config-build time),
  // NOT from configDir — the test lives in the project tree, not inside the ephemeral dir.
  const absoluteTestPath = isAbsolute(testPath)
    ? testPath
    : resolve(process.cwd(), testPath);

  return `${nodeBin} --test ${absoluteTestPath}`;
}
