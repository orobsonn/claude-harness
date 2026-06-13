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

import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { readAuthToken, resolveAuthToken, redact } from "./dispatch-hand.mjs";
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
