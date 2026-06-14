/**
 * @description
 * Model-invoked CLI for marking key points in the triage/delivery pipeline.
 * Supports:
 *   - brainstorm-done    --feature-id <id>
 *   - regate-pending     --feature-id <id> --task-id <id>
 *   - regate-passed      --feature-id <id> --task-id <id>
 *   - escalation-fallback --feature-id <id> --task-id <id>
 *   - hand-finished      --feature-id <id> --task-id <id>
 *   - capture-verified   --feature-id <id> --task-id <id>
 * Validates feature_id (and task_id, where required) via gate-lib, and on success
 * echoes a single JSON line to stdout with exit 0:
 *   {marker:'brainstorm-done', feature_id}
 *   {marker:'regate-pending', feature_id, task_id}
 *   {marker:'regate-passed',  feature_id, task_id}
 *   {marker:'escalation-fallback', feature_id, task_id}
 *   {marker:'hand-finished', feature_id, task_id}
 *   {marker:'capture-verified', feature_id, task_id}
 * On invalid input, exits non-zero with a corrective stderr message.
 * NEITHER reads nor writes state — the stamp-triage hook observes the command
 * and stamps the corresponding flag into gate-state.json.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isSafeFeatureId } from "./lib/gate-lib.mjs";

/**
 * Markers that additionally require a --task-id (the per-task re-gate rail, the per-task
 * escalation-fallback ticket that authorizes a K=1 Claude hand dispatch, plus the
 * independent-capture rail: hand-finished producer + capture-verified consumer-precondition).
 */
const TASK_SCOPED_MARKERS = new Set([
  "regate-pending",
  "regate-passed",
  "escalation-fallback",
  "hand-finished",
  "capture-verified",
]);

/**
 * All supported marker commands.
 */
const SUPPORTED_MARKERS = new Set(["brainstorm-done", ...TASK_SCOPED_MARKERS]);

/**
 * Finds the value following a flag in argv, or null when absent.
 * @param {string[]} argv - process.argv
 * @param {string} flag - The flag to find (e.g. '--feature-id')
 * @returns {string | null}
 */
function findFlag(argv, flag) {
  for (let i = 3; i < argv.length; i++) {
    if (argv[i] === flag && i + 1 < argv.length) {
      return argv[i + 1];
    }
  }
  return null;
}

/**
 * Parses argv for the marker command and its flags.
 * Expected formats:
 *   ['node', 'mark.mjs', 'brainstorm-done', '--feature-id', '<id>']
 *   ['node', 'mark.mjs', 'regate-pending', '--feature-id', '<id>', '--task-id', '<id>']
 *   ['node', 'mark.mjs', 'regate-passed',  '--feature-id', '<id>', '--task-id', '<id>']
 * @param {string[]} argv - process.argv
 * @returns {{marker: string, feature_id: string, task_id?: string} | null}
 */
export function parseArgs(argv) {
  // First positional arg (after node and mark.mjs) should be the marker command
  if (argv.length < 3) {
    return null;
  }

  const marker = argv[2];

  if (!SUPPORTED_MARKERS.has(marker)) {
    return null;
  }

  const feature_id = findFlag(argv, "--feature-id");
  if (feature_id === null) {
    return null;
  }

  if (TASK_SCOPED_MARKERS.has(marker)) {
    const task_id = findFlag(argv, "--task-id");
    if (task_id === null) {
      return null;
    }
    return { marker, feature_id, task_id };
  }

  return { marker, feature_id };
}

/**
 * Validates and runs the marker command.
 * @param {{marker: string, feature_id: string, task_id?: string}} args
 * @returns {{success: boolean, output?: {marker: string, feature_id: string, task_id?: string}, error?: string}}
 */
export function run(args) {
  const { marker, feature_id, task_id } = args;

  // Validate feature_id
  if (!isSafeFeatureId(feature_id)) {
    return {
      success: false,
      error: `invalid feature_id: "${feature_id}" must be a non-empty kebab-case string (a-z, 0-9, hyphens only). Path separators, uppercase, and underscores are rejected.`,
    };
  }

  if (TASK_SCOPED_MARKERS.has(marker)) {
    if (!isSafeFeatureId(task_id)) {
      return {
        success: false,
        error: `invalid task_id: "${task_id}" must be a non-empty kebab-case string (a-z, 0-9, hyphens only). Path separators, uppercase, and underscores are rejected.`,
      };
    }
    return {
      success: true,
      output: { marker, feature_id, task_id },
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
    console.error(
      "usage: mark.mjs <brainstorm-done --feature-id <id> | regate-pending --feature-id <id> --task-id <id> | regate-passed --feature-id <id> --task-id <id> | escalation-fallback --feature-id <id> --task-id <id> | hand-finished --feature-id <id> --task-id <id> | capture-verified --feature-id <id> --task-id <id>>"
    );
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
