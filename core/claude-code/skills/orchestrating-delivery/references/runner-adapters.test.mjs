/**
 * @description Frozen contract tests for runner-adapters.mjs — the single source of truth for
 * { command, parseCount } per test-runner so the pre-spawn dry-run (spawn-hand.mjs), the live
 * Stop-hook gate (resolve-hook-command.mjs), and the post-spawn independent capture
 * (capture-hand.mjs) can never drift onto three different parsers for the same stdout shape.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RUNNER_ADAPTERS,
  DEFAULT_RUNNER_ID,
  resolveRunnerAdapter,
  readRunnerConfig,
} from "./runner-adapters.mjs";

test("DEFAULT_RUNNER_ID is node-test — preserves today's hardcoded behavior for every project with no config", () => {
  assert.equal(DEFAULT_RUNNER_ID, "node-test");
});

test("resolveRunnerAdapter(node-test) builds an execFileSync-shaped array command, never a shell string", () => {
  const adapter = resolveRunnerAdapter("node-test");
  const { bin, args } = adapter.buildCommand("/abs/path/to/locked.test.mjs");
  assert.equal(bin, process.execPath);
  assert.deepEqual(args, ["--test", "/abs/path/to/locked.test.mjs"]);
});

test("resolveRunnerAdapter(vitest) builds an execFileSync-shaped array command with a JSON reporter", () => {
  const adapter = resolveRunnerAdapter("vitest");
  const { bin, args } = adapter.buildCommand("/abs/path/to/locked.test.ts");
  assert.equal(bin, "npx");
  assert.deepEqual(args, ["--no-install", "vitest", "run", "--reporter=json", "/abs/path/to/locked.test.ts"]);
});

test("resolveRunnerAdapter fails closed on an unknown adapter id instead of silently defaulting", () => {
  assert.throws(() => resolveRunnerAdapter("jest"), /unknown test_runner "jest"/);
});

test("resolveRunnerAdapter defaults to node-test when called with no id", () => {
  const adapter = resolveRunnerAdapter();
  assert.equal(adapter, RUNNER_ADAPTERS["node-test"]);
});

// ---- parseCount: node-test (TAP-like summary) ----

test("node-test parseCount reads the `# tests N` summary line", () => {
  const { parseCount } = resolveRunnerAdapter("node-test");
  assert.equal(parseCount("# tests 3\n# pass 3\n# fail 0\n"), 3);
});

test("node-test parseCount returns null (not zero) when the marker is absent — caller treats null as vacuous", () => {
  const { parseCount } = resolveRunnerAdapter("node-test");
  assert.equal(parseCount("no marker here"), null);
});

test("node-test parseCount reads the LAST `# tests N` line when one appears inside a fixture's own output", () => {
  const { parseCount } = resolveRunnerAdapter("node-test");
  const stdout = "# tests 999\n(fixture noise)\n# tests 3\n# pass 3\n";
  assert.equal(parseCount(stdout), 3);
});

// ---- parseCount: vitest (JSON reporter) ----

test("vitest parseCount reads numTotalTests from the JSON reporter payload", () => {
  const { parseCount } = resolveRunnerAdapter("vitest");
  const stdout = JSON.stringify({ numTotalTests: 11, numPassedTests: 11, numFailedTests: 0 });
  assert.equal(parseCount(stdout), 11);
});

test("vitest parseCount returns null on non-JSON stdout — fails closed, never a silent zero/pass", () => {
  const { parseCount } = resolveRunnerAdapter("vitest");
  assert.equal(parseCount("RUN  v1.6.0\nnot json at all"), null);
});

test("vitest parseCount returns null when numTotalTests is missing from otherwise-valid JSON", () => {
  const { parseCount } = resolveRunnerAdapter("vitest");
  assert.equal(parseCount(JSON.stringify({ ok: true })), null);
});

test("vitest parseCount reads numTotalTests when @cloudflare/vitest-pool-workers wraps the JSON with its own log lines", () => {
  const { parseCount } = resolveRunnerAdapter("vitest");
  // Real stdout shape from a Workers project: miniflare/vpw log lines before AND after the
  // single-line JSON report — JSON.parse(stdout) on the whole blob always throws for this shape.
  const stdout = [
    "[vpw:info] Starting single runtime for vitest.config.ts...",
    '[mf:warn] The latest compatibility date supported by the installed Cloudflare Workers Runtime is "2025-09-06", but you\'ve requested "2026-04-01". Falling back to "2025-09-06"...',
    JSON.stringify({ numTotalTests: 4, numPassedTests: 0, numFailedTests: 4 }),
    "[vpw:debug] Shutting down runtimes...",
    "",
  ].join("\n");
  assert.equal(parseCount(stdout), 4);
});

test("vitest parseCount reads numTotalTests when the JSON line is the very last line (no trailing log noise)", () => {
  const { parseCount } = resolveRunnerAdapter("vitest");
  const stdout = `[vpw:info] Starting single runtime...\n${JSON.stringify({ numTotalTests: 7 })}`;
  assert.equal(parseCount(stdout), 7);
});

// ---- readRunnerConfig: project-level, file-absent default, injectable fs ----

test("readRunnerConfig defaults to node-test when .claude/hand-config/test-runner.json is absent", () => {
  const fsImpl = { existsSync: () => false, readFileSync: () => "" };
  assert.equal(readRunnerConfig("/some/project", fsImpl), "node-test");
});

test("readRunnerConfig reads the adapter id from the project config file when present", () => {
  const fsImpl = {
    existsSync: (p) => p === "/some/project/.claude/hand-config/test-runner.json",
    readFileSync: () => JSON.stringify({ adapter: "vitest" }),
  };
  assert.equal(readRunnerConfig("/some/project", fsImpl), "vitest");
});

test("readRunnerConfig falls back to node-test when the config file's adapter field is empty/missing", () => {
  const fsImpl = {
    existsSync: () => true,
    readFileSync: () => JSON.stringify({}),
  };
  assert.equal(readRunnerConfig("/some/project", fsImpl), "node-test");
});
