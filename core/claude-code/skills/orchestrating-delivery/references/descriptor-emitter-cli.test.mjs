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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, "descriptor-emitter.mjs");
// Dual-runtime: core/claude-code/skills/orchestrating-delivery/references → 5 up = repo root.
const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..");

function realHeadSha() {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

/**
 * @description Writes a minimal execution plan the CLI resolves the hand model from (#361), and
 * returns the plans-dir to pass via --plans-dir. `task-1` is `complexity: low` → hand_tiers.low.
 */
function writePlanFixture(dir, featureId = "feat-x") {
  const plansDir = join(dir, "plans");
  mkdirSync(join(plansDir, featureId), { recursive: true });
  writeFileSync(
    join(plansDir, featureId, "execution-plan.json"),
    JSON.stringify({
      version: "1.0",
      feature_id: featureId,
      tasks: [{ id: "T", complexity: "low", severity: "high" }],
      model_strategy: {
        hand_tiers: { low: "gemma4", medium: "glm-5.2", high: "kimi-k2.7-code" },
        planner: "opus",
      },
    }),
  );
  return plansDir;
}

describe("descriptor-emitter CLI", () => {
  it("writes a descriptor.json with the real HEAD sha and no hand-typed freeze_commit_sha", () => {
    const dir = mkdtempSync(join(tmpdir(), "descriptor-emitter-cli-"));
    try {
      const manifestPath = join(dir, "manifest.json");
      const outPath = join(dir, "descriptor.json");
      writeFileSync(manifestPath, JSON.stringify({ frozen_paths: ["test/a.test.mjs"] }));
      const plansDir = writePlanFixture(dir);

      const res = spawnSync(
        process.execPath,
        [
          CLI,
          "--feature-id", "feat-x",
          "--task-id", "T",
          "--role", "executor",
          "--plans-dir", plansDir,
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
      assert.equal(descriptor.feature_id, "feat-x");
      assert.equal(descriptor.task_id, "T");
      // #ac-3.1: the model is DERIVED from the plan (complexity low → hand_tiers.low), never argv.
      assert.equal(descriptor.model, "gemma4");
      assert.equal(descriptor.modelFallbackUsed, false);
      assert.equal(descriptor.model_resolution.tier, "low");
      assert.equal(descriptor.model_resolution.tier_source, "task.complexity");
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
      const plansDir = writePlanFixture(dir);

      const res = spawnSync(
        process.execPath,
        [
          CLI,
          "--feature-id", "feat-x",
          "--task-id", "T",
          "--role", "executor",
          "--plans-dir", plansDir,
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
    const res = spawnSync(process.execPath, [CLI, "--feature-id", "feat-x"], { cwd: REPO_ROOT, encoding: "utf8" });
    assert.notEqual(res.status, 0);
  });

  // #ac-3.2: a stale caller must LEARN it is stale. Accept-and-ignore was rejected explicitly —
  // it would let the caller keep believing it picks the model while the plan quietly decides.
  it("#ac-3.2 a stale caller passing --model exits non-zero with the migration notice", () => {
    const dir = mkdtempSync(join(tmpdir(), "descriptor-emitter-cli-"));
    try {
      const manifestPath = join(dir, "manifest.json");
      writeFileSync(manifestPath, JSON.stringify({ frozen_paths: [] }));
      const plansDir = writePlanFixture(dir);
      const res = spawnSync(
        process.execPath,
        [
          CLI,
          "--feature-id", "feat-x", "--task-id", "T", "--role", "executor",
          "--plans-dir", plansDir,
          "--model", "gpt-oss:120b",
          "--brief-file", "/tmp/brief.md", "--scope-paths", "src/",
          "--locked-test", "test/a.test.mjs", "--manifest", manifestPath,
          "--out", join(dir, "descriptor.json"),
        ],
        { cwd: REPO_ROOT, encoding: "utf8" },
      );
      assert.notEqual(res.status, 0, "--model must not be silently ignored");
      assert.match(res.stderr, /--model was removed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("#ac-3.2 omitting --role exits non-zero naming the missing flag", () => {
    const dir = mkdtempSync(join(tmpdir(), "descriptor-emitter-cli-"));
    try {
      const manifestPath = join(dir, "manifest.json");
      writeFileSync(manifestPath, JSON.stringify({ frozen_paths: [] }));
      const res = spawnSync(
        process.execPath,
        [
          CLI,
          "--feature-id", "feat-x", "--task-id", "T",
          "--brief-file", "/tmp/brief.md", "--scope-paths", "src/",
          "--locked-test", "test/a.test.mjs", "--manifest", manifestPath,
          "--out", join(dir, "descriptor.json"),
        ],
        { cwd: REPO_ROOT, encoding: "utf8" },
      );
      assert.notEqual(res.status, 0);
      assert.match(res.stderr, /--role/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // #ac-2.1's dispatch-side twin: a plan that somehow carries an unapproved tier (written before
  // the gate existed, or edited by hand) still cannot dispatch — the rail is at both ends.
  it("refuses to emit when the plan's tier pins an unapproved model", () => {
    const dir = mkdtempSync(join(tmpdir(), "descriptor-emitter-cli-"));
    try {
      const manifestPath = join(dir, "manifest.json");
      writeFileSync(manifestPath, JSON.stringify({ frozen_paths: [] }));
      const plansDir = join(dir, "plans");
      mkdirSync(join(plansDir, "feat-x"), { recursive: true });
      writeFileSync(
        join(plansDir, "feat-x", "execution-plan.json"),
        JSON.stringify({
          tasks: [{ id: "T", complexity: "low" }],
          model_strategy: { hand_tiers: { low: "gpt-oss:120b", medium: "glm-5.2", high: "kimi-k2.7-code" } },
        }),
      );
      const outPath = join(dir, "descriptor.json");
      const res = spawnSync(
        process.execPath,
        [
          CLI,
          "--feature-id", "feat-x", "--task-id", "T", "--role", "executor",
          "--plans-dir", plansDir,
          "--brief-file", "/tmp/brief.md", "--scope-paths", "src/",
          "--locked-test", "test/a.test.mjs", "--manifest", manifestPath,
          "--out", outPath,
        ],
        { cwd: REPO_ROOT, encoding: "utf8" },
      );
      assert.notEqual(res.status, 0);
      assert.match(res.stderr, /gpt-oss:120b/);
      assert.equal(existsSync(outPath), false, "no descriptor may be written for a refused model");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
