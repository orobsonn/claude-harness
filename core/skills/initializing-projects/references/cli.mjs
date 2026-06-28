#!/usr/bin/env node
/**
 * @description Thin CLI wrapper for `npx claude-harness init` that vendors the harness.
 *
 * Delegates to vendor-core.mjs for the actual vendoring. Node builtins only.
 * Usage: npx claude-harness init
 */

import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const SOURCE_URL = "https://github.com/orobsonn/claude-harness.git";

/**
 * @description Parses the command from argv.
 * @param {string[]} argv - The process.argv-shaped array.
 * @returns {{ command: string | undefined }} The parsed command.
 */
export function parseCliArgs(argv) {
  return { command: argv[2] };
}

/**
 * @description Runs the init command by resolving the latest tag and running the vendor.
 * @param {object} options - The options.
 * @param {string} options.cwd - The current working directory.
 * @param {() => string | null} options.resolveTag - Function to resolve the latest tag.
 * @param {(opts: { source: string, ref: string, target: string }) => void} options.runVendor - Function to run the vendor.
 * @returns {string} The resolved tag.
 */
export function runInit({ cwd, resolveTag, runVendor }) {
  const tag = resolveTag();
  if (!tag) {
    throw new Error(
      "claude-harness: could not resolve the latest release tag from " +
        SOURCE_URL +
        " (need network + gh or curl). Aborting — refusing to vendor an unpinned ref."
    );
  }
  runVendor({ source: SOURCE_URL, ref: tag, target: cwd });
  return tag;
}

/**
 * @description Resolves the latest release tag from GitHub.
 * @returns {string | null} The latest tag or null on failure.
 */
function resolveLatestTag() {
  try {
    return execFileSync(
      "gh",
      [
        "release",
        "view",
        "--repo",
        "orobsonn/claude-harness",
        "--json",
        "tagName",
        "-q",
        ".tagName",
      ],
      {
        stdio: ["pipe", "pipe", "ignore"],
        timeout: 5000,
        encoding: "utf8",
      }
    ).trim();
  } catch {
    try {
      const json = execFileSync(
        "curl",
        ["-fs", "--max-time", "5", "https://api.github.com/repos/orobsonn/claude-harness/releases/latest"],
        {
          stdio: ["pipe", "pipe", "ignore"],
          timeout: 5000,
          encoding: "utf8",
        }
      );
      return JSON.parse(json).tag_name.trim();
    } catch {
      return null;
    }
  }
}

/**
 * @description Default vendor runner that delegates to vendor-core.mjs.
 * @param {object} options - The vendor options.
 * @param {string} options.source - The source URL.
 * @param {string} options.ref - The git ref.
 * @param {string} options.target - The target directory.
 */
function runVendorDefault({ source, ref, target }) {
  const here = dirname(fileURLToPath(import.meta.url));
  const vendorCorePath = join(here, "vendor-core.mjs");
  execFileSync(process.execPath, [vendorCorePath, "--source", source, "--ref", ref, "--target", target], {
    stdio: "inherit",
  });
}

// ---------- main (runs only when invoked directly as a script) ----------

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { command } = parseCliArgs(process.argv);
  if (command !== "init") {
    process.stderr.write("Usage: npx claude-harness init\n");
    process.exit(1);
  }

  try {
    const tag = runInit({
      cwd: process.cwd(),
      resolveTag: resolveLatestTag,
      runVendor: runVendorDefault,
    });
    process.stdout.write(
      `[claude-harness] vendored harness ${tag} into ./.claude — review and commit.\n`
    );
  } catch (err) {
    process.stderr.write(`[claude-harness] ${err.message}\n`);
    process.exit(1);
  }
}