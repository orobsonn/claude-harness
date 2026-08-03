/** @description Integration contract for the native OpenCode autonomy continuation plugin. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PLUGIN_URL = new URL("./autonomy-controller.ts", import.meta.url);

function statePath(root, sessionID) {
  return path.join(root, ".opencode", "plans", ".state", sessionID, "gate-state.json");
}

test("operator autonomy is persisted and an idle build session is re-prompted for its next legal phase", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-autonomy-controller-"));
  const sessionID = "ses-autonomy";
  const file = statePath(root, sessionID);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    session_id: sessionID,
    feature_id: "autonomy-fix",
    classified: true,
    planner_status: "usable",
  }));
  const prompts = [];
  try {
    const mod = await import(`${PLUGIN_URL.href}?t=${Date.now()}`);
    const hooks = await mod.default({
      directory: root,
      client: {
        session: {
          async promptAsync(input) { prompts.push(input); return { data: undefined }; },
        },
      },
    });

    await hooks["chat.message"](
      {
        sessionID,
        agent: "build",
        model: { providerID: "xai", modelID: "grok-4.5" },
        variant: "high",
      },
      { message: {}, parts: [{ type: "text", text: "siga a implementacao de forma autonoma" }] },
    );
    const persisted = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(persisted.autonomy_directive, "enabled");
    assert.deepEqual(persisted.operator_session_model, {
      providerID: "xai",
      modelID: "grok-4.5",
      variant: "high",
    });

    await hooks.event({ event: { type: "session.idle", properties: { sessionID } } });
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].path.id, sessionID);
    assert.match(prompts[0].body.parts[0].text, /plan-reviewer/i);
    assert.match(prompts[0].body.parts[0].text, /do not stop|nao encerre/i);
    assert.deepEqual(prompts[0].body.model, { providerID: "xai", modelID: "grok-4.5" });
    assert.equal(prompts[0].body.agent, "build");
    assert.equal(prompts[0].body.variant, "high");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("continue messages do not overwrite the operator model", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-autonomy-model-preserve-"));
  const sessionID = "ses-autonomy-model";
  const file = statePath(root, sessionID);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    session_id: sessionID,
    feature_id: "autonomy-model",
    classified: true,
    planner_status: "usable",
    autonomy_directive: "enabled",
    operator_session_model: { providerID: "xai", modelID: "grok-4.5", variant: "high" },
  }));
  try {
    const mod = await import(`${PLUGIN_URL.href}?t=${Date.now()}-model`);
    const hooks = await mod.default({ directory: root, client: {} });

    await hooks["chat.message"](
      {
        sessionID,
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-5.6-terra" },
      },
      { message: {}, parts: [{ type: "text", text: "[HARNESS_AUTONOMY_CONTINUE]\nresume" }] },
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).operator_session_model, {
      providerID: "xai",
      modelID: "grok-4.5",
      variant: "high",
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("autonomy controller does not re-prompt a completed or product-blocked session", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-autonomy-controller-"));
  const sessionID = "ses-autonomy-stop";
  const file = statePath(root, sessionID);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const prompts = [];
  try {
    const mod = await import(`${PLUGIN_URL.href}?t=${Date.now()}-stop`);
    const hooks = await mod.default({
      directory: root,
      client: { session: { async promptAsync(input) { prompts.push(input); } } },
    });
    for (const state of [
      { session_status: "completed" },
      { product_decision_pending: true },
    ]) {
      fs.writeFileSync(file, JSON.stringify({ session_id: sessionID, feature_id: "autonomy-fix", classified: true, autonomy_directive: "enabled", ...state }));
      await hooks.event({ event: { type: "session.idle", properties: { sessionID } } });
    }
    assert.equal(prompts.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("plan-reviewer completion is persisted from the official task arguments before the next idle continuation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-autonomy-controller-"));
  const sessionID = "ses-autonomy-review";
  const file = statePath(root, sessionID);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ session_id: sessionID, feature_id: "autonomy-fix", classified: true, planner_status: "usable" }));
  try {
    const mod = await import(`${PLUGIN_URL.href}?t=${Date.now()}-review`);
    const hooks = await mod.default({ directory: root, client: {} });
    await hooks["tool.execute.after"](
      { tool: "task", sessionID, tool_input: { subagent_type: "plan-reviewer" } },
      { output: '{"verdict":"APPROVE","findings":[]}' },
    );
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).plan_review_verdict, "APPROVE");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
