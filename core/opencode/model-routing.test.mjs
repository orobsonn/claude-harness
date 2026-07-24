/** @description Regression tests for active OpenCode model fields and approved defaults. */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { vendorOpenCode } from "../claude-code/skills/initializing-projects/references/vendor-core.mjs";
import { seedOpencodeRootConfig } from "../vps/cron-a-dispatch.mjs";

const ocRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(ocRoot, "../..");

/**
 * The xAI/Grok ban covers every slot the harness REQUIRES: family-1 eyes, support eyes, hands,
 * build/planner. The optional `family-2` cross-family eye is exempt — it is fail-open (an
 * unauthenticated provider degrades the checkpoint to primary_only instead of breaking it), and a
 * second family that shares the first one's provider is worthless as an independent judgment.
 */
function activeJsonModels(value, models = [], path = "") {
  if (Array.isArray(value)) {
    for (const item of value) activeJsonModels(item, models, path);
    return models;
  }
  if (value == null || typeof value !== "object") return models;
  for (const [key, nested] of Object.entries(value)) {
    if ((key === "model" || key === "small_model") && typeof nested === "string") {
      models.push({ model: nested, path });
    }
    activeJsonModels(nested, models, `${path}/${key}`);
  }
  return models;
}

/** Compatibility aliases that ARE the family-2 eye under a legacy filename. */
const SECOND_FAMILY_ALIASES = new Set(["adversary-openai.md", "plan-reviewer-openai.md"]);

/** @description Model slugs in slots where xAI/Grok is banned (everything but the optional family-2 eye). */
function requiredSlotModels(entries) {
  return entries
    .filter((entry) => {
      if (entry.path.includes("family-2")) return false;
      return !SECOND_FAMILY_ALIASES.has(entry.path.split("/").pop());
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

test("the optional family-2 cross-family eye is the only slot allowed to be xAI/Grok", () => {
  const routing = JSON.parse(readFileSync(join(ocRoot, "harness.routing.json"), "utf8"));
  for (const role of routing.constraints.crossFamilyRoles) {
    const families = routing.roles[role].families;
    assert.equal(families["family-2"].model, "xai/grok-4.5", `${role} family-2 must be the Grok eye`);
    assert.equal(families["family-2"].optional, true, `${role} family-2 must stay fail-open`);
    assert.notEqual(
      families["family-1"].model.split("/")[0],
      families["family-2"].model.split("/")[0],
      `${role} families must stay on different providers`,
    );
  }
});

test("generated sidecar, vendored runtime, and VPS output expose only approved active models", () => {
  const root = mkdtempSync(join(tmpdir(), "model-routing-surfaces-"));
  const vendored = join(root, "vendored");
  const worktree = join(root, "worktree");
  mkdirSync(vendored);
  mkdirSync(worktree);
  try {
    writeFileSync(join(vendored, "opencode.json"), "{}\n");
    vendorOpenCode({
      coreDir: join(repoRoot, "core"),
      targetDir: vendored,
      version: "test",
      stampDate: "2026-07-14",
    });
    seedOpencodeRootConfig(worktree, repoRoot);

    const jsonPaths = [
      join(vendored, "opencode.json"),
      join(vendored, ".opencode", "harness.routing.json"),
      join(worktree, "opencode.json"),
      join(worktree, ".opencode", "harness.routing.json"),
    ];
    for (const path of jsonPaths) assert.equal(existsSync(path), true, `missing generated surface ${path}`);

    const active = jsonPaths.flatMap((path) => activeJsonModels(JSON.parse(readFileSync(path, "utf8"))));
    for (const agentsDir of [join(vendored, ".opencode", "agents"), join(worktree, ".opencode", "agents")]) {
      assert.equal(existsSync(agentsDir), true, `missing generated agents ${agentsDir}`);
      for (const file of readdirSync(agentsDir).filter((name) => name.endsWith(".md"))) {
        const match = readFileSync(join(agentsDir, file), "utf8").match(/^model:\s*(\S+)$/m);
        if (match) active.push({ model: match[1], path: `agents/${file}` });
      }
    }
    assert.deepEqual(requiredSlotModels(active).filter((model) => /(?:^xai\/|grok)/i.test(model)), []);

    // OC auto-globs `.opencode/plugin/*.{ts,js}`, so vendoring strips harness paths from
    // plugin[] (#402 — listing them too registered every hook factory twice). Delivery is
    // proven by the file on disk; the empty array pins the no-double-load invariant.
    const merged = JSON.parse(readFileSync(join(vendored, "opencode.json"), "utf8"));
    assert.deepEqual(merged.plugin, []);
    assert.equal(existsSync(join(vendored, ".opencode", "plugin", "planner-recovery.ts")), true);
    for (const routingPath of [jsonPaths[1], jsonPaths[3]]) {
      assert.equal(JSON.parse(readFileSync(routingPath, "utf8")).version, 2);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("approved defaults and test-author twins are active", () => {
  for (const relative of ["opencode.json", "core/opencode/opencode.json.example"]) {
    const config = JSON.parse(readFileSync(join(repoRoot, relative), "utf8"));
    assert.equal(config.model, "openai/gpt-5.6-terra");
    assert.equal(config.small_model, "openai/gpt-5.6-terra");
  }
  for (const agent of ["test-author.md", "test-author-spawn.md"]) {
    const body = readFileSync(join(ocRoot, "agents", agent), "utf8");
    assert.match(body, /^model: ollama-cloud\/glm-5\.2$/m);
  }
});
