/** @description End-to-end coordinator consumption of real entry-gate denials with closed transition mapping. */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerHooks } from "node:module";

const stub = `
  const schemaValue = { optional() { return this }, describe() { return this } };
  export const tool = (definition) => definition;
  tool.schema = {
    string() { return Object.create(schemaValue) },
    object(shape) { return { ...Object.create(schemaValue), shape } },
  };
`;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@opencode-ai/plugin/tool") {
      return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const { parseCeremonyDenial, consumeNextTransition } = await import("../skills/orchestrating-delivery/ceremony-runtime.mjs");

const SESSION = "ses-coordinator";
const FEATURE = "coordinator-consumer";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ceremony-coordinator-"));
  const stateFile = path.join(root, ".opencode", "plans", ".state", SESSION, "gate-state.json");
  const specFile = path.join(root, ".opencode", "plans", `${SESSION}-${FEATURE}`, "spec.md");
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.mkdirSync(path.dirname(specFile), { recursive: true });
  fs.writeFileSync(specFile, "# Spec\n\n#uj-1\n\n#ac-1.1\n");
  fs.writeFileSync(path.join(root, ".opencode", "harness.routing.json"), JSON.stringify({
    roles: { planner: { model: "openai/gpt-5.6-sol" } },
  }));
  fs.writeFileSync(stateFile, JSON.stringify({
    session_id: SESSION,
    feature_id: FEATURE,
    ceremony_generation: "generation-coordinator",
    classified: true,
    mode: "FULL",
  }));
  return {
    root,
    stateFile,
    read: () => JSON.parse(fs.readFileSync(stateFile, "utf8")),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

async function loadRegisteredRuntime(root) {
  // OC auto-globs `.opencode/plugin/*.{ts,js}`; harness paths are deliberately absent from
  // opencode.json plugin[] (#402 — listing them loaded every hook factory twice). The plugin
  // directory is therefore the registration source of truth.
  const required = ["entry-gate.ts", "marker-authority.ts", "ceremony-coordinator.ts", "planner-recovery.ts"];
  const pluginDir = path.resolve("core/opencode/plugin");
  const autoGlobbed = new Set(fs.readdirSync(pluginDir).filter((name) => /\.(ts|js)$/.test(name)));
  assert.deepEqual(required.filter((name) => autoGlobbed.has(name)), required);
  const plugins = [];
  for (const name of required) {
    const modulePath = path.join(pluginDir, name);
    const plugin = (await import(new URL(`file://${modulePath}`).href)).default;
    plugins.push(await plugin({ directory: root, worktree: root }));
  }
  const tools = Object.assign({}, ...plugins.map((plugin) => plugin.tool ?? {}));
  return {
    tools,
    async before(input, output) {
      for (const plugin of plugins) await plugin["tool.execute.before"]?.(input, output);
    },
    async after(input, output) {
      for (const plugin of plugins) await plugin["tool.execute.after"]?.(input, output);
    },
  };
}

function plannerInput(callID = "planner-call") {
  return {
    input: { tool: "task", sessionID: SESSION, callID },
    output: { args: { subagent_type: "planner", prompt: "Plan." } },
  };
}

async function realDenial(runtime) {
  const planner = plannerInput();
  try {
    await runtime.before(planner.input, planner.output);
    assert.fail("planner preflight unexpectedly allowed");
  } catch (error) {
    const parsed = parseCeremonyDenial(error);
    assert.equal(parsed.ok, true);
    return parsed.denial;
  }
}

async function invokeTool(runtime, name, args, callID) {
  const input = { tool: name, sessionID: SESSION, callID };
  const output = { args };
  await runtime.before(input, output);
  return runtime.tools[name].execute(args, {
    sessionID: SESSION,
    callID,
    messageID: `message-${callID}`,
    agent: "build",
    directory: "/ignored",
    worktree: "/ignored",
  });
}

test("real gate denial is consumed into the only official brainstorming descriptor", async () => {
  const run = fixture();
  try {
    const runtime = await loadRegisteredRuntime(run.root);
    const denial = await realDenial(runtime);
    const consumed = await invokeTool(runtime, "ceremony-next", { denial }, "consume-brainstorm");
    assert.equal(consumed.metadata.ok, true, consumed.output);
    assert.deepEqual(consumed.metadata.descriptor.coordinator_step, { kind: "skill", name: "brainstorming" });
    assert.deepEqual(consumed.metadata.descriptor.completion_transition, { tool: "mark", action: "brainstormed" });
    assert.doesNotMatch(JSON.stringify(consumed.metadata), /explore|general/);
  } finally { run.cleanup(); }
});

test("registered runtime consumes real denial, captures adversary after-hook, marks officially, and releases planner", async () => {
  const run = fixture();
  try {
    const runtime = await loadRegisteredRuntime(run.root);
    const brainstormDenial = await realDenial(runtime);
    const brainstormConsumed = await invokeTool(runtime, "ceremony-next", { denial: brainstormDenial }, "consume-initial");
    assert.equal(brainstormConsumed.metadata.ok, true, brainstormConsumed.output);
    const brainstormDescriptor = brainstormConsumed.metadata.descriptor;
    const brainstormMarkArgs = { action: brainstormDescriptor.completion_transition.action };
    const brainstormMarked = await invokeTool(runtime, brainstormDescriptor.completion_transition.tool, brainstormMarkArgs, "mark-brainstorm");
    assert.equal(brainstormMarked.metadata.ok, true, brainstormMarked.output);

    const evidenceOnly = { ...run.read(), brainstormed: false, brainstormed_binding: null, marker_seals: null };
    fs.writeFileSync(run.stateFile, JSON.stringify(evidenceOnly));

    const denial = await realDenial(runtime);
    const consumed = await invokeTool(runtime, "ceremony-next", { denial }, "consume-adversary");
    assert.equal(consumed.metadata.ok, true, consumed.output);
    const descriptor = consumed.metadata.descriptor;
    assert.equal(descriptor.coordinator_step.kind, "task");
    assert.equal(typeof descriptor.coordinator_step.description, "string");
    assert.match(descriptor.coordinator_step.description, /\S/);
    assert.match(descriptor.coordinator_step.description, new RegExp(FEATURE));
    assert.match(descriptor.coordinator_step.prompt, new RegExp(`\\.opencode/plans/${SESSION}-${FEATURE}/spec\\.md`));
    assert.match(descriptor.coordinator_step.prompt, /single top-level key issues/);
    assert.match(descriptor.coordinator_step.prompt, /Do not add verdict/);
    assert.match(descriptor.coordinator_step.prompt, /sweep/);
    assert.match(descriptor.coordinator_step.prompt, /mechanism/);
    assert.doesNotMatch(descriptor.coordinator_step.prompt, /\bSHIP\b/);
    assert.doesNotMatch(descriptor.coordinator_step.prompt, /\bBLOCK\b/);

    const adversaryArgs = {
      description: descriptor.coordinator_step.description,
      subagent_type: descriptor.coordinator_step.subagent_type,
      prompt: descriptor.coordinator_step.prompt,
    };
    const adversaryInput = { tool: "task", sessionID: SESSION, callID: "adversary-call" };
    const adversaryOutput = { args: adversaryArgs, output: '{"issues":[]}', metadata: {} };
    await assert.doesNotReject(() => runtime.before(adversaryInput, adversaryOutput));
    await runtime.after(adversaryInput, adversaryOutput);

    const adversaryMarkArgs = { action: descriptor.completion_transition.action };
    const marked = await invokeTool(runtime, descriptor.completion_transition.tool, adversaryMarkArgs, "mark-adversary");
    assert.equal(marked.metadata.ok, true, marked.output);
    const finalPlanner = plannerInput("planner-final");
    await assert.doesNotReject(() => runtime.before(finalPlanner.input, finalPlanner.output));
    assert.doesNotMatch(JSON.stringify(descriptor), /explore|general/);
  } finally { run.cleanup(); }
});

test("malformed, unknown, arbitrary-role, and state-inconsistent denials fail closed", () => {
  const validState = { brainstormedCurrent: true, adversaryCurrent: false, sessionId: SESSION, featureId: FEATURE };
  for (const denial of [
    null,
    { code: "OTHER", missing_proof: "spec_adversary_completion_evidence", next_transition: { phase: "spec-adversary", action: "resume", marker: "adversary_fired" } },
    { code: "CEREMONY_PROOF_REQUIRED", missing_proof: "unknown", next_transition: { phase: "explore", action: "dispatch", marker: "general" } },
    { code: "CEREMONY_PROOF_REQUIRED", missing_proof: "spec_adversary_completion_evidence", next_transition: { phase: "spec-adversary", action: "resume", marker: "adversary_fired", subagent_type: "general" } },
  ]) {
    assert.equal(consumeNextTransition(denial, validState).ok, false);
  }
  const realShape = {
    code: "CEREMONY_PROOF_REQUIRED",
    missing_proof: "spec_adversary_completion_evidence",
    next_transition: { phase: "spec-adversary", action: "resume", marker: "adversary_fired" },
  };
  assert.equal(consumeNextTransition(realShape, { brainstormedCurrent: false, adversaryCurrent: false }).ok, false);
  assert.equal(parseCeremonyDenial("[entry-gate] not-json").ok, false);
});
