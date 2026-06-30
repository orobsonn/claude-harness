#!/usr/bin/env node
/**
 * @description CLI regression for brief-serializer.mjs — same gap as descriptor-emitter.mjs:
 * `serializeBrief()` was a pure JS export with no runnable entrypoint, forcing an orchestrator
 * without a JS runtime seam to write the brief by hand instead of via the documented helper.
 * Spawns the REAL CLI as a subprocess (mirrors spawn-hand.mjs/mark.mjs's UX).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, "brief-serializer.mjs");

const TASK_SLICE = {
  spec: "Add STAYS_API_URL to the Env interface.",
  resolved_judgments: { timeout_ms: 5000 },
  scope_paths: ["src/types.ts"],
  criterion_refs: ["AC-1"],
  locked_tests: [{ assertion: "Env.STAYS_API_URL is a string" }],
};

describe("brief-serializer CLI", () => {
  it("writes the serialized brief text to --out, byte-identical to serializeBrief()", () => {
    const dir = mkdtempSync(join(tmpdir(), "brief-serializer-cli-"));
    try {
      const taskSlicePath = join(dir, "task-slice.json");
      const outPath = join(dir, "brief.txt");
      writeFileSync(taskSlicePath, JSON.stringify(TASK_SLICE));

      const res = spawnSync(
        process.execPath,
        [CLI, "--task-slice", taskSlicePath, "--shared-context", "prior task validated X", "--out", outPath],
        { encoding: "utf8" }
      );

      assert.equal(res.status, 0, `CLI must exit 0 — stderr: ${res.stderr}`);
      const written = readFileSync(outPath, "utf8");
      assert.ok(written.includes("## Spec"));
      assert.ok(written.includes(TASK_SLICE.spec));
      assert.ok(written.includes("prior task validated X"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads --shared-context from a file when given --shared-context-file instead of a literal", () => {
    const dir = mkdtempSync(join(tmpdir(), "brief-serializer-cli-"));
    try {
      const taskSlicePath = join(dir, "task-slice.json");
      const sharedContextPath = join(dir, "shared-context.md");
      const outPath = join(dir, "brief.txt");
      writeFileSync(taskSlicePath, JSON.stringify(TASK_SLICE));
      writeFileSync(sharedContextPath, "validated fact from a prior task");

      const res = spawnSync(
        process.execPath,
        [CLI, "--task-slice", taskSlicePath, "--shared-context-file", sharedContextPath, "--out", outPath],
        { encoding: "utf8" }
      );

      assert.equal(res.status, 0, `CLI must exit 0 — stderr: ${res.stderr}`);
      const written = readFileSync(outPath, "utf8");
      assert.ok(written.includes("validated fact from a prior task"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed (non-zero exit) when --task-slice is missing", () => {
    const res = spawnSync(process.execPath, [CLI, "--out", "/tmp/x"], { encoding: "utf8" });
    assert.notEqual(res.status, 0);
  });
});
