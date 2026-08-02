/**
 * @description Pins the plugin contract for `createAgentIdleNudgeHooks` (or equivalent default export)
 * from `./agent-idle-nudge.ts` — the thin `tool.execute.after` carrier that emits
 * `output.metadata.agent_idle_nudge` (same observable class as dual_nudge) for main-loop
 * idle Task/agent dispatches.
 *
 * Mirrors pattern from `core/opencode/plugin/obs-eye.test.mjs` (create*Hooks + tool.execute.after).
 * Uses dynamic import so the test file loads and individual tests report RED when the module
 * is absent (instead of top-level module resolution failure).
 *
 * Fail-open: the hook must never throw; on nested (agent_id/agentId/agentID present on input)
 * it must not set the metadata key.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PLUGIN_URL = new URL("./agent-idle-nudge.ts", import.meta.url);

test(
  "lt-idle-plugin-metadata-carrier: Import createAgentIdleNudgeHooks (or equivalent) from agent-idle-nudge.ts; " +
    "Simulate tool.execute.after with tool='task', no agent_id on input, empty response → " +
    "output.metadata.agent_idle_nudge is non-empty string; " +
    "Nested with agent_id on input → metadata not set; Fail-open: never throws",
  async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "agent-idle-nudge-plugin-"));
    try {
      const mod = await import(PLUGIN_URL);
      const createAgentIdleNudgeHooks = mod.agentIdleNudgeTestApi?.createAgentIdleNudgeHooks ?? mod.default;

      assert.ok(
        typeof createAgentIdleNudgeHooks === "function",
        "createAgentIdleNudgeHooks (or default) must be a function",
      );

      // main-loop idle case (no agent_* key on input, empty response)
      const hooks = await createAgentIdleNudgeHooks(projectRoot);
      const input = { tool: "task" };
      const output = { output: "", metadata: {} };
      await assert.doesNotReject(() => hooks["tool.execute.after"](input, output));
      assert.equal(
        typeof output.metadata?.agent_idle_nudge,
        "string",
        "output.metadata.agent_idle_nudge must be a string after main-loop idle",
      );
      assert.ok(
        output.metadata.agent_idle_nudge.length > 0,
        "output.metadata.agent_idle_nudge must be non-empty",
      );

      // nested with agent_id (falsy value still counts as nested) → must not set
      const inputNested = { tool: "task", agent_id: "" };
      const outputNested = { output: "", metadata: {} };
      await hooks["tool.execute.after"](inputNested, outputNested);
      assert.equal(
        outputNested.metadata?.agent_idle_nudge,
        undefined,
        "nested agent_id present (even falsy) must not set agent_idle_nudge metadata",
      );

      // also via agentId
      const inputAgentId = { tool: "agent", agentId: 0 };
      const outputAgentId = { output: "   ", metadata: {} };
      await assert.doesNotReject(() => hooks["tool.execute.after"](inputAgentId, outputAgentId));
      assert.ok(
        !("agent_idle_nudge" in (outputAgentId.metadata || {})),
        "agentId present must not inject agent_idle_nudge",
      );
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  },
);

test("lt-idle-plugin-fail-open: createAgentIdleNudgeHooks + hook never throws on malformed calls", async () => {
  const mod = await import(PLUGIN_URL);
  const createAgentIdleNudgeHooks = mod.agentIdleNudgeTestApi?.createAgentIdleNudgeHooks ?? mod.default;

  const hooks = await createAgentIdleNudgeHooks();
  await assert.doesNotReject(async () => {
    if (hooks && typeof hooks["tool.execute.after"] === "function") {
      await hooks["tool.execute.after"](null, null);
      await hooks["tool.execute.after"]({ tool: "bash" }, { output: "" });
    }
  });
});
