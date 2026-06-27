/**
 * @description Locked tests for the committed .github/workflows/ci.yml.
 *
 * Test #1: Structural — correct trigger, node-version, test command.
 * Test #4: Governance — branch-protection is operator-gated (no autonomous gh api /protection).
 * Test #5: Fidelity — committed test command is faithful to what the generator would produce.
 *
 * Paths are resolved via import.meta.url so this file works in both local
 * and GitHub Actions checkouts (never hardcoded /Users/...).
 *
 * Usage:
 *   node --test core/__tests__/dogfood-ci-workflow.test.mjs
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { detectStack } from "../skills/initializing-projects/references/detect-stack.mjs";
import { generateCi } from "../skills/initializing-projects/references/generate-ci.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Repo root: core/__tests__/ → ../.. → repo root
const REPO_ROOT = resolve(__dirname, "../..");

// The committed CI workflow — as per the task spec:
//   resolve(__dirname, "../../.github/workflows/ci.yml")
const CI_YML_PATH = resolve(__dirname, "../../.github/workflows/ci.yml");

// ---------------------------------------------------------------------------
// Locked test #1 — structural assertions on the committed ci.yml
// ---------------------------------------------------------------------------

test("locked-1: ci.yml has correct trigger, node-version string, and test command", () => {
  const content = readFileSync(CI_YML_PATH, "utf8");

  // 1a. on.pull_request.branches must include main
  assert.ok(
    content.includes("pull_request:"),
    "ci.yml must have a pull_request trigger"
  );
  assert.ok(
    content.includes("branches:") && content.includes("- main"),
    "ci.yml pull_request trigger must list branch 'main'"
  );

  // 1b. NO paths: filter under pull_request
  // A paths: key would constrain the CI to specific file changes — we must never add it.
  // Check that no uncommented line contains "    paths:" (indented under on/pull_request).
  const uncommentedLines = content.split("\n").filter((l) => !l.trim().startsWith("#"));
  const hasPaths = uncommentedLines.some((l) => /^\s+paths\s*:/.test(l));
  assert.ok(
    !hasPaths,
    "ci.yml must NOT have a 'paths:' filter under pull_request (it must run on every PR to main)"
  );

  // 1c. node-version must be pinned to "22" (string, not number)
  assert.ok(
    content.includes('node-version: "22"'),
    `ci.yml must pin node-version as string "22" (got: check formatting around node-version)`
  );

  // 1d. The required test-runner step must exist exactly
  assert.ok(
    content.includes('node --test "core/**/*.test.mjs"'),
    `ci.yml must include a step running exactly: node --test "core/**/*.test.mjs"`
  );
});

// ---------------------------------------------------------------------------
// Locked test #4 — governance: branch-protection is operator-gated
// ---------------------------------------------------------------------------

test("locked-4: ci.yml documents operator-gated branch-protection and has NO autonomous gh api /protection step", () => {
  const content = readFileSync(CI_YML_PATH, "utf8");

  // 4a. The workflow must document that branch-protection apply is operator-gated.
  // Check for the presence of "operator" and "protection" (or "branch") in comments.
  const commentLines = content
    .split("\n")
    .filter((l) => l.trim().startsWith("#"))
    .join(" ")
    .toLowerCase();

  assert.ok(
    commentLines.includes("operator") &&
      (commentLines.includes("protection") || commentLines.includes("branch")),
    "ci.yml must document in a comment that branch-protection apply is operator-gated"
  );

  // 4b. No CI job step must invoke 'gh api' against a /protection endpoint.
  // Extract all run: lines and ensure none combine 'gh api' with '/protection'.
  const runLines = content
    .split("\n")
    .filter((l) => /^\s+run\s*:/.test(l));

  const hasProtectionStep = runLines.some(
    (l) => l.includes("gh api") && l.includes("/protection")
  );
  assert.ok(
    !hasProtectionStep,
    "ci.yml must NOT have a step that calls 'gh api' against /protection — branch-protection is operator-gated"
  );
});

// ---------------------------------------------------------------------------
// Locked test #5 — fidelity: committed test command is faithful to generator
// ---------------------------------------------------------------------------

test("locked-5: committed test command is faithful to what the generator produces for this repo", () => {
  const content = readFileSync(CI_YML_PATH, "utf8");

  // 5a. Detect the stack for THIS repo root (no package.json → node-test).
  const stack = detectStack(REPO_ROOT);
  assert.equal(
    stack.runner,
    "node-test",
    `detectStack on the harness repo must return runner 'node-test' (got: ${stack.runner})`
  );
  assert.equal(
    stack.status,
    "detected",
    `detectStack must succeed (status === 'detected', got: ${stack.status})`
  );

  // 5b. The generator must select the node-test runner (confirming no hand-tuning is needed
  //     for the runner itself — only the glob pattern was narrowed from **/ to core/**/).
  const generated = generateCi({
    stack,
    secrets: [],
    nodeVersion: "22",
    jobName: "test",
  });
  assert.ok(
    generated.includes('node --test'),
    "generateCi with node-test stack must emit a 'node --test' step"
  );

  // 5c. Fidelity via globSync set-equality:
  //     The generator emits `node --test "**/*.test.mjs"` (generic node-test pattern from
  //     detect-stack). The committed CI uses `node --test "core/**/*.test.mjs"` (narrowed).
  //     These are EQUIVALENT for THIS repo because all .test.mjs files live under core/.
  //
  //     Proof by set expansion: expand both globs under the repo root and compare the results.
  //     The sets must be identical — if any .test.mjs file existed outside core/, the
  //     committed command would silently skip it (a faithfulness regression). This test
  //     catches that regression deterministically.
  const GENERIC_GLOB = "**/*.test.mjs";
  const COMMITTED_GLOB = "core/**/*.test.mjs";

  const genericFiles = globSync(GENERIC_GLOB, {
    cwd: REPO_ROOT,
    exclude: (f) =>
      f.startsWith("node_modules") || f.includes("/node_modules/"),
  }).sort();

  const committedFiles = globSync(COMMITTED_GLOB, {
    cwd: REPO_ROOT,
    exclude: (f) =>
      f.startsWith("node_modules") || f.includes("/node_modules/"),
  }).sort();

  assert.deepStrictEqual(
    genericFiles,
    committedFiles,
    `Glob set-equality failed — the committed glob 'core/**/*.test.mjs' does not match ` +
      `all files that '**/*.test.mjs' would match.\n` +
      `Files only in generic: ${genericFiles.filter((f) => !committedFiles.includes(f)).join(", ") || "none"}\n` +
      `Files only in committed: ${committedFiles.filter((f) => !genericFiles.includes(f)).join(", ") || "none"}`
  );
});
