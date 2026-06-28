/**
 * @description Dependency-free stack detector that inspects a project directory
 * and selects the appropriate test/check command. Supports node-test, vitest,
 * and jest. Returns a skip with reason for unrecognized stacks — never throws.
 *
 * Usage:
 *   import { detectStack } from "./detect-stack.mjs";
 *   const result = detectStack("/path/to/project");
 *   // { status, runner, command, reason? }
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const NODE_TEST_COMMAND = 'node --test "**/*.test.mjs"';

/**
 * @description Detects the test runner and command for a given project directory.
 * @param {string} projectDir - Absolute path to the project root directory.
 * @returns {{ runner: string|null, command: string|null, status: "detected"|"skip", reason?: string }}
 */
export function detectStack(projectDir) {
  const pkgPath = join(projectDir, "package.json");

  if (!existsSync(pkgPath)) {
    return {
      status: "detected",
      runner: "node-test",
      command: NODE_TEST_COMMAND,
    };
  }

  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch {
    return {
      runner: null,
      command: null,
      status: "skip",
      reason: "package.json exists but could not be parsed as valid JSON",
    };
  }

  const deps = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
  };

  if ("vitest" in deps) {
    return {
      status: "detected",
      runner: "vitest",
      command: "npm test",
    };
  }

  if ("jest" in deps) {
    return {
      status: "detected",
      runner: "jest",
      command: "npm test",
    };
  }

  // Check if package.json has a test script that uses node --test
  if (typeof pkg.scripts?.test === "string" && pkg.scripts.test.includes("node --test")) {
    return {
      status: "detected",
      runner: "node-test",
      command: NODE_TEST_COMMAND,
    };
  }

  return {
    runner: null,
    command: null,
    status: "skip",
    reason:
      "No recognized test runner found in dependencies (expected vitest or jest) and no package.json-free node-test setup",
  };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

// When run directly: print detected stack as JSON to stdout.
// Usage: node detect-stack.mjs [--target <project-dir>]
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let target = process.cwd();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--target" && args[i + 1] !== undefined) {
      target = args[++i];
    }
  }
  const result = detectStack(target);
  process.stdout.write(JSON.stringify(result) + "\n");
}