#!/usr/bin/env node
/**
 * @description Disk-reading adapter (glue-1) that wires the pure buildScopedEnv
 * (scoped-env.mjs) to real Cron-A dispatch. Reads the target project's own
 * `.dev.vars` and the global `~/.claude/.dev.vars` from disk, then delegates the
 * allowlist composition to buildScopedEnv. A missing file (readFileSafe returns
 * '') is tolerated — it never throws.
 */

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { buildScopedEnv } from "./scoped-env.mjs";

/**
 * @description Default readFileSafe: reads a file synchronously and returns its
 * UTF-8 text, or '' on ENOENT (missing file). Any other read error also degrades
 * to '' rather than throwing — the adapter must never crash a dispatch over an
 * unreadable vars file.
 * @param {string} path - Absolute file path to read.
 * @returns {string} File content, or '' if missing/unreadable.
 */
function defaultReadFileSafe(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/**
 * @description Builds the scoped env for a project's `claude -p` parent session
 * by reading the project's `.dev.vars` and the global `~/.claude/.dev.vars` from
 * disk, then delegating to buildScopedEnv for the allowlist composition.
 * @param {string} project - Target project identifier.
 * @param {object} [opts]
 * @param {string} [opts.projectRoot] - Absolute path to the project root (where
 *   its `.dev.vars` lives).
 * @param {string} [opts.homeDir] - Absolute path to the operator's home dir
 *   (where `~/.claude/.dev.vars` lives).
 * @param {Record<string,string>} [opts.baseEnv] - Base env to start from;
 *   defaults to process.env. Not blindly inherited — only PATH/HOME carry
 *   through (see scoped-env.mjs).
 * @param {(path: string) => string} [opts.readFileSafe] - Safe file reader that
 *   returns '' on ENOENT; defaults to a synchronous safe reader.
 * @returns {Record<string,string>} The scoped env object to spawn the session with.
 */
export function buildScopedEnvFromDisk(project, opts = {}) {
  const {
    projectRoot,
    homeDir,
    baseEnv = process.env,
    readFileSafe = defaultReadFileSafe,
  } = opts;

  const projectText = readFileSafe(join(projectRoot, ".dev.vars"));
  const globalText = readFileSafe(join(homeDir, ".claude", ".dev.vars"));

  return buildScopedEnv(project, {
    baseEnv,
    projectDevVars: { [project]: projectText },
    claudeDevVarsContent: globalText,
  });
}