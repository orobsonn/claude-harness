/**
 * @description Unit tests for agent catalog health advisory (fail-open).
 */
import test from "node:test";
import assert from "node:assert/strict";
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
    "planner",
    "executor-low",
    "sniper-high",
    "test-author",
    "shipper",
  ]) {
    assert.ok(EXPECTED_HARNESS_AGENTS.includes(name), name);
  }
  assert.ok(!EXPECTED_HARNESS_AGENTS.includes("SPAWN-PATTERN"));
});

test("checkAgentCatalogHealth on harness repo finds agents (core/opencode)", () => {
  const result = checkAgentCatalogHealth(REPO_ROOT);
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
});

test("checkAgentCatalogHealth reports missing when neither dir has files", () => {
  const result = checkAgentCatalogHealth("/tmp/nonexistent-harness-root-xyz", {
    existsSync: () => false,
  });
  assert.equal(result.ok, true);
  assert.ok(result.missing.length >= 10);
  assert.ok(result.missing.includes("adversary"));
});

test("agentCatalogAdvisoryMessage is pt-br and mentions reopen", () => {
  const msg = agentCatalogAdvisoryMessage(["adversary", "executor-low"]);
  assert.match(msg, /Catálogo|agents/i);
  assert.match(msg, /Reabra a sessão|reabra/i);
  assert.match(msg, /adversary/);
  assert.equal(agentCatalogAdvisoryMessage([]), "");
});
