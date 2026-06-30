#!/usr/bin/env node
/**
 * @description CLI regression for descriptor-emitter.mjs — the gap that caused a real production
 * incident: the orchestrator had no runnable entrypoint for `emitDescriptor()` (only a pure JS
 * export), so it hand-typed `descriptor.json` via a shell heredoc instead, exactly what SKILL.md
 * says never to do. This spawns the REAL CLI (a subprocess, mirroring spawn-hand.mjs/mark.mjs's
 * already-runnable UX) and asserts: it writes a valid descriptor, it uses the REAL `git rev-parse
 * HEAD` (no override flag exists to forge `freeze_commit_sha`), and it resolves `test_runner`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, "descriptor-emitter.mjs");
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

function realHeadSha() {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

describe("descriptor-emitter CLI", () => {
  it("writes a descriptor.json with the real HEAD sha and no hand-typed freeze_commit_sha", () => {
    const dir = mkdtempSync(join(tmpdir(), "descriptor-emitter-cli-"));
    try {
      const manifestPath = join(dir, "manifest.json");
      const outPath = join(dir, "descriptor.json");
      writeFileSync(manifestPath, JSON.stringify({ frozen_paths: ["test/a.test.mjs"] }));

      const res = spawnSync(
        process.execPath,
        [
          CLI,
          "--feature-id", "F",
          "--task-id", "T",
          "--model", "glm-5.1",
          "--brief-file", "/tmp/brief.md",
          "--scope-paths", "src/,test/a.test.mjs",
          "--locked-test", "test/a.test.mjs",
          "--manifest", manifestPath,
          "--out", outPath,
        ],
        { cwd: REPO_ROOT, encoding: "utf8" }
      );

      assert.equal(res.status, 0, `CLI must exit 0 — stderr: ${res.stderr}`);

      const descriptor = JSON.parse(readFileSync(outPath, "utf8"));
      assert.equal(descriptor.feature_id, "F");
      assert.equal(descriptor.task_id, "T");
      assert.deepEqual(descriptor.allowed_writes, ["src/"]);
      assert.equal(descriptor.freeze_commit_sha, realHeadSha());
      assert.equal(typeof descriptor.test_runner, "string");
      assert.notEqual(descriptor.test_runner.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exposes no --head-sha (or any freeze_commit_sha override) flag — forging the anchor is impossible from argv", () => {
    const dir = mkdtempSync(join(tmpdir(), "descriptor-emitter-cli-"));
    try {
      const manifestPath = join(dir, "manifest.json");
      const outPath = join(dir, "descriptor.json");
      writeFileSync(manifestPath, JSON.stringify({ frozen_paths: [] }));

      const res = spawnSync(
        process.execPath,
        [
          CLI,
          "--feature-id", "F",
          "--task-id", "T",
          "--model", "glm-5.1",
          "--brief-file", "/tmp/brief.md",
          "--scope-paths", "src/",
          "--locked-test", "test/a.test.mjs",
          "--manifest", manifestPath,
          "--out", outPath,
          "--head-sha", "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        ],
        { cwd: REPO_ROOT, encoding: "utf8" }
      );

      assert.equal(res.status, 0, `CLI must exit 0 — stderr: ${res.stderr}`);
      const descriptor = JSON.parse(readFileSync(outPath, "utf8"));
      // A forged --head-sha must be IGNORED (treated as an unknown/unused flag) — the descriptor
      // must still carry the real HEAD, never the attacker-supplied literal.
      assert.notEqual(descriptor.freeze_commit_sha, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
      assert.equal(descriptor.freeze_commit_sha, realHeadSha());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed (non-zero exit) when a required flag is missing", () => {
    const res = spawnSync(process.execPath, [CLI, "--feature-id", "F"], { cwd: REPO_ROOT, encoding: "utf8" });
    assert.notEqual(res.status, 0);
  });
});
