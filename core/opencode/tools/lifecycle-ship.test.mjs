/** @description Contract for the lifecycle-only commit selector. */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertNoPreexistingManagedTrackedPath,
  assertLifecycleOnly,
  decideLifecyclePreparation,
  legacyTrackedOwnership,
  selectOwnedPaths,
  selectLifecyclePaths,
} from "./lifecycle-ship.mjs";

const toolPath = fileURLToPath(new URL("./lifecycle-ship.mjs", import.meta.url));

test("selectLifecyclePaths keeps framework cargo and leaves product work plus run ephemera out", () => {
  const selected = selectLifecyclePaths([
    ".opencode/agents/harness-config.md",
    ".opencode/shared/lib/feature-id.mjs",
    ".opencode/.harness-version",
    "opencode.json",
    "AGENTS.md",
    "opencode.harness.json",
    ".opencode/plans/session-feature/plan.json",
    ".opencode/plans/.state/session.json",
    ".dev.vars",
    "src/product.ts",
  ]);

  assert.deepEqual(selected, [
    ".opencode/agents/harness-config.md",
    ".opencode/shared/lib/feature-id.mjs",
    ".opencode/.harness-version",
    "opencode.json",
    "AGENTS.md",
  ]);
});

test("snapshot rejects a pre-existing tracked change in harness-owned cargo", () => {
  assert.throws(
    () => assertNoPreexistingManagedTrackedPath([".opencode/plugin/local-change.ts", "src/product.ts"]),
    /pre-existing tracked change/i,
  );
});

test("selectOwnedPaths excludes a local plugin that is absent from the vendor manifest", () => {
  assert.deepEqual(
    selectOwnedPaths([".opencode/plugin/entry-gate.ts", ".opencode/plugin/local-plugin.ts"], new Set([".opencode/plugin/entry-gate.ts"])),
    [".opencode/plugin/entry-gate.ts"],
  );
});

test("legacy snapshot ownership admits only tracked legacy harness paths", () => {
  assert.deepEqual(
    [...legacyTrackedOwnership([".opencode/plugin/entry-gate.ts", ".opencode/plans/local.json", "src/product.ts"])],
    [".opencode/plugin/entry-gate.ts"],
  );
});

test("assertLifecycleOnly refuses an existing branch that contains product work", () => {
  assert.throws(
    () => assertLifecycleOnly([".opencode/tools/classify.ts", "src/product.ts"]),
    /outside the lifecycle ownership set/i,
  );
});

test("a product feature branch can carry an uncommitted lifecycle update to the default branch", () => {
  assert.deepEqual(
    decideLifecyclePreparation(["src/product.ts"], [".opencode/tools/classify.ts", "src/draft.ts"]),
    { action: "commit", paths: [".opencode/tools/classify.ts"] },
  );
});

test("CLI executes its argument guard when called through a relative shell path", () => {
  const result = spawnSync(process.execPath, ["core/opencode/tools/lifecycle-ship.mjs", "prepare", "product-delivery"], {
    cwd: fileURLToPath(new URL("../../..", import.meta.url)),
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsupported lifecycle operation|usage:/i);
});

test("vendored CLI executes its argument guard when called through an absolute path", () => {
  const root = mkdtempSync(join(tmpdir(), "lifecycle-ship-vendored-"));
  const vendored = join(root, ".opencode", "tools", "lifecycle-ship.mjs");
  mkdirSync(join(root, ".opencode", "tools"), { recursive: true });
  cpSync(toolPath, vendored);

  const result = spawnSync(process.execPath, [vendored, "prepare", "product-delivery"], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsupported lifecycle operation|usage:/i);
});
