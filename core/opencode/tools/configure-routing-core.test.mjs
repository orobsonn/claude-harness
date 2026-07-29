/** @description Locked tests for the configure-routing native tool core. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as engine from "../skills/configuring-model-routing/references/apply-routing.mjs";
import { parseSlots, runConfigureRouting } from "./configure-routing-core.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ocSource = path.resolve(here, "../skills/configuring-model-routing");
const agentsSrc = path.resolve(here, "../agents");
const agentsMdSrc = path.resolve(here, "../AGENTS.md");

function seedMiniOcRoot(root) {
  const agentsDst = path.join(root, "agents");
  fs.mkdirSync(agentsDst, { recursive: true });
  for (const f of [
    "build.md", "planner.md", "compliance.md", "security.md", "harvester.md", "shipper.md",
    "test-author.md", "executor-low.md", "executor-medium.md", "executor-high.md",
    "sniper-low.md", "sniper-medium.md", "sniper-high.md",
    "plan-reviewer.md", "adversary.md",
    "plan-reviewer-family-1.md", "plan-reviewer-family-2.md",
    "adversary-family-1.md", "adversary-family-2.md",
  ]) {
    fs.copyFileSync(path.join(agentsSrc, f), path.join(agentsDst, f));
  }
  const built = engine.routingFromPreset("openai-ollama-default");
  assert.equal(built.ok, true);
  fs.writeFileSync(
    path.join(root, "harness.routing.json"),
    JSON.stringify({ $schema: "x", ...built.routing }, null, 2) + "\n",
  );
  fs.copyFileSync(agentsMdSrc, path.join(root, "AGENTS.md"));
}

void ocSource;

test("parseSlots accepts object, JSON string, rejects array/garbage", () => {
  assert.deepEqual(parseSlots(null), { ok: true, slots: null });
  assert.deepEqual(parseSlots({ a: 1 }), { ok: true, slots: { a: 1 } });
  assert.deepEqual(parseSlots('{"a":1}'), { ok: true, slots: { a: 1 } });
  assert.equal(parseSlots("[1,2]").ok, false);
  assert.equal(parseSlots("not json").ok, false);
  assert.equal(parseSlots([1]).ok, false);
});

test("inspect returns presets, touchpoints, current routing (read-only)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-inspect-"));
  try {
    seedMiniOcRoot(root);
    const res = await runConfigureRouting({ action: "inspect" }, { directory: root }, engine);
    assert.equal(res.metadata.ok, true);
    assert.ok(Array.isArray(res.metadata.presets) && res.metadata.presets.length > 0);
    assert.ok(Array.isArray(res.metadata.touchpoints));
    assert.equal(res.metadata.current.version, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("apply with preset writes touchpoints under cwd (targetRoot pinned)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-apply-"));
  try {
    seedMiniOcRoot(root);
    const res = await runConfigureRouting(
      { action: "apply", preset: "openai-ollama-default", update_opencode_json: false },
      { directory: root },
      engine,
    );
    assert.equal(res.metadata.ok, true, res.metadata.reason);
    assert.ok(Array.isArray(res.metadata.changed));
    // every changed path is under the pinned cwd
    for (const p of res.metadata.changed) {
      assert.ok(p.startsWith(root), `write escaped cwd: ${p}`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("apply with weak judgment slots is rejected (needs confirm_weak_judgment_eyes)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-weak-"));
  try {
    seedMiniOcRoot(root);
    const slots = JSON.stringify({
      primaryEye: "ollama-cloud/glm-5.2",
      secondaryEye: "openai/gpt-5.6-sol",
      supportEye: "openai/gpt-5.5",
    });
    const denied = await runConfigureRouting(
      { action: "apply", slots, update_opencode_json: false },
      { directory: root },
      engine,
    );
    assert.equal(denied.metadata.ok, false);
    assert.match(denied.metadata.reason, /confirmWeakJudgmentEyes/i);

    const ok = await runConfigureRouting(
      { action: "apply", slots, update_opencode_json: false, confirm_weak_judgment_eyes: true },
      { directory: root },
      engine,
    );
    assert.equal(ok.metadata.ok, true, ok.metadata.reason);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("apply with no preset and no slots errors", async () => {
  const res = await runConfigureRouting({ action: "apply" }, { directory: os.tmpdir() }, engine);
  assert.equal(res.metadata.ok, false);
  assert.match(res.metadata.reason, /preset|slots/i);
});

test("unknown action errors", async () => {
  const res = await runConfigureRouting({ action: "nuke" }, { directory: os.tmpdir() }, engine);
  assert.equal(res.metadata.ok, false);
  assert.match(res.metadata.reason, /unknown action/i);
});

const CANONICAL_MODELS = [
  "openai/gpt-5.6-terra",
  "openai/gpt-5.6-sol",
  "openai/gpt-5.6-luna",
  "ollama-cloud/gemma4:31b",
  "ollama-cloud/glm-5.2",
  "ollama-cloud/kimi-k2.7-code",
  "xai/grok-4.5",
];

test("apply rejects a model missing from the binary catalog (before writing)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-missing-model-"));
  try {
    seedMiniOcRoot(root);
    const before = fs.readFileSync(path.join(root, "harness.routing.json"), "utf8");
    // catalog is missing terra → default preset (build=terra) must be rejected
    const catalogWithoutTerra = CANONICAL_MODELS.filter((m) => m !== "openai/gpt-5.6-terra");
    const res = await runConfigureRouting(
      { action: "apply", preset: "openai-ollama-default", update_opencode_json: false },
      { directory: root },
      engine,
      { listModels: async () => catalogWithoutTerra },
    );
    assert.equal(res.metadata.ok, false);
    assert.match(res.metadata.reason, /gpt-5\.6-terra/);
    assert.match(res.metadata.reason, /catálogo|opencode models/i);
    assert.equal(fs.readFileSync(path.join(root, "harness.routing.json"), "utf8"), before, "must not write on rejection");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("apply proceeds when every model is present in the catalog", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-model-ok-"));
  try {
    seedMiniOcRoot(root);
    const res = await runConfigureRouting(
      { action: "apply", preset: "openai-ollama-default", update_opencode_json: false },
      { directory: root },
      engine,
      { listModels: async () => CANONICAL_MODELS },
    );
    assert.equal(res.metadata.ok, true, res.metadata.reason);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("model validation is FAIL-OPEN: listModels throwing does not block a valid apply", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-model-failopen-"));
  try {
    seedMiniOcRoot(root);
    const res = await runConfigureRouting(
      { action: "apply", preset: "openai-ollama-default", update_opencode_json: false },
      { directory: root },
      engine,
      {
        listModels: async () => {
          throw new Error("opencode binary not found");
        },
      },
    );
    assert.equal(res.metadata.ok, true, res.metadata.reason);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("model validation FAIL-OPEN: empty catalog is skipped, not treated as all-missing", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-model-empty-"));
  try {
    seedMiniOcRoot(root);
    const res = await runConfigureRouting(
      { action: "apply", preset: "openai-ollama-default", update_opencode_json: false },
      { directory: root },
      engine,
      { listModels: async () => [] },
    );
    assert.equal(res.metadata.ok, true, res.metadata.reason);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
