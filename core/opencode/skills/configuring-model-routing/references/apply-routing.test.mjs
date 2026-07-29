/** @description Locked tests for configuring-model-routing apply module. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENT_MODEL_RESOLVERS,
  applyRoutingToDisk,
  buildRoutingFromSlots,
  CANONICAL_DEFAULT_ROUTING,
  listPresets,
  listRoutingTouchpoints,
  replaceFrontmatterModel,
  rewriteAgentsModelTable,
  routingFromPreset,
  validateRouting,
} from "./apply-routing.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ocSource = path.resolve(here, "../../..");

test("DRIFT GUARD: openai-ollama-default preset deep-equals the shipped harness.routing.json", () => {
  // Single source of truth: the default preset must reproduce the committed template exactly.
  // If this fails, the preset (via CANONICAL_DEFAULT_ROUTING) and harness.routing.json diverged —
  // applying the preset would overwrite the template. Fix BOTH together, never one.
  const built = routingFromPreset("openai-ollama-default");
  assert.equal(built.ok, true, built.reason);
  const shipped = JSON.parse(fs.readFileSync(path.join(ocSource, "harness.routing.json"), "utf8"));
  const { $schema, ...shippedNoSchema } = shipped;
  assert.ok($schema, "shipped harness.routing.json must keep its $schema");
  assert.deepEqual(built.routing, shippedNoSchema);
});

test("CANONICAL_DEFAULT_ROUTING is valid once capabilities are derived", () => {
  const built = routingFromPreset("openai-ollama-default");
  assert.equal(validateRouting(built.routing).ok, true);
  // sanity: the three-layer architecture is intact
  assert.equal(CANONICAL_DEFAULT_ROUTING.roles.build.model, "openai/gpt-5.6-terra");
  assert.equal(CANONICAL_DEFAULT_ROUTING.roles.security.model, "openai/gpt-5.6-sol");
  assert.equal(CANONICAL_DEFAULT_ROUTING.roles.harvester.model, "openai/gpt-5.6-luna");
});

test("HARDENING: buildRoutingFromSlots rejects unknown slot key (typo) instead of silent default", () => {
  const typo = buildRoutingFromSlots({
    primaryEye: "openai/gpt-5.6-sol",
    secondaryEye: "ollama-cloud/kimi-k2.7-code",
    supportEyes: "openai/gpt-5.6-luna", // note the trailing 's' — a typo
  });
  assert.equal(typo.ok, false);
  assert.match(typo.reason, /unknown slot key/i);
  assert.match(typo.reason, /supportEyes/);
});

test("HARDENING: buildRoutingFromSlots rejects unknown hands tier", () => {
  const bad = buildRoutingFromSlots({
    primaryEye: "openai/gpt-5.6-sol",
    secondaryEye: "ollama-cloud/kimi-k2.7-code",
    hands: { low: "ollama-cloud/gemma4:31b", mid: "ollama-cloud/glm-5.2", high: "ollama-cloud/kimi-k2.7-code" },
  });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /unknown hands tier/i);
  assert.match(bad.reason, /mid/);
});

test("HARDENING: buildRoutingFromSlots still accepts the full valid slot set", () => {
  const ok = buildRoutingFromSlots({
    primaryEye: "openai/gpt-5.6-sol",
    secondaryEye: "ollama-cloud/kimi-k2.7-code",
    supportEye: "openai/gpt-5.6-luna",
    hands: { low: "ollama-cloud/gemma4:31b", medium: "ollama-cloud/glm-5.2", high: "ollama-cloud/kimi-k2.7-code" },
    testAuthor: "ollama-cloud/glm-5.2",
  });
  assert.equal(ok.ok, true, ok.reason);
});

test("listRoutingTouchpoints covers routing agents AGENTS opencode", () => {
  const t = listRoutingTouchpoints().join(" ");
  assert.match(t, /harness\.routing\.json/);
  assert.match(t, /agents/);
  assert.match(t, /AGENTS\.md/);
  assert.match(t, /opencode\.json/);
});

test("every preset passes validateRouting", () => {
  for (const p of listPresets()) {
    const r = routingFromPreset(p.id);
    assert.equal(r.ok, true, `${p.id}: ${r.reason}`);
    assert.equal(validateRouting(r.routing).ok, true, p.id);
  }
});

test("buildRoutingFromSlots rejects same-provider second eye", () => {
  const bad = buildRoutingFromSlots({
    primaryEye: "openai/gpt-5.6-sol",
    secondaryEye: "openai/gpt-5.5",
  });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /providers diferentes|second eye|dual/i);
});

test("buildRoutingFromSlots accepts single evaluator without secondaryEye", () => {
  const ok = buildRoutingFromSlots({
    primaryEye: "openai/gpt-5.6-sol",
    supportEye: "openai/gpt-5.6-luna",
  });
  assert.equal(ok.ok, true, ok.reason);
  assert.equal(ok.routing.roles.adversary.model, "openai/gpt-5.6-sol");
  assert.equal(ok.routing.roles.adversary.secondEyeModel, undefined);
  assert.equal(ok.routing.roles["test-author"].model, "openai/gpt-5.6-sol");
});

test("replaceFrontmatterModel updates model line only", () => {
  const body = "---\ndescription: x\nmodel: old/provider\nmode: subagent\n---\n\n# Hi\n";
  const r = replaceFrontmatterModel(body, "new/model");
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  assert.match(r.body, /^model: new\/model$/m);
  assert.match(r.body, /# Hi/);
});

test("rewriteAgentsModelTable rewrites §8 from routing", () => {
  const sample = [
    "## 8. Model routing (operator default)",
    "",
    "| Role | Model |",
    "|---|---|",
    "| build | `old/model` |",
    "",
    "Default hands use the Ollama Cloud ladder. Reconfigure via skill `configuring-model-routing`.",
    "",
    "## 9. Hands vs eyes",
    "",
    "hands here",
  ].join("\n");
  const built = routingFromPreset("openai-ollama-default");
  assert.equal(built.ok, true);
  const r = rewriteAgentsModelTable(sample, built.routing);
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  assert.match(r.body, /openai\/gpt-5\.6-sol/);
  assert.match(r.body, /## 9\. Hands vs eyes/);
  assert.match(r.body, /hands here/);
});

test("applyRoutingToDisk on temp copy of agents updates frontmatter + routing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "apply-routing-"));
  try {
    const agentsSrc = path.join(ocSource, "agents");
    const agentsDst = path.join(root, "agents");
    fs.mkdirSync(agentsDst, { recursive: true });
    for (const f of fs.readdirSync(agentsSrc).filter((n) => n.endsWith(".md"))) {
      fs.copyFileSync(path.join(agentsSrc, f), path.join(agentsDst, f));
    }
    fs.copyFileSync(path.join(ocSource, "harness.routing.json"), path.join(root, "harness.routing.json"));
    fs.copyFileSync(path.join(ocSource, "AGENTS.md"), path.join(root, "AGENTS.md"));

    const built = buildRoutingFromSlots({
      primaryEye: "openai/gpt-5.6-sol",
      secondaryEye: "ollama-cloud/kimi-k2.7-code",
      supportEye: "openai/gpt-5.5",
      hands: {
        low: "ollama-cloud/gemma4:31b",
        medium: "ollama-cloud/glm-5.2",
        high: "ollama-cloud/kimi-k2.7-code",
      },
    });
    assert.equal(built.ok, true, built.reason);

    // Force a visible change on build agent
    built.routing.roles.build.model = "openai/gpt-5.5";
    built.routing.modelCapabilities["openai/gpt-5.5"] = { supportsReasoningEffort: true };

    const applied = applyRoutingToDisk({ targetRoot: root, routing: built.routing, updateOpencodeJson: false });
    assert.equal(applied.ok, true, applied.reason);
    assert.ok(applied.changed.some((p) => p.endsWith("harness.routing.json")));
    const buildMd = fs.readFileSync(path.join(agentsDst, "build.md"), "utf8");
    assert.match(buildMd, /^model: openai\/gpt-5\.5$/m);
    const agentsMd = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
    assert.match(agentsMd, /\| build \| `openai\/gpt-5\.5` \|/);

    // All resolvers with files present produce provider/model
    for (const [name, resolve] of Object.entries(AGENT_MODEL_RESOLVERS)) {
      if (name === "planner-fallback") continue;
      const file = path.join(agentsDst, `${name}.md`);
      if (!fs.existsSync(file)) continue;
      const m = resolve(built.routing.roles);
      assert.equal(typeof m, "string", name);
      assert.ok(m.includes("/"), name);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("applyRoutingToDisk refuses invalid routing without writing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "apply-routing-bad-"));
  try {
    fs.mkdirSync(path.join(root, "agents"));
    fs.writeFileSync(path.join(root, "harness.routing.json"), '{"version":2}\n');
    const before = fs.readFileSync(path.join(root, "harness.routing.json"), "utf8");
    const applied = applyRoutingToDisk({
      targetRoot: root,
      routing: { version: 2, roles: {}, constraints: {}, modelCapabilities: {} },
    });
    assert.equal(applied.ok, false);
    assert.equal(fs.readFileSync(path.join(root, "harness.routing.json"), "utf8"), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function seedMiniOcRoot(root) {
  const agentsSrc = path.join(ocSource, "agents");
  const agentsDst = path.join(root, "agents");
  fs.mkdirSync(agentsDst, { recursive: true });
  for (const f of ["build.md", "planner.md", "compliance.md", "security.md", "harvester.md", "shipper.md", "test-author.md", "executor-low.md", "executor-medium.md", "executor-high.md", "sniper-low.md", "sniper-medium.md", "sniper-high.md", "plan-reviewer.md", "adversary.md", "plan-reviewer-family-1.md", "plan-reviewer-family-2.md", "adversary-family-1.md", "adversary-family-2.md"]) {
    fs.copyFileSync(path.join(agentsSrc, f), path.join(agentsDst, f));
  }
  // minimal routing + AGENTS for path resolve
  const built = routingFromPreset("openai-ollama-default");
  assert.equal(built.ok, true);
  fs.writeFileSync(path.join(root, "harness.routing.json"), JSON.stringify({ $schema: "../../shared/schemas/harness-routing.schema.json", ...built.routing }, null, 2) + "\n");
  fs.copyFileSync(path.join(ocSource, "AGENTS.md"), path.join(root, "AGENTS.md"));
  return built.routing;
}

test("apply refuses weak support eyes without confirmWeakEyes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "apply-weak-"));
  try {
    seedMiniOcRoot(root);
    const built = buildRoutingFromSlots({
      primaryEye: "openai/gpt-5.6-sol",
      secondaryEye: "ollama-cloud/kimi-k2.7-code",
      supportEye: "ollama-cloud/gemma4:31b",
    });
    assert.equal(built.ok, true, built.reason);
    const denied = applyRoutingToDisk({ targetRoot: root, routing: built.routing, updateOpencodeJson: false });
    assert.equal(denied.ok, false);
    assert.match(denied.reason, /confirmWeakEyes/i);
    const ok = applyRoutingToDisk({
      targetRoot: root,
      routing: built.routing,
      updateOpencodeJson: false,
      confirmWeakEyes: true,
    });
    assert.equal(ok.ok, true, ok.reason);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("apply refuses weak judgment eyes without confirmWeakJudgmentEyes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "apply-weak-judge-"));
  try {
    seedMiniOcRoot(root);
    // primaryEye (→ family-1 of plan-reviewer + adversary) is a cheap hand model;
    // support kept strong so only the judgment floor can fire.
    const built = buildRoutingFromSlots({
      primaryEye: "ollama-cloud/glm-5.2",
      secondaryEye: "openai/gpt-5.6-sol",
      supportEye: "openai/gpt-5.5",
    });
    assert.equal(built.ok, true, built.reason);

    const denied = applyRoutingToDisk({ targetRoot: root, routing: built.routing, updateOpencodeJson: false });
    assert.equal(denied.ok, false);
    assert.match(denied.reason, /confirmWeakJudgmentEyes/i);

    // confirmWeakEyes (support flag) must NOT unlock weak judgment eyes.
    const stillDenied = applyRoutingToDisk({
      targetRoot: root,
      routing: built.routing,
      updateOpencodeJson: false,
      confirmWeakEyes: true,
    });
    assert.equal(stillDenied.ok, false);
    assert.match(stillDenied.reason, /confirmWeakJudgmentEyes/i);

    const ok = applyRoutingToDisk({
      targetRoot: root,
      routing: built.routing,
      updateOpencodeJson: false,
      confirmWeakJudgmentEyes: true,
    });
    assert.equal(ok.ok, true, ok.reason);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("apply refuses xAI/Grok on source mode without forceCoreGrok", () => {
  // ocSource is core/opencode → mode source
  const built = routingFromPreset("xai-ollama-dual");
  assert.equal(built.ok, true);
  const denied = applyRoutingToDisk({
    targetRoot: ocSource,
    routing: built.routing,
    updateOpencodeJson: false,
  });
  assert.equal(denied.ok, false);
  assert.match(denied.reason, /forceCoreGrok|blocked on harness source/i);
});

test("apply does not rewrite opencode.json above targetRoot", () => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), "apply-bound-"));
  try {
    const parentJson = path.join(outer, "opencode.json");
    fs.writeFileSync(parentJson, JSON.stringify({ model: "keep/me", small_model: "keep/small" }, null, 2) + "\n");
    const project = path.join(outer, "app");
    const oc = path.join(project, ".opencode");
    fs.mkdirSync(oc, { recursive: true });
    seedMiniOcRoot(oc);
    fs.writeFileSync(path.join(project, "opencode.json"), JSON.stringify({ model: "old/x", small_model: "old/y" }, null, 2) + "\n");

    const built = routingFromPreset("openai-ollama-default");
    const applied = applyRoutingToDisk({
      targetRoot: project,
      routing: built.routing,
      updateOpencodeJson: true,
    });
    assert.equal(applied.ok, true, applied.reason);
    const parent = JSON.parse(fs.readFileSync(parentJson, "utf8"));
    assert.equal(parent.model, "keep/me", "must not clobber parent opencode.json");
    const proj = JSON.parse(fs.readFileSync(path.join(project, "opencode.json"), "utf8"));
    assert.equal(proj.model, "openai/gpt-5.6-terra");
  } finally {
    fs.rmSync(outer, { recursive: true, force: true });
  }
});

test("apply preserves $schema on harness.routing.json", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "apply-schema-"));
  try {
    seedMiniOcRoot(root);
    const before = JSON.parse(fs.readFileSync(path.join(root, "harness.routing.json"), "utf8"));
    assert.ok(before.$schema);
    const built = routingFromPreset("openai-ollama-default");
    built.routing.roles.build.model = "openai/gpt-5.5";
    built.routing.modelCapabilities["openai/gpt-5.5"] = { supportsReasoningEffort: true };
    const applied = applyRoutingToDisk({ targetRoot: root, routing: built.routing, updateOpencodeJson: false });
    assert.equal(applied.ok, true, applied.reason);
    const after = JSON.parse(fs.readFileSync(path.join(root, "harness.routing.json"), "utf8"));
    assert.equal(after.$schema, before.$schema);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("apply hard-fails when AGENTS.md exists but §8 missing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "apply-agents-bad-"));
  try {
    seedMiniOcRoot(root);
    fs.writeFileSync(path.join(root, "AGENTS.md"), "# no section eight\n");
    const before = fs.readFileSync(path.join(root, "harness.routing.json"), "utf8");
    const built = routingFromPreset("openai-ollama-default");
    built.routing.roles.build.model = "openai/gpt-5.5";
    built.routing.modelCapabilities["openai/gpt-5.5"] = { supportsReasoningEffort: true };
    const applied = applyRoutingToDisk({ targetRoot: root, routing: built.routing, updateOpencodeJson: false });
    assert.equal(applied.ok, false);
    assert.match(applied.reason, /§8|section not found/i);
    assert.equal(fs.readFileSync(path.join(root, "harness.routing.json"), "utf8"), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
