/**
 * @description Integration-shape tests: after-hooks use output.args (OC contract).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createObsPlanWriteHooks } from "./obs-plan-write.ts";
import { createObsEyeHooks } from "./obs-eye.ts";

test("obs-plan-write after-hook: output.args path under .opencode/plans emits plan-created", async () => {
  const dir = mkdtempSync(join(tmpdir(), "obs-pw-"));
  try {
    const meta = join(dir, "obs.json");
    writeFileSync(meta, "{}");
    process.env.HARNESS_OBSERVABILITY_RUN_PATH = meta;
    const hooks = await createObsPlanWriteHooks();
    await hooks["tool.execute.after"](
      { tool: "write" },
      { args: { filePath: join(dir, ".opencode/plans/feat/execution-plan.json") } },
    );
    // path must include .opencode/plans segments — use relative-style path
    await hooks["tool.execute.after"](
      { tool: "write" },
      { args: { filePath: ".opencode/plans/feat/execution-plan.json" } },
    );
    const lines = readFileSync(join(dir, "obs.events.jsonl"), "utf8").trim().split("\n");
    assert.ok(lines.some((l) => l.includes("plan-created")), lines.join("\n"));
  } finally {
    delete process.env.HARNESS_OBSERVABILITY_RUN_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("obs-eye after-hook: output.args subagent_type adversary + stub plan → spec-adversary", async () => {
  const dir = mkdtempSync(join(tmpdir(), "obs-eye-"));
  try {
    const meta = join(dir, "obs.json");
    writeFileSync(meta, "{}");
    process.env.HARNESS_OBSERVABILITY_RUN_PATH = meta;
    // stub plan only
    const planDir = join(dir, ".opencode/plans/feat");
    mkdirSync(planDir, { recursive: true });
    writeFileSync(join(planDir, "execution-plan.json"), JSON.stringify({ kind: "stub", tasks: [] }));
    const hooks = await createObsEyeHooks(dir);
    await hooks["tool.execute.after"](
      { tool: "task" },
      { args: { subagent_type: "adversary" }, output: "attack done" },
    );
    const raw = readFileSync(join(dir, "obs.events.jsonl"), "utf8");
    assert.ok(raw.includes("spec-adversary"), raw);
  } finally {
    delete process.env.HARNESS_OBSERVABILITY_RUN_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("obs-eye after-hook: full plan + adversary → eye (not curated spec-adversary)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "obs-eye-full-"));
  try {
    const meta = join(dir, "obs.json");
    writeFileSync(meta, "{}");
    process.env.HARNESS_OBSERVABILITY_RUN_PATH = meta;
    const planDir = join(dir, ".opencode/plans/feat");
    mkdirSync(planDir, { recursive: true });
    writeFileSync(
      join(planDir, "execution-plan.json"),
      JSON.stringify({ tasks: [{ id: "t1" }] }),
    );
    const hooks = await createObsEyeHooks(dir);
    await hooks["tool.execute.after"](
      { tool: "task" },
      { args: { subagent_type: "adversary" }, output: "x" },
    );
    const raw = readFileSync(join(dir, "obs.events.jsonl"), "utf8");
    assert.ok(raw.includes('"type":"eye"'), raw);
    assert.ok(!raw.includes("spec-adversary"), raw);
  } finally {
    delete process.env.HARNESS_OBSERVABILITY_RUN_PATH;
    rmSync(dir, { recursive: true, force: true });
  }
});
