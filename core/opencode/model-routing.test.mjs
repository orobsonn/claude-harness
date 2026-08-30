/** @description Regression tests for active OpenCode model fields and approved defaults. */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { vendorOpenCode } from "../claude-code/skills/initializing-projects/references/vendor-core.mjs";

const ocRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(ocRoot, "../..");

/**
 * The xAI/Grok ban covers every required slot. Optional `secondEyeModel` is exempt —
 * it is fail-open and absent by default.
 */
function activeJsonModels(value, models = [], path = "") {
  if (Array.isArray(value)) {
    for (const item of value) activeJsonModels(item, models, path);
    return models;
  }
  if (value == null || typeof value !== "object") return models;
  for (const [key, nested] of Object.entries(value)) {
    if ((key === "model" || key === "small_model" || key === "secondEyeModel") && typeof nested === "string") {
      models.push({ model: nested, path: `${path}/${key}` });
    }
    activeJsonModels(nested, models, `${path}/${key}`);
  }
  return models;
}

/** Optional second-eye agent files (dispatched only when secondEyeModel is set). */
const SECOND_EYE_AGENT_FILES = new Set([
  "adversary-family-2.md",
  "plan-reviewer-family-2.md",
  "adversary-openai.md",
  "plan-reviewer-openai.md",
]);

/** @description Model slugs in slots where xAI/Grok is banned (everything but optional second eye). */
function requiredSlotModels(entries) {
  return entries
    .filter((entry) => {
      if (entry.path.endsWith("/secondEyeModel") || entry.path.includes("secondEyeModel")) return false;
      if (entry.path.includes("family-2")) return false;
      const base = entry.path.split("/").pop();
      return !SECOND_EYE_AGENT_FILES.has(base);
    })
    .map((entry) => entry.model);
}

test("active runtime model fields contain no xAI or Grok model", () => {
  const jsonPaths = [
    join(repoRoot, "opencode.json"),
    join(ocRoot, "opencode.json.example"),
    join(ocRoot, "harness.routing.json"),
  ];
  for (const path of jsonPaths) assert.equal(existsSync(path), true, `missing runtime surface ${path}`);
  const active = jsonPaths.flatMap((path) => activeJsonModels(JSON.parse(readFileSync(path, "utf8"))));
  for (const file of readdirSync(join(ocRoot, "agents")).filter((name) => name.endsWith(".md"))) {
    const match = readFileSync(join(ocRoot, "agents", file), "utf8").match(/^model:\s*(\S+)$/m);
    if (match) active.push({ model: match[1], path: `agents/${file}` });
  }
  assert.ok(active.length > 0);
  assert.deepEqual(requiredSlotModels(active).filter((model) => /(?:^xai\/|grok)/i.test(model)), []);
});

test("single evaluator eyes use Sol; secondEyeModel is absent by default", () => {
  const routing = JSON.parse(readFileSync(join(ocRoot, "harness.routing.json"), "utf8"));
  assert.equal(routing.roles.adversary.model, "openai/gpt-5.6-sol");
  assert.equal(routing.roles["plan-reviewer"].model, "openai/gpt-5.6-sol");
  assert.equal(routing.roles.adversary.families, undefined);
  assert.equal(routing.roles["plan-reviewer"].families, undefined);
  assert.equal(routing.roles.adversary.secondEyeModel, undefined);
  assert.equal(routing.roles["plan-reviewer"].secondEyeModel, undefined);
  assert.equal(routing.constraints?.requireDualOn, undefined);
  assert.equal(routing.constraints?.crossFamilyRoles, undefined);
  // Evaluator may match planner — same as the Claude Code lane.
  assert.equal(routing.roles.adversary.model, routing.roles.planner.model);
});

// #807: this test used to assert over a THIRD surface — the worktree that the retired
// `core/vps/cron-a-dispatch.mjs` seeded via `seedOpencodeRootConfig`. That engine is gone, so the
// worktree legs went with it. The vendored + sidecar legs are LIVE and stay exactly as they were:
// deleting this whole file to chase a green import would have dropped the approved-defaults oracles
// below, which pin the live `opencode.json` and `core/opencode/opencode.json.example` model fields.
test("generated sidecar and vendored runtime expose only approved active models", () => {
  const root = mkdtempSync(join(tmpdir(), "model-routing-surfaces-"));
  const vendored = join(root, "vendored");
  mkdirSync(vendored);
  try {
    writeFileSync(join(vendored, "opencode.json"), "{}\n");
    vendorOpenCode({
      coreDir: join(repoRoot, "core"),
      targetDir: vendored,
      version: "test",
      stampDate: "2026-07-14",
    });

    const jsonPaths = [
      join(vendored, "opencode.json"),
      join(vendored, ".opencode", "harness.routing.json"),
    ];
    for (const path of jsonPaths) assert.equal(existsSync(path), true, `missing generated surface ${path}`);

    const active = jsonPaths.flatMap((path) => activeJsonModels(JSON.parse(readFileSync(path, "utf8"))));
    for (const agentsDir of [join(vendored, ".opencode", "agents")]) {
      assert.equal(existsSync(agentsDir), true, `missing generated agents ${agentsDir}`);
      for (const file of readdirSync(agentsDir).filter((name) => name.endsWith(".md"))) {
        const match = readFileSync(join(agentsDir, file), "utf8").match(/^model:\s*(\S+)$/m);
        if (match) active.push({ model: match[1], path: `agents/${file}` });
      }
    }
    assert.deepEqual(requiredSlotModels(active).filter((model) => /(?:^xai\/|grok)/i.test(model)), []);

    const merged = JSON.parse(readFileSync(join(vendored, "opencode.json"), "utf8"));
    assert.deepEqual(merged.plugin, []);
    assert.equal(existsSync(join(vendored, ".opencode", "plugin", "planner-recovery.ts")), false);
    for (const routingPath of [jsonPaths[1]]) {
      const routing = JSON.parse(readFileSync(routingPath, "utf8"));
      assert.equal(routing.version, 2);
      assert.equal(routing.roles.adversary.model, "openai/gpt-5.6-sol");
      assert.equal(routing.roles["test-author"].model, "openai/gpt-5.6-terra");
      assert.equal(routing.roles.compliance.model, "openai/gpt-5.6-sol");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("approved defaults route test transcription to Terra and its fidelity eye to Sol", () => {
  for (const relative of ["opencode.json", "core/opencode/opencode.json.example"]) {
    const config = JSON.parse(readFileSync(join(repoRoot, relative), "utf8"));
    assert.equal(config.model, "openai/gpt-5.6-terra");
    assert.equal(config.small_model, "openai/gpt-5.6-terra");
  }
  const body = readFileSync(join(ocRoot, "agents", "test-author.md"), "utf8");
  const compliance = readFileSync(join(ocRoot, "agents", "compliance.md"), "utf8");
  assert.match(body, /^model: openai\/gpt-5\.6-terra$/m);
  assert.match(compliance, /^model: openai\/gpt-5\.6-sol$/m);
});
