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
 *   - fidelity-pass      --feature-id <id> --task-id <id>
 * Validates feature_id (and task_id, where required) via gate-lib, and on success
 * echoes a single JSON line to stdout with exit 0:
 *   {marker:'brainstorm-done', feature_id}
 *   {marker:'regate-pending', feature_id, task_id}
 *   {marker:'regate-passed',  feature_id, task_id}
 *   {marker:'escalation-fallback', feature_id, task_id}
 *   {marker:'hand-finished', feature_id, task_id}
 *   {marker:'capture-verified', feature_id, task_id}
 *   {marker:'fidelity-pass', feature_id, task_id}
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
 * independent-capture rail: hand-finished producer + capture-verified consumer-precondition,
 * plus the fidelity rail: fidelity-pass producer marks that a frozen locked test exists
 * and is confirmed red before the executor cheap-hand is dispatched).
 */
const TASK_SCOPED_MARKERS = new Set([
  "regate-pending",
  "regate-passed",
  "escalation-fallback",
  "hand-finished",
  "capture-verified",
  "hand-config-error",
  "fidelity-pass",
]);

/**
 * Markers that accept an optional free-text `--reason` (product-language). Only hand-config-error
 * carries one — it records WHY the cheap-hand dispatch hit a PRE-SPAWN config error (no token,
 * dirty baseline, gate not armed) so the orchestrator can surface it on the critical-exception path.
 */
const REASON_MARKERS = new Set(["hand-config-error"]);

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
    const parsed = { marker, feature_id, task_id };
    if (REASON_MARKERS.has(marker)) {
      const reason = findFlag(argv, "--reason");
      if (reason !== null) {
        parsed.reason = reason;
      }
    }
    return parsed;
  }

  return { marker, feature_id };
}

/**
 * Validates and runs the marker command.
 * @param {{marker: string, feature_id: string, task_id?: string}} args
 * @returns {{success: boolean, output?: {marker: string, feature_id: string, task_id?: string}, error?: string}}
 */
export function run(args) {
  const { marker, feature_id, task_id, reason } = args;

  // fidelity-pass: IDs are correlation-only (never used as file paths) — any non-empty string
  // is valid. parseArgs already ensures --feature-id and --task-id were present. This bypass is
  // intentional: the fidelity rail uses short symbolic IDs in tests (e.g. "F", "T") and in
  // production the IDs come from the execution-plan descriptor, not from operator-typed CLI input.
  if (marker === "fidelity-pass") {
    if (typeof feature_id !== "string" || feature_id.length === 0) {
      return {
        success: false,
        error: `invalid feature_id: must be a non-empty string for fidelity-pass.`,
      };
    }
    if (typeof task_id !== "string" || task_id.length === 0) {
      return {
        success: false,
        error: `invalid task_id: must be a non-empty string for fidelity-pass.`,
      };
    }
    return { success: true, output: { marker, feature_id, task_id } };
  }

  // Validate feature_id (kebab-case required for all other markers — IDs are used in file paths)
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
    const output = { marker, feature_id, task_id };
    if (REASON_MARKERS.has(marker) && reason !== undefined) {
      output.reason = reason;
    }
    return {
      success: true,
      output,
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
      "usage: mark.mjs <brainstorm-done --feature-id <id> | regate-pending --feature-id <id> --task-id <id> | regate-passed --feature-id <id> --task-id <id> | escalation-fallback --feature-id <id> --task-id <id> | hand-finished --feature-id <id> --task-id <id> | capture-verified --feature-id <id> --task-id <id> | hand-config-error --feature-id <id> --task-id <id> [--reason <text>] | fidelity-pass --feature-id <id> --task-id <id>>"
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
