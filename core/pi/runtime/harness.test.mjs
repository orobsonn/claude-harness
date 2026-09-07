import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { materializeRuntime } from "../bin/pi-harness.mjs";

const PACKAGE_ROOT = resolve(import.meta.dirname, "../../..");

function readHarnessConfig(runtimeDir) {
  return JSON.parse(readFileSync(join(runtimeDir, "harness.json"), "utf8"));
}

test("regression: a fresh launcher materializes three parallel reviewers by default outside subagents.json", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-harness-review-default-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtimeDir = join(root, "runtime");

  materializeRuntime(PACKAGE_ROOT, runtimeDir);

  assert.equal(existsSync(join(runtimeDir, "harness.json")), true, "the harness-owned config must be materialized");
  assert.deepEqual(readHarnessConfig(runtimeDir), { maxParallelEyes: 3 });
  const nativeConfig = JSON.parse(readFileSync(join(runtimeDir, "subagents.json"), "utf8"));
  assert.equal(nativeConfig.maxConcurrent, 1, "native background concurrency remains conservative");
  assert.equal(Object.hasOwn(nativeConfig, "maxParallelEyes"), false, "pi-subagents drops unknown fields on rewrite");
});

test("regression: valid operator review caps 1, 2 and 3 survive repeated launcher upgrades byte-for-byte", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-harness-review-override-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  for (const maxParallelEyes of [1, 2, 3]) {
    const runtimeDir = join(root, String(maxParallelEyes));
    mkdirSync(runtimeDir, { recursive: true });
    const operatorConfig = `${JSON.stringify({ maxParallelEyes }, null, 2)}\n`;
    writeFileSync(join(runtimeDir, "harness.json"), operatorConfig);

    materializeRuntime(PACKAGE_ROOT, runtimeDir);
    materializeRuntime(PACKAGE_ROOT, runtimeDir);

    assert.equal(readFileSync(join(runtimeDir, "harness.json"), "utf8"), operatorConfig);
  }
});

test("regression: launcher rejects malformed or out-of-range review caps without replacing operator bytes", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-harness-review-invalid-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  for (const [name, maxParallelEyes] of [["zero", 0], ["above-ceiling", 4], ["fraction", 1.5], ["string", "2"]]) {
    const runtimeDir = join(root, name);
    mkdirSync(runtimeDir, { recursive: true });
    const operatorConfig = `${JSON.stringify({ maxParallelEyes }, null, 2)}\n`;
    writeFileSync(join(runtimeDir, "harness.json"), operatorConfig);

    assert.throws(
      () => materializeRuntime(PACKAGE_ROOT, runtimeDir),
      /maxParallelEyes.*integer.*1.*3/i,
      `${JSON.stringify(maxParallelEyes)} must fail closed`,
    );
    assert.equal(readFileSync(join(runtimeDir, "harness.json"), "utf8"), operatorConfig);
  }
});
