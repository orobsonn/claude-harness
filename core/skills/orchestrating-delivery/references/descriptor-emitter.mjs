import { execSync } from 'node:child_process';

/**
 * @description Emits the spawn-hand descriptor object deterministically at freeze-commit,
 * so the orchestrator never hand-types the SHA. Derives `allowed_writes` from scope_paths
 * minus the manifest frozen closure minus a runner-config exclusion set. Captures
 * `freeze_commit_sha` from an injectable `headSha()` seam (defaults to `git rev-parse HEAD`).
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
 * @returns {{ feature_id: string, task_id: string, model: string, brief_file: string,
 *   scope_paths: string[], locked_test: string, allowed_writes: string[], freeze_commit_sha: string }}
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
}) {
  // Resolve the freeze commit SHA via the injectable seam or default git call.
  const resolveHeadSha = headSha ?? defaultHeadSha;
  const freeze_commit_sha = resolveHeadSha();

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
