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

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @description Path to the hand-config template settings.json bundled with spawn-hand. */
const HAND_CONFIG_SETTINGS_TEMPLATE = join(__dirname, "hand-config", "settings.json");

/** @description Ollama base URL — all hand dispatches target this endpoint. */
const OLLAMA_BASE_URL = "https://ollama.com";

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

  // Resolve model from dispatch (fall back to a sensible default)
  const model = dispatch.model ?? "qwen3-coder:480b";

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

  // FAIL CLOSED: an existing file that registers ZERO tests makes `node --test <file>` exit 0,
  // so the Stop hook can never go RED → the gate is vacuous. Dry-run the frozen test through the
  // INJECTED spawn (never a real spawnSync, so the test suite does not execute it) and confirm it
  // collects >0 tests. This checks the COUNT only — the frozen test is legitimately RED pre-impl.
  const dryRun = spawn(process.execPath, ["--test", resolvedLockedTest], { encoding: "buffer" });
  const dryRunStdout = dryRun?.stdout ? String(dryRun.stdout) : "";
  const testCountMatches = [...dryRunStdout.matchAll(/^# tests (\d+)$/gm)];
  const testCount = testCountMatches.length
    ? Number(testCountMatches[testCountMatches.length - 1][1])
    : 0;
  if (!testCount) {
    throw new Error(
      "locked_test registers zero tests — gate is vacuous, refusing to spawn"
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
    const hookCmd = resolveHookCommand(ephemeralDir, lockedTest);
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

    // Spawn the process (injectable for unit tests).
    // The scrubbed brief is delivered to the child's STDIN so it becomes the hand's USER
    // prompt — without it `claude -p` has no user turn, exits 1, and the hand does NOTHING.
    // The brief is already token-scrubbed (scrubbedBrief = redact(rawBrief, token)), so no
    // auth token reaches stdin. --append-system-prompt-file stays as domain/context belt.
    const result = spawn("claude", argv, { env: childEnv, input: Buffer.from(scrubbedBrief, "utf8") });

    const exitCode = result?.status ?? result?.exitCode ?? 1;
    const stdout = result?.stdout ? String(result.stdout) : "";
    const stderr = result?.stderr ? String(result.stderr) : "";

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
const REQUIRED_STRING_FIELDS = ["feature_id", "task_id", "model", "brief_file", "locked_test", "freeze_commit_sha"];
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
  return captureResult({
    ...args,
    git: realGit(),
    testRunner: (p) => realTestRunner(p),
    logSink: (line) => process.stderr.write(`${line}\n`),
  });
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
  env = process.env,
  writeRecord = defaultWriteRecord,
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
  if (gitStatus().trim() !== "") {
    throw new Error(
      "runLiveDispatch: working tree is dirty relative to the freeze baseline — refusing to spawn (uncommitted changes would be misattributed to the hand; commit/stash orchestrator files first)"
    );
  }

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
  const dispatch = {
    model: descriptor.model,
    brief: briefContent,
    shared_context: "",
    scope_paths: descriptor.scope_paths,
    frozen_paths: [descriptor.locked_test],
    allowed_writes: descriptor.allowed_writes,
    locked_test: descriptor.locked_test,
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
    });

    // A post-spawn HEAD divergence (rogue commit) is a CRITICAL EXCEPTION — never stamp a record.
    if (captured.criticalException) {
      throw new Error(`runLiveDispatch: capture critical exception — ${captured.reason}`);
    }

    // (10) Build the token-free run-record from the captured (independent) child + persist it,
    // keyed by feature_id/task_id — the on-disk evidence Part B consumes.
    const record = buildRunRecord({ dispatch, child: captured.child, token, logs: [] });
    const baseDir = stateDir ?? join(process.cwd(), ".claude", "plans", ".state", "hand-records");
    const recordPath = join(baseDir, `${descriptor.feature_id}__${descriptor.task_id}.json`);
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

  const result = await runLiveDispatch(descriptor, { env: process.env });
  process.stdout.write(`${JSON.stringify(result.record, null, 2)}\n`);
  process.exit(result.outcome.status === OUTCOME.DONE ? 0 : 1);
}
