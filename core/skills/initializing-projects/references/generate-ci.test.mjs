/**
 * @description Locked tests for generate-ci.mjs — verifies that the emitted CI YAML
 * has the correct trigger (pull_request, branches: [main], no paths filter), a
 * pinned node-version "22", an always-required secret-free job, and a fork-safe
 * secret-gated second job when secrets are provided. Uses structural string checks
 * against the deterministic YAML output — no external YAML library.
 *
 * Usage:
 *   node --test core/skills/initializing-projects/references/generate-ci.test.mjs
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { generateCi } from "./generate-ci.mjs";

const NODE_TEST_STACK = {
  runner: "node-test",
  command: 'node --test "**/*.test.mjs"',
  status: "detected",
};

describe("generateCi", () => {
  it("assertion 1: node-test stack, no secrets → on.pull_request.branches=[main], no paths filter, node-version pinned to '22'", () => {
    const yaml = generateCi({
      stack: NODE_TEST_STACK,
      secrets: [],
      nodeVersion: "22",
      jobName: "test",
    });

    // on.pull_request.branches === ["main"] — check exact indented YAML structure
    assert.ok(
      yaml.includes("  pull_request:\n    branches:\n      - main"),
      `on must declare pull_request with branches: [main]. Got:\n${yaml}`
    );

    // NO paths key anywhere in the YAML — proves no paths filter exists
    assert.ok(
      !yaml.includes("paths:"),
      `paths: filter must not appear anywhere under on. Got:\n${yaml}`
    );

    // node-version pinned to exact string "22" (not 22 bare integer, not "22.x")
    assert.ok(
      yaml.includes('node-version: "22"'),
      `node-version must be pinned to exact string "22". Got:\n${yaml}`
    );
  });

  it("assertion 2: no secrets → always-required job (id === jobName) has no step referencing secrets and no secret-backed env", () => {
    const yaml = generateCi({
      stack: NODE_TEST_STACK,
      secrets: [],
      nodeVersion: "22",
      jobName: "test",
    });

    // When no secrets are provided the whole YAML must have zero secret references
    assert.ok(
      !yaml.includes("${{ secrets."),
      `Always-required job must not reference any secret. Got:\n${yaml}`
    );
  });

  it("assertion 3: secrets ['OLLAMA_HAND_TOKEN'] → second job exists gated by same-repo condition (fork/Dependabot skip, not fail)", () => {
    const yaml = generateCi({
      stack: NODE_TEST_STACK,
      secrets: ["OLLAMA_HAND_TOKEN"],
      nodeVersion: "22",
      jobName: "test",
    });

    // Second job must carry the exact same-repo gate so fork/Dependabot PRs skip it
    assert.ok(
      yaml.includes(
        "if: github.event.pull_request.head.repo.full_name == github.repository"
      ),
      `Secret job must be gated by same-repo condition to skip (not fail) on fork/Dependabot PRs. Got:\n${yaml}`
    );

    // The secret must be wired into the secret job via GitHub Actions expression
    assert.ok(
      yaml.includes("${{ secrets.OLLAMA_HAND_TOKEN }}"),
      `OLLAMA_HAND_TOKEN must be wired as \${{ secrets.OLLAMA_HAND_TOKEN }} in the secret job. Got:\n${yaml}`
    );
  });

  it("assertion 4: jobName 'test' → jobs object has key exactly 'test' (required status-check context derivable from job id)", () => {
    const yaml = generateCi({
      stack: NODE_TEST_STACK,
      secrets: [],
      nodeVersion: "22",
      jobName: "test",
    });

    // The jobs block must have a key exactly "test:" at 2-space indent
    assert.ok(
      /^  test:$/m.test(yaml),
      `jobs must contain a key exactly "test" (the required check context). Got:\n${yaml}`
    );
  });
});
