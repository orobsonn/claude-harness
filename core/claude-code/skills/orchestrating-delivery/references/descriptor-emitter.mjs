import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isSafeFeatureId } from '../../../hooks/lib/gate-lib.mjs';
import { readRunnerConfig as defaultReadRunnerConfig } from './runner-adapters.mjs';
import { parseFlags, isDirectCli } from './cli-flags.mjs';
import { appendEvent as defaultAppendEvent, readEvents as defaultReadEvents } from '../../../vps/obs-outbox.mjs';
import { resolveHandModel } from '../../../../shared/lib/hand-model-ladder.mjs';
import { normalizeSeverity, severityRank } from '../../../../shared/lib/severity.mjs';

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
 * @param {string} params.model - The resolved hand model (from `resolveExecutorModel` /
 *   `resolveSniperModel` — never hand-typed; the CLI exposes no `--model` flag).
 * @param {boolean} [params.modelFallbackUsed] - Whether the model fell back to the default rung.
 * @param {object} [params.modelResolution] - How the model was resolved (role, tier, inputs),
 *   persisted so the record can audit the arithmetic.
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
  modelFallbackUsed = false,
  modelResolution,
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
    // #361: the fallback always announces itself, on the descriptor as well as the run-record.
    modelFallbackUsed: modelFallbackUsed === true,
    ...(modelResolution ? { model_resolution: modelResolution } : {}),
    brief_file: briefFile,
    scope_paths: scopePaths,
    locked_test: lockedTest,
    allowed_writes,
    freeze_commit_sha,
    test_runner,
  };
}

/**
 * @description Reads the execution plan for a feature. Unlike `emitTaskExecuting`'s fail-open read,
 * model resolution CANNOT fail open — a dispatch with no plan has no ladder to resolve against, and
 * guessing a model is the exact failure #361 closes.
 * @param {string} featureId
 * @param {string} [plansDir] - defaults to `.claude/plans`.
 * @returns {object} the parsed plan.
 * @throws {Error} when the feature id is unsafe or the plan is missing/unreadable.
 */
function readPlan(featureId, plansDir) {
  if (!isSafeFeatureId(featureId)) {
    throw new Error(`descriptor-emitter: unsafe --feature-id ${JSON.stringify(featureId)}`);
  }
  const planPath = join(plansDir ?? '.claude/plans', featureId, 'execution-plan.json');
  try {
    return JSON.parse(readFileSync(planPath, 'utf8'));
  } catch (err) {
    throw new Error(
      `descriptor-emitter: cannot read the execution plan at ${planPath} (${err.message}) — ` +
        `the hand model resolves from plan.model_strategy.hand_tiers, so there is nothing to resolve against.`,
    );
  }
}

/**
 * @description Resolves the EXECUTOR's hand model from the plan — the model is never typed by the
 * orchestrator. Tier = `tasks[i].complexity ?? tasks[i].severity` (complexity FIRST: it measures the
 * residual reasoning left after the plan resolved every judgment, which is what picks the hand;
 * severity drives review rigor, not the model). Both are enum-validated upstream by validate-plan.
 *
 * A tier absent from `hand_tiers` falls back to glm-5.2 and SAYS SO (#ac-1.4) — never a silent pick.
 *
 * @param {object} params
 * @param {object} params.plan - the parsed execution plan.
 * @param {string} params.taskId - matched against `tasks[].id`.
 * @returns {{ model: string, modelFallbackUsed: boolean, model_resolution: object }}
 * @throws {Error} when the task is absent from the plan, or the tier pins an unapproved model.
 */
export function resolveExecutorModel({ plan, taskId }) {
  const tasks = Array.isArray(plan?.tasks) ? plan.tasks : [];
  const task = tasks.find((t) => t?.id === taskId);
  if (!task) {
    throw new Error(
      `descriptor-emitter: task ${JSON.stringify(taskId)} is not in the execution plan — cannot resolve its hand model.`,
    );
  }
  const tier = task.complexity ?? task.severity;
  const handTiers = plan?.model_strategy?.hand_tiers;
  const pinned = handTiers && typeof handTiers === 'object' ? handTiers[tier] : undefined;
  const { model, modelFallbackUsed } = resolveHandModel(pinned, {
    source: `plan model_strategy.hand_tiers.${tier}`,
  });
  return {
    model,
    modelFallbackUsed,
    model_resolution: {
      role: 'executor',
      tier: tier ?? null,
      tier_source: task.complexity !== undefined ? 'task.complexity' : 'task.severity',
      modelFallbackUsed,
    },
  };
}

/**
 * @description Resolves the SNIPER's hand model. The sniper applies a BATCH, so the tier resolves
 * over the whole applied set, mechanically (SKILL.md step 5):
 *   1. a gate failure / compliance VIOLATED-locked-decision in the set → auto-high;
 *   2. otherwise the MAX severity across the set (`critical` has no rung — it maps to `high`);
 *   3. a fail-class finding floors the tier at `medium`, never below.
 * The arithmetic lives HERE, not in the orchestrator's head: the inputs are persisted onto the
 * descriptor so the record can tell "resolved from these severities" from "someone said high".
 *
 * @param {object} params
 * @param {object} params.plan - the parsed execution plan (for `hand_tiers`).
 * @param {string[]} params.severities - resolved severities of the APPLIED set.
 * @param {boolean} [params.gateFailure] - any gate failure / VIOLATED locked decision in the set.
 * @param {boolean} [params.failClass] - any fail-class finding in the set (the medium floor).
 * @returns {{ model: string, modelFallbackUsed: boolean, model_resolution: object }}
 * @throws {Error} when the applied set is empty, or the tier pins an unapproved model.
 */
export function resolveSniperModel({ plan, severities, gateFailure = false, failClass = false }) {
  const set = Array.isArray(severities) ? severities.filter((s) => typeof s === 'string' && s !== '') : [];
  if (set.length === 0 && !gateFailure) {
    throw new Error(
      'descriptor-emitter: --severities is empty — a sniper dispatch resolves its tier from the applied set; ' +
        'there is nothing to resolve against.',
    );
  }

  // FAIL LOUD: `normalizeSeverity` maps anything unrecognized to `medium` with `invalid: true`. A
  // typo'd "hgih" would silently resolve a HIGH batch onto the medium hand — the same silent
  // degradation this issue exists to kill. Garbage in the applied set is a caller bug: name it.
  const invalid = set.filter((s) => normalizeSeverity(s).invalid);
  if (invalid.length) {
    throw new Error(
      `descriptor-emitter: unrecognized severit${invalid.length > 1 ? 'ies' : 'y'} ` +
        `${invalid.map((s) => JSON.stringify(s)).join(', ')} in --severities — ` +
        `expected low|medium|high|critical. Refusing to guess a tier from a typo.`,
    );
  }

  let tier;
  if (gateFailure) {
    // A gate failure is auto-high regardless of what the findings claim.
    tier = 'high';
  } else {
    const maxRank = Math.max(...set.map((s) => severityRank(s)));
    const normalized = set.find((s) => severityRank(s) === maxRank);
    const { severity } = normalizeSeverity(normalized);
    // `hand_tiers` has no `critical` rung — critical is the top of the ladder, i.e. high.
    tier = severity === 'critical' ? 'high' : severity;
  }
  if (failClass && tier === 'low') {
    tier = 'medium';
  }

  const handTiers = plan?.model_strategy?.hand_tiers;
  const pinned = handTiers && typeof handTiers === 'object' ? handTiers[tier] : undefined;
  const { model, modelFallbackUsed } = resolveHandModel(pinned, {
    source: `plan model_strategy.hand_tiers.${tier}`,
  });
  return {
    model,
    modelFallbackUsed,
    model_resolution: {
      role: 'sniper',
      tier,
      // The INPUTS, persisted: the record must distinguish an arithmetic result from an assertion.
      applied_severities: set,
      gate_failure: gateFailure,
      fail_class: failClass,
      modelFallbackUsed,
    },
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

/**
 * @description Structurally emits the `task-executing` observability checkpoint from the
 * execution plan, so the orchestrator can never forget a prose `mark.mjs` command and let the
 * feed go dark between plan approval and final review (#96 root cause). Producer-stamped in the
 * spirit of #89: the descriptor-emitter CLI calls this right after persisting the descriptor, so
 * the checkpoint is a structural side-effect of dispatch, not an orchestrator-remembered step.
 *
 * The plan key is **`id`**, NEVER `task_id` — `tasks.findIndex(t => t.id === taskId)`. A `t.task_id`
 * lookup would never match (-1) and, behind fail-open, silently emit nothing (a born-dead false
 * green). A taskId absent from the plan returns WITHOUT emitting — no bogus `{n:0}` event.
 *
 * STRICTLY ADDITIVE + FAIL-OPEN (the obsAppend guard replicated INLINE — not imported from
 * stamp-triage; duplicating the ~10-line guard across the 2 call-sites is within the DRY limit):
 * a cheap no-op when `HARNESS_OBSERVABILITY_RUN_PATH` is unset/empty or points at a nonexistent
 * meta (existsSync-guarded); dedupe by `(type, n)` so a K=1 re-dispatch or a per-task sniper
 * re-running the emitter never doubles the feed line; an append that throws is swallowed and never
 * reaches the caller. Performs NO fetch.
 *
 * @param {object} params
 * @param {string} params.featureId - Feature identifier (the plan lives at `<plansDir>/<featureId>/execution-plan.json`).
 * @param {string} params.taskId - Task identifier matched against `tasks[].id`.
 * @param {string} [params.plansDir] - Plans root; defaults to `.claude/plans` (resolved from `process.cwd()`).
 * @param {(metaPath: string, event: object) => void} [params.appendFn] - obs-outbox appendEvent seam.
 * @param {(metaPath: string) => object[]} [params.readEventsFn] - obs-outbox readEvents seam.
 * @returns {void}
 */
export function emitTaskExecuting({ featureId, taskId, plansDir, appendFn, readEventsFn } = {}) {
  const root = plansDir ?? '.claude/plans';
  if (!isSafeFeatureId(featureId)) { return; }
  const planPath = join(root, featureId, 'execution-plan.json');

  let plan;
  try {
    plan = JSON.parse(readFileSync(planPath, 'utf8'));
  } catch {
    // fail-open: a missing/unreadable plan never blocks the caller (the CLI dispatch continues).
    return;
  }

  const tasks = Array.isArray(plan?.tasks) ? plan.tasks : [];
  // CRITICAL: the plan key is `id`, NOT `task_id`. `t.task_id` would never match → -1 → a
  // born-dead false green behind fail-open.
  const idx = tasks.findIndex((t) => t?.id === taskId);
  if (idx < 0) {
    // No bogus {n:0} event for a taskId absent from the plan.
    return;
  }
  const n = idx + 1;
  const total = tasks.length;

  // --- obsAppend guard INLINE (mirrors stamp-triage.mjs obsAppend, NOT imported) ---
  const metaPath = process.env.HARNESS_OBSERVABILITY_RUN_PATH;
  if (typeof metaPath !== 'string' || metaPath.length === 0) {
    return;
  }
  try {
    if (!existsSync(metaPath)) {
      return;
    }
    const readFn = readEventsFn ?? defaultReadEvents;
    const existing = readFn(metaPath) || [];
    // Invariant: one execution-plan per outbox (obs keyed by issue#), so n is unique within a run — (type,n) is a safe dedupe key.
    if (existing.some((e) => e && e.type === 'task-executing' && e.n === n)) {
      // Dedupe by (type, n): a re-dispatch / per-task sniper re-running the emitter never doubles the line.
      return;
    }
    const append = appendFn ?? defaultAppendEvent;
    append(metaPath, { type: 'task-executing', n, total });
  } catch {
    // fail-open: an outbox append never blocks the dispatch / CLI exit code.
  }
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
  const required = ['feature-id', 'task-id', 'role', 'brief-file', 'scope-paths', 'locked-test', 'manifest', 'out'];
  const missing = required.filter((k) => !args[k]);
  if (missing.length) {
    // A stale caller still passing --model (removed in #361) lands here on the missing --role: the
    // error IS the migration notice. Deliberately NOT accept-and-ignore — a silently ignored --model
    // would let a caller believe it still picks the model while the plan quietly decides (#ac-3.2).
    process.stderr.write(
      `[descriptor-emitter] missing required flag(s): ${missing.map((k) => `--${k}`).join(', ')}\n`
    );
    process.exit(1);
  }

  // #361: the model is NEVER typed by the caller — it is derived from the plan's approved ladder.
  if (args.model !== undefined) {
    process.stderr.write(
      '[descriptor-emitter] --model was removed: the hand model is derived from ' +
        'plan.model_strategy.hand_tiers (executor: the task\'s complexity ?? severity; sniper: the ' +
        'arithmetic over --severities). Drop --model and pass --role executor|sniper.\n'
    );
    process.exit(1);
  }

  if (args.role !== 'executor' && args.role !== 'sniper') {
    process.stderr.write(
      `[descriptor-emitter] --role must be executor|sniper — got ${JSON.stringify(args.role)}\n`
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

  // Resolve the hand model from the plan. A config error here MUST exit non-zero and write no
  // descriptor: a dispatch whose model cannot be resolved is exactly what #361 refuses to guess at.
  let resolved;
  try {
    const plan = readPlan(args['feature-id'], args['plans-dir']);
    resolved = args.role === 'executor'
      ? resolveExecutorModel({ plan, taskId: args['task-id'] })
      : resolveSniperModel({
          plan,
          severities: (args.severities ?? '').split(',').map((s) => s.trim()).filter(Boolean),
          gateFailure: args['gate-failure'] === true || args['gate-failure'] === 'true',
          failClass: args['fail-class'] === true || args['fail-class'] === 'true',
        });
  } catch (err) {
    process.stderr.write(`[descriptor-emitter] ${err.message}\n`);
    process.exit(1);
  }

  const descriptor = emitDescriptor({
    featureId: args['feature-id'],
    taskId: args['task-id'],
    model: resolved.model,
    modelFallbackUsed: resolved.modelFallbackUsed,
    modelResolution: resolved.model_resolution,
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

  // Structural task-executing checkpoint (#89): emitted as a side-effect of dispatch right after
  // the descriptor is persisted, so the orchestrator can never forget a prose `mark.mjs` command.
  // Swallow-all: a plan read/parse/append throw can NEVER abort the dispatch or change the exit code.
  try {
    emitTaskExecuting({ featureId: args['feature-id'], taskId: args['task-id'] });
  } catch {
    // fail-open: emission never changes the CLI exit code.
  }
}
