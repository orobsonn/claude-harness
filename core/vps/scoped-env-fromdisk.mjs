#!/usr/bin/env node
/**
 * @description Scaffold stub for buildScopedEnvFromDisk (glue-1) — NOT YET IMPLEMENTED.
 * This is the disk-reading adapter that will read <projectRoot>/.dev.vars and
 * <homeDir>/.claude/.dev.vars, then delegate to the pure buildScopedEnv (./scoped-env.mjs).
 * See scoped-env-fromdisk.test.mjs for the pinned assertions this must satisfy.
 * @param {string} project - Target project identifier.
 * @param {object} [opts]
 * @param {string} [opts.projectRoot] - Path whose `.dev.vars` holds this project's own secrets.
 * @param {string} [opts.homeDir] - Path whose `.claude/.dev.vars` holds the global tokens.
 * @param {Record<string,string>} [opts.baseEnv] - Parent/base env (defaults to process.env).
 * @param {(path: string) => string} [opts.readFileSafe] - File-read seam; returns '' if absent.
 * @returns {Record<string,string>} The scoped env object to spawn the session with.
 */
export function buildScopedEnvFromDisk(project, opts = {}) {
  throw new Error("not implemented: buildScopedEnvFromDisk");
}
