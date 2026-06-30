import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { readRunnerConfig as defaultReadRunnerConfig } from './runner-adapters.mjs';
import { parseFlags, isDirectCli } from './cli-flags.mjs';

/**
 * @description Emits the spawn-hand descriptor object deterministically at freeze-commit,
 * so the orchestrator never hand-types the SHA. Derives `allowed_writes` from scope_paths
 * minus the manifest frozen closure minus a runner-config exclusion set. Captures
 * `freeze_commit_sha` from an injectable `headSha()` seam (defaults to `git rev-parse HEAD`) —
 * deliberately NOT a caller-supplied value: a descriptor field controllable from outside would
 * let a forged SHA back into the one place the fidelity-rail relies on it being real, which is
 * exactly the override the CLI below refuses to expose.
 *
 * @param {object} params
 * @param {string} params.featureId - Feature identifier (maps to `feature_id`).
 * @param {string} params.taskId - Task identifier (maps to `task_id`).
 * @param {string} params.model - Model name to run as cheap hand.
 * @param {string} params.briefFile - Absolute path to the brief file.
 * @param {string[]} params.scopePaths - All paths in scope for this task.
 * @param {string} params.lockedTest - Path to the frozen acceptance test; always excluded from allowed_writes.
 * @param {{ frozen_paths: string[] }} params.manifest - Manifest object with frozen_paths array;
 *   alternatively read from disk if not supplied (injectable for tests).
 * @param {(() => string) | undefined} [params.headSha] - Injectable seam that returns the current
 *   HEAD SHA as a string. Defaults to running `git rev-parse HEAD` via child_process.
 * @param {(() => string) | undefined} [params.readRunnerConfig] - Injectable seam that returns the
 *   project's selected test-runner adapter id (`runner-adapters.mjs`). Defaults to reading
 *   `.claude/hand-config/test-runner.json` from `process.cwd()` (→ `node-test` when absent).
 * @returns {{ feature_id: string, task_id: string, model: string, brief_file: string,
 *   scope_paths: string[], locked_test: string, allowed_writes: string[], freeze_commit_sha: string,
 *   test_runner: string }}
 *   The fully resolved spawn-hand descriptor.
 */
export function emitDescriptor({
  featureId,
  taskId,
  model,
  briefFile,
  scopePaths,
  lockedTest,
  manifest,
  headSha,
  readRunnerConfig,
}) {
  // Resolve the freeze commit SHA via the injectable seam or default git call.
  const resolveHeadSha = headSha ?? defaultHeadSha;
  const freeze_commit_sha = resolveHeadSha();

  // Resolve the project's test-runner adapter id (same default as runner-adapters.mjs) so a
  // descriptor never carries a hand-typed/guessed value.
  const resolveTestRunner = readRunnerConfig ?? defaultReadRunnerConfig;
  const test_runner = resolveTestRunner();

  // Build the exclusion set: manifest frozen closure + lockedTest (always excluded) + runner-config set.
  const frozenPaths = new Set(manifest.frozen_paths);
  frozenPaths.add(lockedTest);

  // Runner-config exclusion set — empty by default; tests define the contract.
  const runnerExclusions = new Set([]);

  // allowed_writes = scopePaths minus frozen closure minus runner exclusions.
  const allowed_writes = scopePaths.filter(
    (p) => !frozenPaths.has(p) && !runnerExclusions.has(p),
  );

  return {
    feature_id: featureId,
    task_id: taskId,
    model,
    brief_file: briefFile,
    scope_paths: scopePaths,
    locked_test: lockedTest,
    allowed_writes,
    freeze_commit_sha,
    test_runner,
  };
}

/**
 * @description Default headSha seam: runs `git rev-parse HEAD` synchronously via child_process
 * and returns the trimmed SHA string.
 * @returns {string} The current HEAD commit SHA.
 */
function defaultHeadSha() {
  return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
}

// ---------- thin CLI: the runnable descriptor entrypoint SKILL.md promises ----------
// "The spawn-hand descriptor and freeze_commit_sha are emitted automatically by the
// descriptor-emitter helper, never hand-typed" — this is that runnable command, mirroring the
// UX already established by spawn-hand.mjs/mark.mjs. SECURITY (load-bearing): there is
// deliberately NO --head-sha (or any freeze_commit_sha override) flag. Exposing one would let a
// caller forge the anchor the fidelity-rail relies on being the real, current HEAD — every run
// always resolves it via `defaultHeadSha()` (real `git rev-parse HEAD`), never argv.
if (isDirectCli(import.meta.url)) {
  const args = parseFlags(process.argv.slice(2), 'descriptor-emitter');
  const required = ['feature-id', 'task-id', 'model', 'brief-file', 'scope-paths', 'locked-test', 'manifest', 'out'];
  const missing = required.filter((k) => !args[k]);
  if (missing.length) {
    process.stderr.write(
      `[descriptor-emitter] missing required flag(s): ${missing.map((k) => `--${k}`).join(', ')}\n`
    );
    process.exit(1);
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(args.manifest, 'utf8'));
  } catch (err) {
    process.stderr.write(`[descriptor-emitter] cannot read --manifest ${args.manifest}: ${err.message}\n`);
    process.exit(1);
  }

  const descriptor = emitDescriptor({
    featureId: args['feature-id'],
    taskId: args['task-id'],
    model: args.model,
    briefFile: args['brief-file'],
    scopePaths: args['scope-paths'].split(',').filter(Boolean),
    lockedTest: args['locked-test'],
    manifest,
    // --test-runner is an explicit override of the auto-detected project config — unlike
    // --head-sha this carries no forgery risk (it only selects which harness-controlled adapter
    // parses test output; see runner-adapters.mjs).
    readRunnerConfig: args['test-runner'] ? () => args['test-runner'] : undefined,
  });

  writeFileSync(args.out, `${JSON.stringify(descriptor, null, 2)}\n`, 'utf8');
  process.stdout.write(`[descriptor-emitter] wrote ${args.out}\n`);
}
