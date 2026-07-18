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
  listPresets,
  listRoutingTouchpoints,
  replaceFrontmatterModel,
  rewriteAgentsModelTable,
  routingFromPreset,
  validateRouting,
} from "./apply-routing.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ocSource = path.resolve(here, "../../..");

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

test("buildRoutingFromSlots rejects same-provider dual", () => {
  const bad = buildRoutingFromSlots({
    primaryEye: "openai/gpt-5.6-sol",
    secondaryEye: "openai/gpt-5.5",
  });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /providers diferentes|dual/i);
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
