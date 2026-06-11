/**
 * @description
 * Model-invoked CLI for marking key points in the triage/delivery pipeline.
 * Currently supports: brainstorm-done --feature-id <id>
 * Validates feature_id via gate-lib, and on success echoes a single JSON line
 * {marker:'brainstorm-done', feature_id} to stdout with exit 0.
 * On invalid input, exits non-zero with a corrective stderr message.
 * NEITHER reads nor writes state — the stamp-triage hook observes the command
 * and sets brainstormed=true in gate-state.json.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isSafeFeatureId } from "./lib/gate-lib.mjs";

/**
 * Parses argv for the marker command and its --feature-id.
 * Expected format: ['node', 'mark.mjs', 'brainstorm-done', '--feature-id', '<id>']
 * @param {string[]} argv - process.argv
 * @returns {{marker: string, feature_id: string} | null}
 */
export function parseArgs(argv) {
  // First positional arg (after node and mark.mjs) should be the marker command
  if (argv.length < 3) {
    return null;
  }

  const marker = argv[2];

  // Only support brainstorm-done for now
  if (marker !== "brainstorm-done") {
    return null;
  }

  // Find --feature-id flag
  let feature_id = null;
  for (let i = 3; i < argv.length; i++) {
    if (argv[i] === "--feature-id" && i + 1 < argv.length) {
      feature_id = argv[i + 1];
      break;
    }
  }

  if (feature_id === null) {
    return null;
  }

  return { marker, feature_id };
}

/**
 * Validates and runs the marker command.
 * @param {{marker: string, feature_id: string}} args
 * @returns {{success: boolean, output?: {marker: string, feature_id: string}, error?: string}}
 */
export function run(args) {
  const { marker, feature_id } = args;

  // Validate feature_id
  if (!isSafeFeatureId(feature_id)) {
    return {
      success: false,
      error: `invalid feature_id: "${feature_id}" must be a non-empty kebab-case string (a-z, 0-9, hyphens only). Path separators, uppercase, and underscores are rejected.`,
    };
  }

  return {
    success: true,
    output: { marker, feature_id },
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
    console.error("mark: invalid command");
    console.error("usage: mark.mjs brainstorm-done --feature-id <id>");
    process.exit(1);
  }

  const result = run(parsed);

  if (!result.success) {
    console.error(`mark: ${result.error}`);
    process.exit(1);
  }

  console.log(JSON.stringify(result.output));
  process.exit(0);
}
