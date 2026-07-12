/**
 * @description Integration-shape tests: after/before hooks use output.args (OC contract).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createObsPlanWriteHooks } from "./obs-plan-write.ts";
import { createObsEyeHooks } from "./obs-eye.ts";
import { createObsHandHooks } from "./obs-hand.ts";

test("obs-plan-write: output.args → plan-created with tasks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "obs-pw-"));
  try {
    const meta = join(dir, "obs.json");
    writeFileSync(meta, "{}");
    process.env.HARNESS_OBSERVABILITY_RUN_PATH = meta;
    const planRel = ".opencode/plans/feat/execution-plan.json";
    const planAbs = join(dir, planRel);
    mkdirSync(join(dir, ".opencode/plans/feat"), { recursive: true });
    writeFileSync(planAbs, JSON.stringify({ tasks: [{ id: "t1" }, { id: "t2" }] }));
    const hooks = await createObsPlanWriteHooks();
    await hooks["tool.execute.after"](
      { tool: "write" },
      { args: { filePath: planRel, content: JSON.stringify({ tasks: [1, 2] }) } },
    );
    const raw = readFileSync(join(dir, "obs.events.jsonl"), "utf8");
    assert.ok(raw.includes("plan-created"), raw);
    assert.ok(raw.includes('"tasks":2') || raw.includes('"tasks": 2'), raw);
  } finally {
    delete process.env.HARNESS_OBSERVABILITY_RUN_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("obs-eye: stub for THIS session-feature → spec-adversary; ignore other full plan", async () => {
  const dir = mkdtempSync(join(tmpdir(), "obs-eye-"));
  try {
    const meta = join(dir, "obs.json");
    writeFileSync(meta, "{}");
    process.env.HARNESS_OBSERVABILITY_RUN_PATH = meta;
    const sid = "ses_test1";
    const fid = "my-feat";
    mkdirSync(join(dir, ".opencode/plans/old-full"), { recursive: true });
    writeFileSync(
      join(dir, ".opencode/plans/old-full/execution-plan.json"),
      JSON.stringify({ tasks: [{ id: "x" }] }),
    );
    mkdirSync(join(dir, `.opencode/plans/${sid}-${fid}`), { recursive: true });
    writeFileSync(
      join(dir, `.opencode/plans/${sid}-${fid}/execution-plan.json`),
      JSON.stringify({ kind: "stub", tasks: [] }),
    );
    const hooks = await createObsEyeHooks(dir);
    await hooks["tool.execute.after"](
      { tool: "task", sessionID: sid },
      {
        args: { subagent_type: "adversary", feature_id: fid },
        output: "attack",
      },
    );
    const raw = readFileSync(join(dir, "obs.events.jsonl"), "utf8");
    assert.ok(raw.includes("spec-adversary"), raw);
  } finally {
    delete process.env.HARNESS_OBSERVABILITY_RUN_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("obs-hand: before task-executing + after hand-ran structural", async () => {
  const dir = mkdtempSync(join(tmpdir(), "obs-hand-"));
  try {
    const meta = join(dir, "obs.json");
    writeFileSync(meta, "{}");
    process.env.HARNESS_OBSERVABILITY_RUN_PATH = meta;
    const sid = "ses_h1";
    const fid = "feat-h";
    mkdirSync(join(dir, `.opencode/plans/${sid}-${fid}`), { recursive: true });
    writeFileSync(
      join(dir, `.opencode/plans/${sid}-${fid}/execution-plan.json`),
      JSON.stringify({ tasks: [{ id: "t-a" }, { id: "t-b" }] }),
    );
    const hooks = await createObsHandHooks(dir);
    const args = {
      subagent_type: "executor-medium",
      feature_id: fid,
      task_id: "t-b",
      model: "grok-4.3",
    };
    await hooks["tool.execute.before"]({ tool: "task", sessionID: sid }, { args });
    await hooks["tool.execute.after"]({ tool: "task", sessionID: sid }, { args });
    const raw = readFileSync(join(dir, "obs.events.jsonl"), "utf8");
    assert.ok(raw.includes("task-executing"), raw);
    assert.ok(raw.includes('"n":2'), raw);
    assert.ok(raw.includes("hand-ran"), raw);
    assert.ok(raw.includes("t-b"), raw);
  } finally {
    delete process.env.HARNESS_OBSERVABILITY_RUN_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("obs-hand: without task_id does not emit hand-ran unknown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "obs-hand-skip-"));
  try {
    const meta = join(dir, "obs.json");
    writeFileSync(meta, "{}");
    process.env.HARNESS_OBSERVABILITY_RUN_PATH = meta;
    const hooks = await createObsHandHooks(dir);
    await hooks["tool.execute.after"](
      { tool: "task", sessionID: "ses_x" },
      { args: { subagent_type: "executor-high" } },
    );
    // no events file or empty
    let raw = "";
    try {
      raw = readFileSync(join(dir, "obs.events.jsonl"), "utf8");
    } catch {
      raw = "";
    }
    assert.equal(raw.includes("unknown"), false, raw);
    assert.equal(raw.includes("hand-ran"), false, raw);
  } finally {
    delete process.env.HARNESS_OBSERVABILITY_RUN_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});
