/**
 * @description Pluggable test-runner adapters for the frozen-test rail. Each adapter is fully
 * HARNESS-controlled — `buildCommand` always returns a `{ bin, args }` pair fed straight into
 * `execFileSync`/`spawnSync` as an argument array, never a shell string built from project input.
 * A project can only SELECT an adapter by id (`.claude/hand-config/test-runner.json`); it can
 * never inject argv or shell content through that selection.
 *
 * Single source of truth for THREE call sites that must never drift onto different parsers for
 * the same stdout shape: the pre-spawn dry-run + live Stop-hook gate command (spawn-hand.mjs,
 * resolve-hook-command.mjs) and the post-spawn independent capture (capture-hand.mjs). Before
 * this module each of the three hardcoded `node --test` + a private `# tests N` regex; fixing
 * the capture's parser alone left the other two silently mismatched against a non-node-test
 * project (see CHANGELOG).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** @description Adapter id used when a project has no `.claude/hand-config/test-runner.json` —
 * preserves the harness's original `node --test` behavior for every already-vendored project. */
export const DEFAULT_RUNNER_ID = "node-test";

/**
 * @description Parses node:test's TAP-like `# tests N` summary line. Returns null (never 0) when
 * the marker is absent, so the vacuous-green guard treats an unparseable run as "no count
 * available" rather than conflating it with a real zero — both fail closed the same way, but the
 * distinction matters for diagnostics.
 * @param {string} stdout
 * @returns {number|null}
 */
function parseNodeTestCount(stdout = "") {
  const matches = [...String(stdout).matchAll(/^# tests (\d+)$/gm)];
  return matches.length ? Number(matches[matches.length - 1][1]) : null;
}

/**
 * @description Parses vitest's `--reporter=json` summary payload (`{ numTotalTests, ... }`).
 * Malformed/non-JSON stdout (a crash before the reporter writes, a stray log line) yields null —
 * the same fail-closed contract as the node-test parser, never a silent zero/pass.
 * @param {string} stdout
 * @returns {number|null}
 */
function parseVitestCount(stdout = "") {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  return typeof parsed.numTotalTests === "number" ? parsed.numTotalTests : null;
}

/**
 * @description The supported test-runner adapters, keyed by the id a project selects in
 * `.claude/hand-config/test-runner.json`. `buildCommand` is PURE and returns an array-shaped
 * `{ bin, args }` — callers MUST pass it to `execFileSync`/`spawnSync`, never join it into a
 * shell string with project-controlled content interpolated.
 */
export const RUNNER_ADAPTERS = {
  "node-test": {
    buildCommand: (absTestPath) => ({ bin: process.execPath, args: ["--test", absTestPath] }),
    parseCount: parseNodeTestCount,
  },
  vitest: {
    // --no-install: fails closed instead of letting npx silently fetch an arbitrary package if
    // vitest is not already a project dependency.
    buildCommand: (absTestPath) => ({
      bin: "npx",
      args: ["--no-install", "vitest", "run", "--reporter=json", absTestPath],
    }),
    parseCount: parseVitestCount,
  },
};

/**
 * @description Resolves a runner adapter by id. Fails closed (throws) on an unknown id instead
 * of silently falling back to a default — an unrecognized `test_runner` is a project config
 * error that must surface immediately, not a degraded mode.
 * @param {string} [id]
 * @returns {{ buildCommand: (absTestPath: string) => { bin: string, args: string[] }, parseCount: (stdout: string) => number|null }}
 */
export function resolveRunnerAdapter(id = DEFAULT_RUNNER_ID) {
  const adapter = RUNNER_ADAPTERS[id];
  if (!adapter) {
    throw new Error(
      `resolveRunnerAdapter: unknown test_runner "${id}" — supported: ${Object.keys(RUNNER_ADAPTERS).join(", ")}`
    );
  }
  return adapter;
}

/**
 * @description Reads a project's selected test-runner adapter id from
 * `<cwd>/.claude/hand-config/test-runner.json` (`{ "adapter": "vitest" }`). Absent file or
 * field defaults to `DEFAULT_RUNNER_ID` — every already-vendored project keeps the original
 * `node --test` behavior unchanged with zero config required. Injectable fs for hermetic tests.
 * @param {string} [cwd]
 * @param {{ existsSync: Function, readFileSync: Function }} [fsImpl]
 * @returns {string}
 */
export function readRunnerConfig(cwd = process.cwd(), fsImpl = { existsSync, readFileSync }) {
  const configPath = join(cwd, ".claude", "hand-config", "test-runner.json");
  if (!fsImpl.existsSync(configPath)) return DEFAULT_RUNNER_ID;
  const parsed = JSON.parse(fsImpl.readFileSync(configPath, "utf8"));
  return typeof parsed.adapter === "string" && parsed.adapter ? parsed.adapter : DEFAULT_RUNNER_ID;
}
