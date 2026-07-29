/**
 * @description Unit tests for agent catalog health advisory (fail-open).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  EXPECTED_HARNESS_AGENTS,
  checkAgentCatalogHealth,
  agentCatalogAdvisoryMessage,
} from "./agent-catalog-health.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");

test("EXPECTED_HARNESS_AGENTS includes core delivery roles", () => {
  for (const name of [
    "build",
    "adversary",
    "adversary-family-1",
    "adversary-family-2",
    "planner",
    "plan-reviewer-family-1",
    "plan-reviewer-family-2",
    "executor-low",
    "sniper-high",
    "test-author",
    "shipper",
  ]) {
    assert.ok(EXPECTED_HARNESS_AGENTS.includes(name), name);
  }
  assert.ok(!EXPECTED_HARNESS_AGENTS.includes("SPAWN-PATTERN"));
});

test("checkAgentCatalogHealth on harness repo uses the authoritative available catalog", () => {
  const result = checkAgentCatalogHealth(REPO_ROOT);
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
  const runtime = path.join(REPO_ROOT, ".opencode", "agents");
  const source = path.join(REPO_ROOT, "core", "opencode", "agents");
  assert.deepEqual(result.checkedDirs, [existsSync(runtime) ? runtime : source]);
});

test("checkAgentCatalogHealth does not mask an incomplete runtime catalog with core", () => {
  const root = "/tmp/harness-runtime-first";
  const runtime = path.join(root, ".opencode", "agents");
  const source = path.join(root, "core", "opencode", "agents");
  const expected = ["build", "adversary"];
  const existing = new Set([
    runtime,
    path.join(runtime, "build.md"),
    path.join(source, "build.md"),
    path.join(source, "adversary.md"),
  ]);
  const result = checkAgentCatalogHealth(root, {
    expected,
    existsSync: (candidate) => existing.has(candidate),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.checkedDirs, [runtime]);
  assert.deepEqual(result.missing, ["adversary"]);
});

test("checkAgentCatalogHealth does not require retired spawn twins", () => {
  const root = "/tmp/harness-shared-hand";
  const runtime = path.join(root, ".opencode", "agents");
  const existing = new Set([runtime, path.join(runtime, "executor-low.md")]);
  const result = checkAgentCatalogHealth(root, {
    expected: ["executor-low"],
    existsSync: (candidate) => existing.has(candidate),
  });
  assert.deepEqual(result.missing, []);
});

test("checkAgentCatalogHealth falls back to core only when runtime catalog is absent", () => {
  const root = "/tmp/harness-source-fallback";
  const runtime = path.join(root, ".opencode", "agents");
  const source = path.join(root, "core", "opencode", "agents");
  const expected = ["build", "adversary"];
  const existing = new Set([path.join(source, "build.md"), path.join(source, "adversary.md")]);
  const result = checkAgentCatalogHealth(root, {
    expected,
    existsSync: (candidate) => existing.has(candidate),
  });
  assert.deepEqual(result.checkedDirs, [source]);
  assert.deepEqual(result.missing, []);
});

test("agentCatalogAdvisoryMessage is pt-br and mentions reopen", () => {
  const msg = agentCatalogAdvisoryMessage(["adversary", "executor-low"]);
  assert.match(msg, /Catálogo|agents/i);
  assert.match(msg, /Re-vendorize.*reabra a sessão/i);
  assert.match(msg, /já carregados não são atualizados/i);
  assert.match(msg, /adversary/);
  assert.equal(agentCatalogAdvisoryMessage([]), "");
});
