#!/usr/bin/env node
/**
 * @description Regression for adversary finding #8 — the latent crash: capture-hand.mjs uses
 * `readFileSync` in its CLI (reading the --dispatch/--child JSON) but did not import it from
 * `node:fs`. The bug bites the MOMENT the live capture runs through the CLI: a ReferenceError
 * before any work. This test executes the real CLI and asserts no `readFileSync is not defined`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, "capture-hand.mjs");

describe("capture-hand CLI does not crash on a missing readFileSync import", () => {
  it("reads the --dispatch/--child JSON without a ReferenceError", () => {
    const dir = mkdtempSync(join(tmpdir(), "capture-cli-"));
    try {
      const dispatchPath = join(dir, "dispatch.json");
      const childPath = join(dir, "child.json");
      writeFileSync(dispatchPath, JSON.stringify({ scope_paths: [], frozen_paths: [], allowed_writes: [] }));
      writeFileSync(childPath, JSON.stringify({ exitCode: 0, stdout: "", stderr: "" }));

      const res = spawnSync(
        process.execPath,
        [CLI, "--dispatch", dispatchPath, "--child", childPath, "--freeze", "deadbeefdeadbeef", "--test", "core/skills/orchestrating-delivery/references/capture-hand.test.mjs"],
        { encoding: "utf8" }
      );

      const combined = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
      assert.ok(
        !/readFileSync is not defined/.test(combined),
        `CLI must not crash with a ReferenceError on readFileSync — got:\n${combined}`
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
