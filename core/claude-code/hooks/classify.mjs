/**
 * @description
 * Model-invoked CLI for classifying requests into triage modes.
 * Parses --mode and --feature-id from process.argv, validates both via gate-lib,
 * and on success echoes a single JSON line {mode, feature_id} to stdout with exit 0.
 * On invalid input, exits non-zero with a corrective stderr message.
 * NEITHER reads nor writes state — the stamp-triage hook handles state writes.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isSafeFeatureId, VALID_MODES } from "./lib/gate-lib.mjs";

/**
 * Parses --mode and --feature-id from argv array.
 * Returns { mode, feature_id } both extracted as strings, or null if either is missing.
 * @param {string[]} argv - process.argv (expects format like ['node', 'classify.mjs', '--mode', 'FULL', '--feature-id', 'user-auth'])
 * @returns {{mode: string, feature_id: string} | null}
 */
export function parseArgs(argv) {
  let mode = null;
  let feature_id = null;

  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--mode" && i + 1 < argv.length) {
      mode = argv[i + 1];
      i++;
    } else if (argv[i] === "--feature-id" && i + 1 < argv.length) {
      feature_id = argv[i + 1];
      i++;
    }
  }

  if (mode === null || feature_id === null) {
    return null;
  }

  return { mode, feature_id };
}

/**
 * Validates and runs the classify command.
 * Returns { success: boolean, output?: {mode, feature_id}, error?: string }
 * @param {{mode: string, feature_id: string}} args
 * @returns {{success: boolean, output?: {mode, string}, error?: string}}
 */
export function run(args) {
  const { mode, feature_id } = args;

  // Validate feature_id first (path-traversal gate)
  if (!isSafeFeatureId(feature_id)) {
    return {
      success: false,
      error: `invalid feature_id: "${feature_id}" must be a non-empty kebab-case string (a-z, 0-9, hyphens only). Path separators, uppercase, and underscores are rejected.`,
    };
  }

  // Validate mode against VALID_MODES
  if (!VALID_MODES.has(mode)) {
    const allowed = [...VALID_MODES].join("|");
    return {
      success: false,
      error: `invalid mode: "${mode}" must be one of: ${allowed}`,
    };
  }

  return {
    success: true,
    output: { mode, feature_id },
  };
}

function isDirectCli() {
  if (!process.argv[1]) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try {
    return realpathSync(process.argv[1]) === modulePath;
  } catch {
    return process.argv[1] === modulePath;
  }
}

// CLI entry point — only run if this file is the main module
if (isDirectCli()) {
  const parsed = parseArgs(process.argv);

  if (!parsed) {
    console.error("classify: missing required arguments");
    console.error("usage: classify.mjs --mode <mode> --feature-id <id>");
    console.error("modes: no-ceremony, QUICK, LIGHT, FULL");
    process.exit(1);
  }

  const result = run(parsed);

  if (!result.success) {
    console.error(`classify: ${result.error}`);
    process.exit(1);
  }

  console.log(JSON.stringify(result.output));
  process.exit(0);
}
