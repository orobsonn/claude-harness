#!/usr/bin/env node
/**
 * @description Spawn layer for the "strong eyes, cheap hands" model: launches a cheap Ollama
 * hand as `claude -p` (NOT --bare) with an isolated ephemeral CLAUDE_CONFIG_DIR seeded with
 * the Stop hook, the auth token supplied ONLY in the child env, and a scrubbed brief file.
 *
 * Design contract (AC v2.1 + v2.4):
 * - `buildSpawnArgs` is PURE: returns the argv array for `claude -p` with no token in argv.
 * - `dispatchHand` is INJECTABLE: the `spawn` parameter defaults to a thin spawnSync wrapper
 *   so unit tests can pass a FAKE spawn that captures args/env without launching a real process.
 * - Token flows ONLY through child env (ANTHROPIC_AUTH_TOKEN), never in argv, brief, or settings.
 * - Brief/shared_context are scrubbed of the token before being written to disk.
 * - Ephemeral CLAUDE_CONFIG_DIR (mkdtemp) is seeded from the hand-config template, the
 *   Stop-hook command resolved via resolveHookCommand, and torn down in a finally block.
 * - Dependency-free: only node builtins (fs, os, path, child_process).
 */

import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  readAuthToken,
  resolveAuthToken,
  redact,
  redactDeep,
  buildRunRecord,
  OUTCOME,
} from "./dispatch-hand.mjs";
import { captureResult, realGit, realTestRunner } from "./capture-hand.mjs";
import { resolveHookCommand } from "./hand-config/resolve-hook-command.mjs";
import { isSafeFeatureId } from "../../../hooks/lib/gate-lib.mjs";
import { resolveRunnerAdapter, DEFAULT_RUNNER_ID } from "./runner-adapters.mjs";
import { resolveHandModel, formatApprovedLadder } from "../../../../shared/lib/hand-model-ladder.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @description Path to the hand-config template settings.json bundled with spawn-hand. */
const HAND_CONFIG_SETTINGS_TEMPLATE = join(__dirname, "hand-config", "settings.json");

/** @description Ollama base URL — all hand dispatches target this endpoint. */
const OLLAMA_BASE_URL = "https://ollama.com";

/**
 * @description Claude model aliases that must NEVER be a hand model: a hand always dispatches to
 * Ollama, so a Claude alias here is a legacy/mis-set plan that would 404. Guarded in dispatchHand.
 */
const CLAUDE_HAND_ALIASES = new Set(["haiku", "sonnet", "opus"]);

/**
 * @description Default wall-clock timeout for the hand's own spawnSync, in milliseconds (9 minutes).
 * Deliberately < the Bash tool's 600000ms (10 min) hard max so the hand self-terminates cleanly
 * BEFORE the orchestrator's foreground Bash call (which runs `node spawn-hand.mjs`) is SIGKILLed —
 * a 60s headroom. A value >= 600000 would let the Bash tool kill the node process mid-capture,
 * losing the run-record the entry-gate rails depend on.
 */
export const DEFAULT_HAND_TIMEOUT_MS = 540000;

/**
 * @description Hard ceiling for the wall-clock timeout, in milliseconds. `dispatch.timeout_ms`
 * (per-task override) may lower the wall-clock but must never raise it above this ceiling —
 * a plan cannot smuggle an unbounded wait past the hand's designed timeout envelope.
 */
export const HAND_TIMEOUT_CEILING_MS = DEFAULT_HAND_TIMEOUT_MS;

/**
 * @description Explicit Bash-tool timeout (ms) the orchestrator MUST pass when it runs
 * `node spawn-hand.mjs` in the FOREGROUND. The Bash tool defaults to 120000ms (2 min) and would
 * SIGKILL the hand at 2 minutes; 600000ms is the Bash tool's hard max and sits 60s above the
 * hand's own 540000ms self-timeout, so the hand always self-terminates first. Carried explicitly
 * on the assembled dispatch (bash_timeout_ms) so the value is observable/verifiable, not folklore.
 */
export const HAND_BASH_TIMEOUT_MS = 600000;

/**
 * @description Attributes a 429 rate-limit event over the FULL pre-truncation child stream
 * (dispatchHand's returned stdout/stderr). A 429 is rateLimited ONLY when it co-occurs on
 * the SAME line with an upstream/transport-error marker (case-insensitive) OR appears on
 * the stderr error channel. A bare '429' in diff/stdout content with no such marker is
 * benign (rateLimited false). This is strictly stronger than a bare \b429\b — a task about
 * HTTP status codes or a fixture value of 429 does NOT degrade cheap-hands to always-Claude.
 *
 * The marker set is deliberately narrow: `claude -p --output-format json` emits a single-line
 * envelope that ALWAYS carries `is_error` and `duration_api_ms`, so a naive `error`/`api`
 * marker would match every line and collapse the stdout branch back to a bare \b429\b. `error`
 * is therefore anchored with word boundaries (`\berror\b` does NOT match `is_error` — the `_` is
 * a word char, so there is no boundary before `error`) and `api` is excluded (it matched
 * `duration_api_ms`). A real Ollama 429 still carries `429` on the stderr channel or a
 * `rate`/`too many requests`/`status` marker beside the code. Residual (accepted, fail-safe
 * per spec constraint 7): a benign `result` narrating a word-boundary "error" beside "429"
 * would still attribute — it only over-routes toward Claude, never blocks.
 *
 * @param {{ stdout: string, stderr: string }} child
 * @returns {boolean}
 */
function isRateLimited(child) {
  const stdout = child?.stdout ?? "";
  const stderr = child?.stderr ?? "";

  // Any 429 on the stderr error channel is rate-limited (no co-occurrence marker needed).
  if (/\b429\b/.test(stderr)) return true;

  // On stdout, 429 must co-occur on the SAME line with an upstream/transport-error marker.
  // `\berror\b` avoids the always-present `is_error` envelope field; `api` is excluded
  // because it matched the always-present `duration_api_ms` field.
  const errorMarker = /\berror\b|status|rate|too many requests|ollama/i;
  const lines = stdout.split("\n");
  for (const line of lines) {
    if (/\b429\b/.test(line) && errorMarker.test(line)) return true;
  }

  return false;
}

/**
 * @description Builds the argv array for `claude -p` with the required flags.
 * PURE: no side effects, no token in argv. The token is NEVER an element of this array.
 *
 * @param {{ model: string, briefFile: string }} params
 * @param {string} params.model - The resolved Ollama model identifier.
 * @param {string} params.briefFile - Absolute path to the scrubbed brief/system-prompt file.
 * @returns {string[]} The argv array to pass after the `claude` binary name.
 */
export function buildSpawnArgs({ model, briefFile }) {
  return [
    "-p",
    "--allowedTools", "Read,Write,Edit",
    "--permission-mode", "acceptEdits",
    "--output-format", "json",
    "--model", model,
    "--append-system-prompt-file", briefFile,
  ];
}

/**
 * @description Thin wrapper around spawnSync — the only real side-effectful seam.
 * Unit tests replace this with a FAKE; integration/live uses this default.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ env?: Record<string,string>, input?: string }} opts - `opts.input`, when present,
 *   is written to the child's stdin by spawnSync (this carries the hand's USER prompt — the
 *   scrubbed brief — so `claude -p` has a user turn and actually acts).
 * @returns {import("node:child_process").SpawnSyncReturns<Buffer>}
 */
function defaultSpawn(cmd, args, opts) {
  return spawnSync(cmd, args, { ...opts, encoding: "buffer" });
}

/**
 * @description Default working-tree cleanliness probe — runs `git status --porcelain`
 * SCOPED to the task's scope_paths via a `-- <paths>` pathspec (never a shell string)
 * and returns its stdout. Scoping prevents unrelated non-gitignored untracked files
 * elsewhere in the tree from spuriously tripping the dirty-baseline guard. An empty
 * scopePaths returns '' so the check is a safe no-op when the orchestrator gave no scope.
 * Injectable so unit tests assert the guard without touching a real git tree.
 *
 * @param {string[]} [scopePaths] - The dispatch's scope paths to limit status to.
 * @returns {string} The porcelain status output ('' when in-scope paths are clean).
 */
function defaultGitStatus(scopePaths = []) {
  if (!scopePaths.length) return "";
  const result = spawnSync("git", ["status", "--porcelain", "--", ...scopePaths], { encoding: "utf8" });
  return result?.stdout ?? "";
}

/**
 * @description Dispatches a hand: sets up an ephemeral CLAUDE_CONFIG_DIR, scrubs and writes
 * the brief, resolves the Stop-hook command, then spawns `claude -p` with the token in the
 * child env only. Tears down the ephemeral dir in a finally block.
 *
 * @param {object} dispatch - The dispatch descriptor (model, brief, shared_context, locked_test, etc.)
 * @param {{ spawn?: Function, devVarsContent?: string, env?: Record<string,string> }} [opts]
 *   - Injectable spawn, devVarsContent, and env for unit tests.
 * @returns {Promise<{ exitCode: number, stdout: string, stderr: string }>}
 */
export async function dispatchHand(dispatch, { spawn = defaultSpawn, gitStatus = defaultGitStatus, devVarsContent, env } = {}) {
  // FAIL CLOSED: the frozen-test rail is the entire safety basis of the cheap hand.
  // Without an armed Stop-hook gate the hand mutates the tree with no real gate (--bare blast radius).
  if (!dispatch.locked_test) {
    throw new Error(
      "dispatchHand: locked_test is required — refusing to spawn a hand without an armed Stop-hook gate"
    );
  }

  // FAIL CLOSED: the independent capture (`git diff <freezeCommitSha>`) attributes EVERY
  // tracked change to the hand. A pre-existing uncommitted production edit (aborted attempt,
  // sibling task, dirty operator tree) WITHIN scope_paths would be silently sealed into the
  // impl-commit as if the hand authored it. Scope the check to scope_paths so unrelated
  // untracked files elsewhere do not false-positive; an empty scope is a safe no-op. Enforce
  // in CODE, not prose. Runs BEFORE mkdtemp (no dir leaks on throw).
  if (gitStatus(dispatch.scope_paths ?? []).trim() !== "") {
    throw new Error(
      "dispatchHand: scope_paths already dirty before spawn — refusing to spawn onto a dirty baseline (pre-existing in-scope changes would be misattributed to the hand)"
    );
  }

  // Resolve auth token from env / .dev.vars / global ~/.claude/.dev.vars.
  // devVarsContent and env are injectable so unit tests never touch real files.
  // When devVarsContent is provided (test injection), use the pure readAuthToken so tests
  // remain deterministic. In live mode, resolveAuthToken applies the full three-tier lookup.
  const resolvedEnv = env ?? process.env;
  const token = devVarsContent !== undefined
    ? readAuthToken(resolvedEnv, devVarsContent)
    : resolveAuthToken(resolvedEnv);

  // FAIL CLOSED: captureResult already throws on an undefined token; the two modules must agree.
  // With an empty token the spawn would 401 against Ollama AND redaction degrades to a no-op
  // (redact('') matches nothing) — every live stdout/stderr tee would leak unredacted. Refuse
  // here, among the other pre-spawn guards, BEFORE mkdtemp (no ephemeral dir to leak on throw).
  if (!token) {
    throw new Error(
      "dispatchHand: no ANTHROPIC_AUTH_TOKEN resolved (.dev.vars/env) — refusing to spawn a hand that would 401 with empty-redaction streams"
    );
  }

  // Build scrubbed brief content (redact token from brief + shared_context before writing)
  const rawBrief = [
    dispatch.brief ?? "",
    dispatch.shared_context ? `\n\n## shared_context\n${dispatch.shared_context}` : "",
  ].join("");
  const scrubbedBrief = redact(rawBrief, token);

  // FAIL CLOSED: a hand ALWAYS dispatches to Ollama (ANTHROPIC_BASE_URL=ollama.com). A bare Claude
  // alias (haiku/sonnet/opus) as the resolved hand model means a legacy `tiers` plan (Claude models)
  // or a mis-set hand_tier. The allowlist below would refuse it anyway; this branch runs FIRST only
  // to keep the more actionable diagnosis (legacy shape) instead of a generic not-in-the-ladder.
  if (CLAUDE_HAND_ALIASES.has(dispatch.model)) {
    throw new Error(
      `dispatchHand: hand model "${dispatch.model}" is a Claude alias dispatched to Ollama — this is a legacy ` +
      `model_strategy (Claude tiers) or a mis-set hand_tier. Set hand_tiers to one of the approved ` +
      `hand models (${formatApprovedLadder()}).`
    );
  }

  // FAIL CLOSED (#361): only the approved ladder may run as a hand. An id outside it is a hard
  // refusal (never laundered into the fallback) and NO child is spawned — the throw routes to the
  // CLI's exit-2 configError path, which by design writes no run-record and therefore cannot
  // authorize a Claude escalation. Absence falls back to glm-5.2. Idempotent when runLiveDispatch
  // already resolved (an approved id resolves to itself); the record's fallback signal is stamped
  // there, on the dispatch, not here — this call only decides WHICH model the child gets.
  const { model } = resolveHandModel(dispatch.model);

  // Resolve locked_test path for the Stop hook
  const lockedTest = dispatch.locked_test ?? "";

  // FAIL CLOSED: an armed gate must point at a test file that actually EXISTS.
  // `node --test <missing>` exits 0 (zero tests collected = success) → the gate
  // cannot block → the hand would run Write/Edit ungated. Validate the same absolute
  // path resolveHookCommand uses (resolve(process.cwd(), lockedTest)) before spawning.
  const resolvedLockedTest = isAbsolute(lockedTest)
    ? lockedTest
    : resolve(process.cwd(), lockedTest);
  if (!existsSync(resolvedLockedTest)) {
    throw new Error(
      "dispatchHand: locked_test path does not exist — gate cannot block, refusing to spawn"
    );
  }

  // FAIL CLOSED: a directory at the locked_test path also makes `node --test <dir>` exit 0
  // (zero tests collected from a non-file = success) → the gate cannot block. Require a FILE.
  if (!statSync(resolvedLockedTest).isFile()) {
    throw new Error("locked_test must be a file, not a directory — gate cannot block");
  }

  // FAIL CLOSED: an existing file that registers ZERO tests makes the test runner exit 0, so the
  // Stop hook can never go RED → the gate is vacuous. Dry-run the frozen test through the
  // INJECTED spawn (never a real spawnSync, so the test suite does not execute it) and confirm it
  // collects >0 tests. This checks the COUNT only — the frozen test is legitimately RED pre-impl.
  // `dispatch.test_runner` selects the adapter (runner-adapters.mjs) so this dry-run, the live
  // Stop-hook gate (resolveHookCommand below), and the post-spawn capture all parse the SAME
  // command's output — never three sources of truth for "how many tests did this collect".
  const runnerId = dispatch.test_runner ?? DEFAULT_RUNNER_ID;
  const runnerAdapter = resolveRunnerAdapter(runnerId);
  const dryRunCommand = runnerAdapter.buildCommand(resolvedLockedTest);
  const dryRun = spawn(dryRunCommand.bin, dryRunCommand.args, { encoding: "buffer" });
  const dryRunStdout = dryRun?.stdout ? String(dryRun.stdout) : "";
  const testCount = runnerAdapter.parseCount(dryRunStdout) ?? 0;
  if (!testCount) {
    throw new Error(
      "locked_test registers zero tests — gate is vacuous, refusing to spawn. " +
        "Recovery: the frozen test imports a production module that does not exist yet, so it collects 0 " +
        "tests. Create a throwing scaffold stub of that module (named exports matching the test's imports, " +
        "unimplemented bodies) and commit it INSIDE the freeze commit (step 1c-commit), alongside the test — " +
        "NOT after. Committing the stub after the freeze moves HEAD off the freeze baseline and spawn-hand " +
        "then refuses with 'HEAD diverged'. The stub is a production file (outside the frozen manifest), so " +
        "the executor legitimately overwrites it with the real implementation."
    );
  }

  let ephemeralDir = null;
  let briefFile = null;

  try {
    // Create ephemeral CLAUDE_CONFIG_DIR
    ephemeralDir = mkdtempSync(join(tmpdir(), "harness-hand-"));

    // Seed it from the hand-config template settings.json
    const settingsTemplateSrc = HAND_CONFIG_SETTINGS_TEMPLATE;
    const settingsDst = join(ephemeralDir, "settings.json");

    // Single source of truth for the Stop-hook shape is the shipped template.
    // Its absence is an install error (vendor-core ships it), not a case to tolerate silently.
    if (!existsSync(settingsTemplateSrc)) {
      throw new Error(
        "hand-config template settings.json missing — cannot arm gate"
      );
    }
    const settings = JSON.parse(readFileSync(settingsTemplateSrc, "utf8"));

    // Resolve and inject the real Stop-hook command.
    // lockedTest is guaranteed non-empty (top-of-function guard).
    const hookCmd = resolveHookCommand(ephemeralDir, lockedTest, runnerId);
    // Template-shape drift must NOT silently discard the resolved command:
    // if the parsed settings cannot receive the command at hooks.Stop[0].hooks[0], fail closed.
    if (settings?.hooks?.Stop?.[0]?.hooks?.[0]) {
      settings.hooks.Stop[0].hooks[0].command = hookCmd;
    } else {
      throw new Error(
        "hand-config template missing Stop[0].hooks[0] slot — cannot arm gate"
      );
    }

    // Write the updated settings.json into the ephemeral dir
    // Token is NEVER written into settings.json — only the node command path
    writeFileSync(settingsDst, JSON.stringify(settings, null, 2), "utf8");

    // Post-write assertion: the gate must actually be armed before we spawn.
    // Re-read from DISK (not the in-memory object) so a silent writeFileSync failure
    // (disk full / perms) leaving a stale/absent settings.json is caught here.
    const writtenCommand = JSON.parse(readFileSync(settingsDst, "utf8"))?.hooks?.Stop?.[0]?.hooks?.[0]?.command;
    if (!writtenCommand || writtenCommand.includes("PLACEHOLDER_FROZEN_TEST_PATH")) {
      throw new Error(
        "dispatchHand: Stop-hook gate not armed (placeholder/empty command) — refusing to spawn"
      );
    }

    // Pre-accept the trust dialog for the real project cwd inside the ephemeral
    // CLAUDE_CONFIG_DIR: without this, the hand's first tool call would block on an
    // interactive trust prompt it can never answer (non-interactive `claude -p`).
    // Keyed by the VERBATIM process.cwd() at dispatch time (never canonicalized/realpath'd,
    // never the ephemeral tmp path) — dispatchHand passes no cwd override, so the child
    // inherits this same real project directory.
    const claudeJsonDst = join(ephemeralDir, ".claude.json");
    const trustConfig = { projects: { [process.cwd()]: { hasTrustDialogAccepted: true } } };
    writeFileSync(claudeJsonDst, JSON.stringify(trustConfig, null, 2), "utf8");

    // Write the scrubbed brief file into the ephemeral dir
    briefFile = join(ephemeralDir, "brief.txt");
    writeFileSync(briefFile, scrubbedBrief, "utf8");

    // Build argv
    const argv = buildSpawnArgs({ model, briefFile });

    // Compose child env: token only here, never in argv
    const childEnv = {
      ...resolvedEnv,
      ANTHROPIC_BASE_URL: OLLAMA_BASE_URL,
      ANTHROPIC_AUTH_TOKEN: token ?? "",
      CLAUDE_CONFIG_DIR: ephemeralDir,
    };

    // Determine timeout value: dispatch.timeout_ms when positive number (clamped to the
    // ceiling so a per-task override can only lower the wall-clock, never raise it past
    // HAND_TIMEOUT_CEILING_MS), else DEFAULT_HAND_TIMEOUT_MS.
    const timeoutMs = (typeof dispatch.timeout_ms === 'number' && dispatch.timeout_ms > 0)
      ? Math.min(dispatch.timeout_ms, HAND_TIMEOUT_CEILING_MS)
      : DEFAULT_HAND_TIMEOUT_MS;

    // Spawn the process (injectable for unit tests).
    // The scrubbed brief is delivered to the child's STDIN so it becomes the hand's USER
    // prompt — without it `claude -p` has no user turn, exits 1, and the hand does NOTHING.
    // The brief is already token-scrubbed (scrubbedBrief = redact(rawBrief, token)), so no
    // auth token reaches stdin. --append-system-prompt-file stays as domain/context belt.
    const result = spawn("claude", argv, {
      env: childEnv,
      input: Buffer.from(scrubbedBrief, "utf8"),
      timeout: timeoutMs,
      killSignal: "SIGKILL"
    });

    // Check if the spawn timed out
    const timedOut = (result.error?.code === "ETIMEDOUT" || result.signal === "SIGKILL");

    const exitCode = timedOut
      ? 1 // Non-zero, non-benign-404 exitCode for timeout
      : result?.status ?? result?.exitCode ?? 1;
    const stdout = result?.stdout ? String(result.stdout) : "";
    const stderr = result?.stderr ? String(result.stderr) : "";

    // Return timeout information when applicable
    if (timedOut) {
      return { exitCode, stdout, stderr, timedOut: true, timeoutMs };
    }

    return { exitCode, stdout, stderr };
  } finally {
    // Tear down the ephemeral dir (token-carrying config + brief)
    if (ephemeralDir && existsSync(ephemeralDir)) {
      rmSync(ephemeralDir, { recursive: true, force: true });
    }
  }
}

/**
 * @description Required descriptor fields for a live hand dispatch. The string fields must be
 * non-empty; scope_paths/allowed_writes must be arrays (may be empty). frozen_paths is NOT a
 * descriptor field — it is derived from locked_test so the hand can never touch the frozen test.
 */
// `model` is deliberately NOT required (#ac-1.3): an absent model is the one case that legitimately
// falls back (to the medium rung, stamping modelFallbackUsed on the record). Requiring it here would
// refuse the descriptor before resolveHandModel could ever apply that fallback. An absent model is
// still never a free pass — resolveHandModel only ever yields an approved id.
const REQUIRED_STRING_FIELDS = ["feature_id", "task_id", "brief_file", "locked_test", "freeze_commit_sha"];
const REQUIRED_ARRAY_FIELDS = ["scope_paths", "allowed_writes"];

/** @description Default full-tree (UNSCOPED) porcelain probe for the git-universe reconciliation guard. */
function defaultFullGitStatus() {
  return realGit().statusPorcelain();
}

/** @description Default HEAD-sha probe for the freeze-anchor guard. */
function defaultHeadSha() {
  return realGit().headSha();
}

/**
 * @description Default independent capture: the capture-hand `captureResult` wired to the REAL
 * git + frozen-test adapters. The capture re-runs the frozen test by path and derives
 * touchedPaths from an independent `git diff` — NEVER the model's prose.
 */
function defaultCapture(args) {
  // The dispatch carries `test_runner` (set from the descriptor by runLiveDispatch below), so
  // the post-spawn capture re-runs the SAME adapter the pre-spawn dry-run and live Stop-hook
  // gate already used — never a fourth, independently-hardcoded `node --test`.
  const runnerId = args.dispatch?.test_runner ?? DEFAULT_RUNNER_ID;
  return captureResult({
    ...args,
    git: realGit(),
    testRunner: (p) => realTestRunner(p, process.cwd(), runnerId),
    parseCount: resolveRunnerAdapter(runnerId).parseCount,
    logSink: (line) => process.stderr.write(`${line}\n`),
  });
}

/**
 * @description Default pre-spawn untracked snapshot: a path→hash map of every untracked file
 * (gitignored included) BEFORE the hand runs, so capture can subtract pre-existing build junk
 * instead of misattributing it to the hand. Injectable for hermetic tests.
 */
function defaultSnapshotUntracked() {
  const g = realGit();
  return g.hashObject(g.lsFilesAllOthers());
}

/**
 * @description Default run-record writer: persists the token-free record to a state path keyed
 * by feature_id/task_id (the producer of the on-disk evidence consumed by Part B). The directory
 * is created if absent; the record is the ONLY durable artifact (the descriptor is ephemeral).
 */
function defaultWriteRecord(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

/**
 * @description Default consecutive-429 streak reader — reads the persisted counter file
 * keyed by feature_id/task_id. Returns null when no prior streak exists or the file
 * cannot be read/parsed (best-effort — never throws).
 *
 * @param {object} descriptor
 * @param {string} [stateDir]
 * @returns {() => { count: number, freezeCommitSha: string } | null}
 */
function defaultReadStreak(descriptor, stateDir) {
  const baseDir = stateDir ?? join(process.cwd(), ".claude", "plans", ".state", "hand-429-streak");
  const streakPath = join(baseDir, descriptor.feature_id, `${descriptor.task_id}.json`);
  return () => {
    try {
      if (!existsSync(streakPath)) return null;
      const raw = readFileSync(streakPath, "utf8");
      const parsed = JSON.parse(raw);
      if (typeof parsed?.count === "number" && typeof parsed?.freezeCommitSha === "string") {
        return { count: parsed.count, freezeCommitSha: parsed.freezeCommitSha };
      }
      return null;
    } catch {
      return null;
    }
  };
}

/**
 * @description Default consecutive-429 streak writer — persists the counter file keyed by
 * feature_id/task_id. Best-effort (never throws — mkdir/write failures are swallowed).
 *
 * @param {object} descriptor
 * @param {string} [stateDir]
 * @returns {(streak: { count: number, freezeCommitSha: string }) => void}
 */
function defaultWriteStreak(descriptor, stateDir) {
  const baseDir = stateDir ?? join(process.cwd(), ".claude", "plans", ".state", "hand-429-streak");
  const streakPath = join(baseDir, descriptor.feature_id, `${descriptor.task_id}.json`);
  return (streak) => {
    try {
      mkdirSync(dirname(streakPath), { recursive: true });
      writeFileSync(streakPath, JSON.stringify(streak, null, 2), "utf8");
    } catch {
      // Best-effort — a streak-I/O failure must never throw out of runLiveDispatch.
    }
  };
}

/**
 * @description Parses `git status --porcelain` into the paths it reports. The rename form
 * (`R  old -> new`) yields the DESTINATION — the path that now holds the content. PURE.
 * @param {string} porcelain
 * @returns {string[]}
 */
function porcelainPaths(porcelain) {
  return (porcelain ?? "")
    .split(/\r?\n/)
    .filter((line) => line.length > 3)
    .map((line) => {
      // Porcelain v1 is `XY<space>PATH`; the status letters are positional, so slice — never trim
      // the line first (a leading space is a real status column, e.g. " M path").
      const path = line.slice(3).trim();
      const arrow = path.indexOf(" -> ");
      return arrow === -1 ? path : path.slice(arrow + 4);
    })
    .filter(Boolean);
}

/**
 * @description Builds the dirty-tree refusal message for the pre-spawn guard, choosing between two
 * diagnoses. BOTH branches refuse — this only decides which text to print, so an imperfect porcelain
 * parse (git quotes exotic paths) can never weaken the guard; worst case the operator reads the
 * generic diagnosis. PURE.
 *
 * The split exists because the generic "commit/stash orchestrator files first" advice is actively
 * DANGEROUS for the sniper case: when the dirt is the executor's own uncommitted implementation,
 * `git stash` DISCARDS the very work the sniper was dispatched to fix, and the guard then passes —
 * turning a loud exit 2 into a silent green-on-nothing. In-scope dirt has exactly one correct
 * recovery: the impl-commit (SKILL.md step 4-commit) the orchestrator skipped.
 *
 * @param {string} porcelain - raw `git status --porcelain` output.
 * @param {string[]} [scopePaths] - the dispatch's own scope_paths (file or dir entries).
 * @returns {string} the refusal message.
 */
export function dirtyTreeRefusal(porcelain, scopePaths = []) {
  const scopes = (scopePaths ?? []).map((s) => String(s).replace(/\/+$/, "")).filter(Boolean);
  const inScope = porcelainPaths(porcelain).filter((p) =>
    // Exact hit, or under a scope DIRECTORY — never a bare prefix ("coreless/" is not in "core").
    scopes.some((s) => p === s || p.startsWith(`${s}/`))
  );

  if (inScope.length === 0) {
    return (
      "runLiveDispatch: working tree is dirty relative to the freeze baseline — refusing to spawn " +
      "(uncommitted changes would be misattributed to the hand; commit/stash orchestrator files first)"
    );
  }

  const shown = inScope.slice(0, 5).join(", ");
  const more = inScope.length > 5 ? `, +${inScope.length - 5} more` : "";
  return (
    `runLiveDispatch: working tree is dirty INSIDE this dispatch's own scope_paths (${shown}${more}) — ` +
    "refusing to spawn (uncommitted changes would be misattributed to the hand). This is almost always " +
    "a SKIPPED IMPL-COMMIT, not orchestrator paperwork: the executor's implementation is still uncommitted. " +
    "Recovery: commit the executor's production diff first (SKILL.md step 4-commit, `feat(<scope>): …`), " +
    "THEN re-emit this descriptor (descriptor-emitter re-derives freeze_commit_sha from the new HEAD) and " +
    "re-dispatch. Do NOT `git stash` this dirt to satisfy the guard — that DISCARDS the implementation " +
    "the sniper was dispatched to fix, and the spawn would then run against an empty tree."
  );
}

/**
 * @description The live dispatch driver — the missing seam that makes the cheap Ollama hand
 * actually FIRE. Validates the descriptor, fail-closes on a token leaked into the descriptor,
 * reconciles the two git universes (full tree clean + HEAD anchored to the freeze baseline so
 * the unscoped capture diff attributes ONLY the hand's work), spawns the hand live via
 * `dispatchHand` (token env-only, ANTHROPIC_BASE_URL=ollama.com, ephemeral CLAUDE_CONFIG_DIR),
 * runs the INDEPENDENT capture, then builds + persists the token-free run-record. Every external
 * seam (spawn, gitStatus, headSha, capture, env, writeRecord) is injectable for hermetic tests.
 *
 * @param {object} descriptor - { feature_id, task_id, model, brief_file, scope_paths[],
 *   locked_test, allowed_writes[], freeze_commit_sha }
 * @param {{ spawn?: Function, gitStatus?: () => string, headSha?: () => string,
 *   capture?: Function, env?: Record<string,string|undefined>,
 *   writeRecord?: (path: string, content: string) => void, stateDir?: string }} [opts]
 * @returns {Promise<{ record: object, outcome: object, captured: boolean, recordPath: string }>}
 */
export async function runLiveDispatch(descriptor, {
  spawn = defaultSpawn,
  gitStatus = defaultFullGitStatus,
  headSha = defaultHeadSha,
  capture = defaultCapture,
  snapshotUntracked = defaultSnapshotUntracked,
  env = process.env,
  writeRecord = defaultWriteRecord,
  readStreak,
  writeStreak,
  stateDir,
} = {}) {
  // (1) Validate the descriptor schema — fail closed on anything missing/malformed BEFORE we
  // touch the token, spawn, or the working tree.
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
    throw new Error("runLiveDispatch: descriptor must be an object");
  }
  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof descriptor[field] !== "string" || descriptor[field].trim() === "") {
      throw new Error(`runLiveDispatch: descriptor.${field} is required (non-empty string)`);
    }
  }
  for (const field of REQUIRED_ARRAY_FIELDS) {
    if (!Array.isArray(descriptor[field])) {
      throw new Error(`runLiveDispatch: descriptor.${field} is required (array)`);
    }
  }
  // feature_id/task_id become path segments below (the hand-record's directory + filename) —
  // reject anything that isn't a safe kebab-case id BEFORE it can traverse outside
  // .claude/plans/.state/hand-records/ (e.g. a task_id of "../../../etc/evil").
  if (!isSafeFeatureId(descriptor.feature_id) || !isSafeFeatureId(descriptor.task_id)) {
    throw new Error(
      "runLiveDispatch: descriptor.feature_id and descriptor.task_id must be safe kebab-case ids (no path separators)"
    );
  }

  // Resolve streak-store seams — defaults are scoped to this descriptor's feature_id/task_id.
  const resolvedReadStreak = readStreak ?? defaultReadStreak(descriptor, stateDir);
  const resolvedWriteStreak = writeStreak ?? defaultWriteStreak(descriptor, stateDir);

  // (2) Resolve the auth token (env → .dev.vars tiers). Token is env-only — never argv/descriptor.
  const token = resolveAuthToken(env);
  if (!token) {
    throw new Error(
      "runLiveDispatch: no ANTHROPIC_AUTH_TOKEN resolved (.dev.vars/env) — refusing to spawn a hand that would 401"
    );
  }

  // (3) FAIL CLOSED: the descriptor is a NEW on-disk leak surface. Scrubbing must be CODE, not an
  // orchestrator prose instruction. If the resolved token literal appears anywhere in the
  // descriptor bytes, refuse — the orchestrator leaked the secret into the descriptor.
  if (JSON.stringify(descriptor).includes(token)) {
    throw new Error(
      "runLiveDispatch: descriptor carries the auth token literal — refusing (token must be env-only, never in the descriptor)"
    );
  }

  // (4) Anchor guard: HEAD must equal the recorded freeze baseline. Otherwise the unscoped
  // capture diff (`git diff <freeze_commit_sha>`) anchors to the wrong commit and misattributes.
  const head = headSha();
  if (head !== descriptor.freeze_commit_sha) {
    throw new Error(
      `runLiveDispatch: HEAD ${head} diverged from the freeze baseline ${descriptor.freeze_commit_sha} — refusing to spawn (capture diff cannot anchor)`
    );
  }

  // (5) Git-universe reconciliation (option a): the pre-spawn dirty guard is SCOPED to scope_paths,
  // but the capture diffs the FULL tree unscoped. Assert the ENTIRE tree is clean relative to the
  // freeze baseline so every post-spawn change is the hand's work — never orchestrator-owned
  // out-of-scope writes (shared_context.md, findings.md, .claude/memory/*). The orchestrator MUST
  // commit/stash those before any hand spawn (documented in SKILL.md).
  //
  // Why option (a) and NOT option (b) ("scope the capture diff to scope_paths"): the capture diffs
  // the full tree UNSCOPED ON PURPOSE so a hand writing OUTSIDE its scope is caught by checkScope
  // (a real security control). Scoping the capture diff would make that detection vacuous — strictly
  // worse. The narrow during-spawn window (a concurrent process writing out-of-scope while the hand
  // runs) is closed in practice by the synchronous spawn: dispatchHand uses spawnSync, so THIS
  // orchestrator process is blocked for the spawn's duration and cannot write concurrently; a
  // separate writer touching the tree mid-spawn is outside the one-delivery-per-session model.
  const status = gitStatus();
  if (status.trim() !== "") {
    throw new Error(dirtyTreeRefusal(status, descriptor.scope_paths));
  }

  // Pre-spawn untracked snapshot (path→hash). Taken right after the full-tree clean-check so the
  // capture subtracts pre-existing build junk (dist/, coverage/, *.tsbuildinfo) instead of
  // misattributing it to the hand as a scope/allowed-write violation.
  const preUntracked = snapshotUntracked();

  // (6) FAIL CLOSED: the brief file must exist before we build the dispatch.
  if (!existsSync(descriptor.brief_file)) {
    throw new Error(`runLiveDispatch: brief_file does not exist: ${descriptor.brief_file}`);
  }
  const briefContent = readFileSync(descriptor.brief_file, "utf8");

  // FAIL CLOSED: symmetric with the descriptor guard (step 3). The brief is a surface the token
  // must NEVER touch (env-only). dispatchHand redacts the brief before writing it to disk, but if
  // the orchestrator leaked the token into the brief, refuse here BEFORE spawning rather than rely
  // on redaction degrading gracefully.
  if (briefContent.includes(token)) {
    throw new Error(
      "runLiveDispatch: brief_file carries the auth token literal — refusing (token must be env-only, never in the brief)"
    );
  }

  // Build the dispatch dispatchHand consumes. frozen_paths is derived from locked_test so a hand
  // mutating the frozen test is an automatic gate failure. shared_context is already folded into
  // the brief by the orchestrator (context parity at the boundary).
  // #361: resolve the hand model against the approved ladder HERE, so the run-record carries the
  // model that actually ran (never an unresolved `undefined`) plus the fallback signal. An
  // out-of-ladder id throws → the CLI's exit-2 configError path → no record → no Claude escape.
  const resolvedHand = resolveHandModel(descriptor.model);
  const dispatch = {
    model: resolvedHand.model,
    modelFallbackUsed: resolvedHand.modelFallbackUsed,
    brief: briefContent,
    shared_context: "",
    scope_paths: descriptor.scope_paths,
    frozen_paths: [descriptor.locked_test],
    allowed_writes: descriptor.allowed_writes,
    locked_test: descriptor.locked_test,
    // Optional: a descriptor with no opinion (no test_runner field) lets dispatchHand/capture
    // default to DEFAULT_RUNNER_ID — every pre-existing descriptor keeps today's behavior.
    test_runner: descriptor.test_runner,
    // #ac-2.2: carry the explicit Bash-tool timeout the orchestrator must set on the FOREGROUND
    // `node spawn-hand.mjs` call, so it never defaults to 120000ms and SIGKILLs the hand at 2 min.
    // Observable on the assembled dispatch (and forwarded to the capture seam) for verification.
    bash_timeout_ms: HAND_BASH_TIMEOUT_MS,
  };

  // (7) Persist the descriptor ONLY into an ephemeral mkdtemp path, redactDeep-scrubbed, torn down
  // in finally. This bounds the descriptor's on-disk lifetime and proves the scrub is in code.
  let descriptorDir = null;
  try {
    descriptorDir = mkdtempSync(join(tmpdir(), "harness-descriptor-"));
    const scrubbed = redactDeep(descriptor, token);
    writeFileSync(join(descriptorDir, "descriptor.json"), JSON.stringify(scrubbed, null, 2), "utf8");

    // (8) Live spawn via dispatchHand — token env-only, ANTHROPIC_BASE_URL=ollama.com, ephemeral
    // CLAUDE_CONFIG_DIR with the armed Stop-hook gate. Returns { exitCode, stdout, stderr }.
    // dispatchHand's own dirty guard is SCOPED to scope_paths; runLiveDispatch already asserted
    // the FULL tree is clean (step 5, strictly stronger), so we forward a clean scoped probe — the
    // authoritative reconciliation is the unscoped check above, not the redundant scoped one.
    const child = await dispatchHand(dispatch, { spawn, env, gitStatus: () => "" });

    // (9) INDEPENDENT capture: re-run the frozen locked_test by path + derive touchedPaths from a
    // real git diff. Prose NEVER populates touchedPaths/lockedTestExitCode.
    const captured = capture({
      dispatch,
      child: { exitCode: child.exitCode, stdout: child.stdout, stderr: child.stderr },
      freezeCommitSha: descriptor.freeze_commit_sha,
      testPath: descriptor.locked_test,
      token,
      preUntracked,
    });

    // A post-spawn HEAD divergence (rogue commit) is a CRITICAL EXCEPTION — never stamp a record.
    if (captured.criticalException) {
      throw new Error(`runLiveDispatch: capture critical exception — ${captured.reason}`);
    }

    // (10) Build the token-free run-record from the captured (independent) child + persist it,
    // keyed by feature_id/task_id — the on-disk evidence Part B consumes. Stamp the
    // freeze_commit_sha into the record so it is ANCHORED to the freeze it ran against: the
    // entry-gate cross-checks this against the current HEAD, so a STALE record from a prior run
    // (a different freeze) can never authorize a Claude hand escape for a later, unfailed run.
    const record = { ...buildRunRecord({ dispatch, child: captured.child, token, logs: [] }), freezeCommitSha: descriptor.freeze_commit_sha };

    // Survive-timeout capture-then-classify (#ac-1.2/#ac-1.4): the independent capture (step 9)
    // already ran against the frozen locked_test regardless of the wall-clock outcome, so
    // `record.outcome.status` above already reflects whether the hand's work is genuinely
    // green. A SIGTERM/SIGKILL by wall-clock after the work landed is not, by itself, a quality
    // failure — only override to FAILED when the capture did NOT already reach DONE (the frozen
    // test is red, or the diff/scope/frozen/allowed-write checks failed). Keyed on dispatchHand
    // return's child.timedOut (NOT captured.child).
    if (child.timedOut) {
      record.timedOut = true;
      record.timeoutMs = child.timeoutMs;
      if (record.outcome.status !== "DONE") {
        record.outcome.status = "FAILED";
        record.reason = `hand exceeded wall-clock timeout of ${child.timeoutMs}ms`;
      } else {
        record.reason = `hand exceeded wall-clock timeout of ${child.timeoutMs}ms but the frozen locked_test was green on independent capture — treated as DONE`;
      }
    }

    // (10a) INLINE capture-verified stamp (#89): the independent capture ran INSIDE this dispatch
    // (step 9, the injected `capture` seam — capture-hand's `captureResult` by default), so the
    // producer — never a later orchestrator-remembered `mark
    // capture-verified` — closes the audit trail. Stamped ONLY on a green DONE outcome (the exact
    // condition the entry-gate real-file capture rail reads: a DONE record with no
    // `capturedVerifiedAt` blocks delivery / HEAD advancement). Green-only by construction: a
    // FAILED/NOT_DONE or timed-out run never carries the stamp, so it can never certify a capture
    // that was not verified green. Keyed off the FINAL status (after the timeout override above).
    if (record.outcome.status === "DONE") {
      record.capturedVerifiedAt = new Date().toISOString();
    }

    // (10b) Consecutive-429 streak tracking — capture-time attribution over the FULL
    // pre-truncation child stream (dispatchHand's returned stdout/stderr), NEVER the
    // ~500-char truncated persisted record. A wall-clock timeout is non-429 (rateLimited
    // false) regardless of stream content. The streak is freeze-anchored: a stored anchor
    // that differs from the current descriptor.freeze_commit_sha is treated as count 0.
    // Streak read/write is best-effort — a streak-I/O error MUST NEVER throw out of
    // runLiveDispatch after a genuine run (read failure => count 0; write failure =>
    // log-and-continue), so it cannot convert an exit-1 genuine run into an exit-2 config
    // error (which would reintroduce the entry-gate deadlock route C avoids).

    // Compute rateLimited over the dispatchHand child (full pre-truncation stream).
    // A wall-clock timeout is explicitly non-429.
    const rateLimited = child.timedOut ? false : isRateLimited(child);

    // Read prior streak (best-effort — failure => count 0).
    let priorCount = 0;
    try {
      const prior = resolvedReadStreak();
      if (prior && prior.freezeCommitSha === descriptor.freeze_commit_sha) {
        priorCount = prior.count;
      }
    } catch {
      // Best-effort — read failure => count 0.
    }

    // Transition on the rateLimited flag, not the outcome status.
    const newCount = rateLimited ? priorCount + 1 : 0;

    // Stamp the run-record with the attribution fields.
    record.rateLimited = rateLimited;
    record.rateLimitExhausted = newCount >= 2;

    // Persist the new streak (best-effort — write failure => log-and-continue, NEVER throw).
    try {
      resolvedWriteStreak({ count: newCount, freezeCommitSha: descriptor.freeze_commit_sha });
    } catch {
      // Best-effort — a streak-I/O failure must never throw out of runLiveDispatch.
    }

    const baseDir = stateDir ?? join(process.cwd(), ".claude", "plans", ".state", "hand-records");
    const recordPath = join(baseDir, descriptor.feature_id, `${descriptor.task_id}.json`);
    writeRecord(recordPath, JSON.stringify(record, null, 2));

    return { record, outcome: record.outcome, captured: captured.captured === true, recordPath };
  } finally {
    if (descriptorDir && existsSync(descriptorDir)) {
      rmSync(descriptorDir, { recursive: true, force: true });
    }
  }
}

/** @description Parses `--flag value` pairs from argv. */
function parseLiveArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key?.startsWith("--")) {
      process.stderr.write(`[spawn-hand] unexpected argument: ${key}\n`);
      process.exit(1);
    }
    args[key.slice(2)] = argv[i + 1];
  }
  return args;
}

// ---------- thin CLI: the runnable live-dispatch entrypoint ----------
// Resolves the REAL deps and calls runLiveDispatch. This is the command the SKILL recipe invokes.
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseLiveArgs(process.argv.slice(2));
  if (!args.descriptor) {
    process.stderr.write("[spawn-hand] --descriptor <descriptor.json> is required\n");
    process.exit(1);
  }
  // Resolve the token first so a descriptor parse-error can redact a leaked snippet.
  const token = resolveAuthToken(process.env);
  let descriptor;
  try {
    descriptor = JSON.parse(readFileSync(args.descriptor, "utf8"));
  } catch (err) {
    process.stderr.write(`[spawn-hand] cannot read ${args.descriptor}: ${redact(err.message, token)}\n`);
    process.exit(1);
  }

  // Exit-code contract (the config-error escape — Part B):
  //   0 → genuine run, outcome DONE.
  //   1 → genuine run, outcome FAILED/NOT_DONE (a real spawn that ran and failed its locked test
  //       → K=1 escalation; the on-disk run-record authorizes the Claude hand at the entry-gate).
  //   2 → PRE-SPAWN CONFIG ERROR or post-spawn critical exception (no token, dirty baseline, gate
  //       not armed, missing test, diverged HEAD) — NOT a genuine run failure. runLiveDispatch
  //       RETURNS only on a genuine run (record written) and THROWS otherwise, so any throw here is
  //       a config/critical error. The orchestrator routes exit 2 to the critical-exception path
  //       (stamp `mark.mjs hand-config-error` + surface) — NEVER a silent Claude fallback, NEVER a lock.
  try {
    const result = await runLiveDispatch(descriptor, { env: process.env });
    process.stdout.write(`${JSON.stringify(result.record, null, 2)}\n`);
    process.exit(result.outcome.status === OUTCOME.DONE ? 0 : 1);
  } catch (err) {
    const reason = redact(err?.message ?? String(err), token);
    process.stdout.write(
      `${JSON.stringify({ configError: true, reason, feature_id: descriptor?.feature_id, task_id: descriptor?.task_id }, null, 2)}\n`
    );
    process.exit(2);
  }
}
