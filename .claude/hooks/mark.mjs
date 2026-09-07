/**
 * @description
 * Model-invoked CLI for marking key points in the triage/delivery pipeline.
 * Supports:
 *   - brainstorm-done    --feature-id <id>
 *   - plan-reviewed     --feature-id <id> [--task-id <id>] --verdict APPROVE|REVISE
 *   - task-executing     --feature-id <id> --n <n> --total <N>
 *   - final-review-done  --feature-id <id>
 *   - regate-pending     --feature-id <id> --task-id <id>
 *   - regate-passed      --feature-id <id> --task-id <id>
 *   - escalation-fallback --feature-id <id> --task-id <id>
 *   - hand-finished      --feature-id <id> --task-id <id>
 *   - capture-verified   --feature-id <id> --task-id <id>
 *   - fidelity-pass      --feature-id <id> --task-id <id>
 *   - spec-adversaried   --feature-id <id> --verdict SHIP|BLOCK --findings <n>
 * Validates feature_id (and task_id, where required) via gate-lib, and on success
 * echoes a single JSON line to stdout with exit 0:
 *   {marker:'brainstorm-done', feature_id}
 *   {marker:'plan-reviewed', feature_id, [task_id], verdict}
 *   {marker:'task-executing', feature_id, n, total}
 *   {marker:'final-review-done', feature_id}
 *   {marker:'regate-pending', feature_id, task_id}
 *   {marker:'regate-passed',  feature_id, task_id}
 *   {marker:'escalation-fallback', feature_id, task_id}
 *   {marker:'hand-finished', feature_id, task_id}
 *   {marker:'capture-verified', feature_id, task_id}
 *   {marker:'fidelity-pass', feature_id, task_id}
 *   {marker:'spec-adversaried', feature_id, verdict, findings}
 * On invalid input, exits non-zero with a corrective stderr message.
 * NEITHER reads nor writes state — the stamp-triage hook observes the command
 * and stamps the corresponding flag into gate-state.json.
 *
 * Re-gate rail note (process-eye-routing / conditional re-gate): `regate-pending` is
 * stamped for EVERY HIGH sniper fix; `regate-passed` clears it only after a re-gate returns
 * zero blocking findings. WHAT may produce that pass is conditional on the fix's gravity and
 * lives in orchestrating-delivery's Phase 2 step 5, NOT here — this CLI is mechanism-agnostic:
 *   - grave HIGH fix (`isGrave(fix)`: any canonical-critical-class, sensitive-path,
 *     re-architecture, or >1 function/seam) → the full opus fresh-virgin adversary re-gate;
 *   - non-grave surgical HIGH fix → the light path: a red→green frozen locked_test (RED pre-fix
 *     on the flagged assertion, GREEN post-fix — a "stays green" test is INSUFFICIENT) OR a
 *     virgin sonnet adversary spot-check, each leaving an on-disk artifact the self-check asserts.
 * The pending→passed diff (entry-gate) and the append-only stamp (stamp-triage) are unchanged —
 * the rail enforces the obligation identically however the pass was earned.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { isSafeFeatureId } from "./lib/gate-lib.mjs";

/**
 * @description Parses a comma-separated list of RELATIVE path strings for the active-scope marker.
 * Trims each entry, drops empties, normalizes separators/'.'/'..'. Rejects (returns null) when any
 * entry is absolute or, after normalize, still contains a '..' segment (path traversal). Returns []
 * for an empty input only when allowEmpty is true (allowed_writes is optional); otherwise null.
 * @param {unknown} raw - comma-separated path list
 * @param {boolean} allowEmpty - whether an empty result is valid
 * @returns {string[]|null}
 */
function parsePathList(raw, allowEmpty) {
  if (typeof raw !== "string") return null;
  const parts = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  if (parts.length === 0) return allowEmpty ? [] : null;
  const out = [];
  for (const p of parts) {
    const norm = path.posix.normalize(p.replace(/\\/g, "/"));
    if (norm === ".." || norm.split("/").includes("..") || path.posix.isAbsolute(norm)) {
      return null;
    }
    out.push(norm);
  }
  return out;
}

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
 * Observability-only markers (no gate-state write — the stamp-triage hook appends a checkpoint
 * event to the run's observability outbox instead). plan-reviewed carries an OPTIONAL --task-id
 * (the plan verdict is feature-scoped, not task-scoped) plus a required --verdict APPROVE|REVISE;
 * task-executing carries --n/--total (the 1-based task index and total task count).
 */
const OBSERVABILITY_MARKERS = new Set(["plan-reviewed", "task-executing", "final-review-done", "spec-adversaried"]);

/**
 * All supported marker commands.
 */
const SUPPORTED_MARKERS = new Set([
  "brainstorm-done",
  "active-scope",
  ...OBSERVABILITY_MARKERS,
  ...TASK_SCOPED_MARKERS,
]);

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

  // plan-reviewed: optional --task-id (feature-scoped verdict) + required --verdict APPROVE|REVISE.
  if (marker === "plan-reviewed") {
    const task_id = findFlag(argv, "--task-id");
    const verdict = findFlag(argv, "--verdict");
    if (verdict === null) {
      return null;
    }
    const parsed = { marker, feature_id, verdict };
    if (task_id !== null) {
      parsed.task_id = task_id;
    }
    return parsed;
  }

  // spec-adversaried: feature-scoped (no --task-id), required --verdict SHIP|BLOCK + required
  // --findings <n> (validated as a non-negative integer in run() — 0 is a valid finding count).
  if (marker === "spec-adversaried") {
    const verdict = findFlag(argv, "--verdict");
    const findings = findFlag(argv, "--findings");
    if (verdict === null || findings === null) {
      return null;
    }
    return { marker, feature_id, verdict, findings };
  }

  // active-scope: the deterministic scope_paths write rail source. Requires --task-id, --role
  // (executor|sniper), --scope-paths (comma-sep); optional --allowed-writes (comma-sep). The
  // orchestrator stamps it right before dispatching an executor/sniper; last-write-wins.
  if (marker === "active-scope") {
    const task_id = findFlag(argv, "--task-id");
    const role = findFlag(argv, "--role");
    const scope_paths = findFlag(argv, "--scope-paths");
    const allowed_writes = findFlag(argv, "--allowed-writes");
    if (task_id === null || role === null || scope_paths === null) {
      return null;
    }
    const parsed = { marker, feature_id, task_id, role, scope_paths };
    if (allowed_writes !== null) {
      parsed.allowed_writes = allowed_writes;
    }
    return parsed;
  }

  // task-executing: required --n <n> --total <N> (validated as positive integers in run()).
  if (marker === "task-executing") {
    const n = findFlag(argv, "--n");
    const total = findFlag(argv, "--total");
    if (n === null || total === null) {
      return null;
    }
    return { marker, feature_id, n, total };
  }

  // final-review-done: feature-scoped (no --task-id), mirrors brainstorm-done.

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
  const { marker, feature_id, task_id, reason, verdict } = args;

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

  // active-scope: validate ids (kebab), role in {executor, sniper}, and the relative path lists
  // (scope-paths required non-empty; allowed-writes optional). Any '..' or absolute path is rejected.
  if (marker === "active-scope") {
    if (!isSafeFeatureId(feature_id)) {
      return {
        success: false,
        error: `invalid feature_id: "${feature_id}" must be a non-empty kebab-case string (a-z, 0-9, hyphens only).`,
      };
    }
    if (!isSafeFeatureId(task_id)) {
      return {
        success: false,
        error: `invalid task_id: "${task_id}" must be a non-empty kebab-case string (a-z, 0-9, hyphens only).`,
      };
    }
    if (args.role !== "executor" && args.role !== "sniper") {
      return {
        success: false,
        error: `invalid role: "${args.role}" must be executor or sniper.`,
      };
    }
    const scopeList = parsePathList(args.scope_paths, false);
    if (scopeList === null) {
      return {
        success: false,
        error: `invalid scope-paths: "${args.scope_paths}" must be a non-empty comma-separated list of relative paths with no '..' segment or absolute path.`,
      };
    }
    const allowedList = parsePathList(args.allowed_writes ?? "", true);
    if (allowedList === null) {
      return {
        success: false,
        error: `invalid allowed-writes: "${args.allowed_writes}" must be a comma-separated list of relative paths with no '..' segment or absolute path.`,
      };
    }
    return {
      success: true,
      output: {
        marker,
        feature_id,
        task_id,
        role: args.role,
        scope_paths: scopeList,
        allowed_writes: allowedList,
      },
    };
  }

  // Validate feature_id (kebab-case required for all other markers — IDs are used in file paths)
  if (!isSafeFeatureId(feature_id)) {
    return {
      success: false,
      error: `invalid feature_id: "${feature_id}" must be a non-empty kebab-case string (a-z, 0-9, hyphens only). Path separators, uppercase, and underscores are rejected.`,
    };
  }

  // plan-reviewed: optional task_id (kebab) + verdict in {APPROVE, REVISE}. Observability-only.
  if (marker === "plan-reviewed") {
    if (task_id !== undefined) {
      if (!isSafeFeatureId(task_id)) {
        return {
          success: false,
          error: `invalid task_id: "${task_id}" must be a non-empty kebab-case string (a-z, 0-9, hyphens only). Path separators, uppercase, and underscores are rejected.`,
        };
      }
    }
    if (verdict !== "APPROVE" && verdict !== "REVISE") {
      return {
        success: false,
        error: `invalid verdict: "${verdict}" must be APPROVE or REVISE.`,
      };
    }
    const output = { marker, feature_id, verdict };
    if (task_id !== undefined) {
      output.task_id = task_id;
    }
    return { success: true, output };
  }

  // spec-adversaried: verdict in {SHIP, BLOCK} + findings a non-negative integer (0 is valid).
  // Observability-only.
  if (marker === "spec-adversaried") {
    if (verdict !== "SHIP" && verdict !== "BLOCK") {
      return {
        success: false,
        error: `invalid verdict: "${verdict}" must be SHIP or BLOCK.`,
      };
    }
    const n = Number(args.findings);
    if (!Number.isSafeInteger(n) || n < 0) {
      return {
        success: false,
        error: `invalid findings: "${args.findings}" must be a non-negative integer.`,
      };
    }
    return { success: true, output: { marker, feature_id, verdict, findings: n } };
  }

  // task-executing: n/total must be positive integers. Observability-only.
  if (marker === "task-executing") {
    const n = Number(args.n);
    const total = Number(args.total);
    if (!Number.isInteger(n) || n < 1) {
      return {
        success: false,
        error: `invalid n: "${args.n}" must be a positive integer.`,
      };
    }
    if (!Number.isInteger(total) || total < 1) {
      return {
        success: false,
        error: `invalid total: "${args.total}" must be a positive integer.`,
      };
    }
    return { success: true, output: { marker, feature_id, n, total } };
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
      "usage: mark.mjs <brainstorm-done --feature-id <id> | active-scope --feature-id <id> --task-id <id> --role executor|sniper --scope-paths <a,b> [--allowed-writes <c,d>] | plan-reviewed --feature-id <id> [--task-id <id>] --verdict APPROVE|REVISE | task-executing --feature-id <id> --n <n> --total <N> | final-review-done --feature-id <id> | regate-pending --feature-id <id> --task-id <id> | regate-passed --feature-id <id> --task-id <id> | escalation-fallback --feature-id <id> --task-id <id> | hand-finished --feature-id <id> --task-id <id> | capture-verified --feature-id <id> --task-id <id> | hand-config-error --feature-id <id> --task-id <id> [--reason <text>] | fidelity-pass --feature-id <id> --task-id <id> | spec-adversaried --feature-id <id> --verdict SHIP|BLOCK --findings <n>>"
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
