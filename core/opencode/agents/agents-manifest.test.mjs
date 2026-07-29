/**
 * @description Locked tests for T6 OC agents/skills manifest (routing-aligned models, dual eyes, shared hand agents, skills).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = __dirname;
const OC_ROOT = join(__dirname, "..");
const SKILLS_DIR = join(OC_ROOT, "skills");
const ROUTING_PATH = join(OC_ROOT, "harness.routing.json");
const DECISIONS_DIR = join(OC_ROOT, "..", "..", "docs", "specs", "oc-port", "decisions");

function read(path) {
  return readFileSync(path, "utf8");
}

function frontmatter(md) {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(m, "missing YAML frontmatter");
  return m[1];
}

function fmField(fm, key) {
  // simple top-level scalar: key: value
  const re = new RegExp(`^${key}:\\s*(.+)$`, "m");
  const m = fm.match(re);
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : undefined;
}

function fmNestedBool(fm, parent, key) {
  // tools:\n  task: false
  const block = fm.match(new RegExp(`^${parent}:\\s*\\n((?:  .+\\n?)*)`, "m"));
  if (!block) return undefined;
  const line = block[1].match(new RegExp(`^  ${key}:\\s*(.+)$`, "m"));
  if (!line) return undefined;
  const v = line[1].trim();
  if (v === "false") return false;
  if (v === "true") return true;
  return v;
}

function requiresTaskLockdown(fm) {
  return fmField(fm, "mode") === "all" && fmNestedBool(fm, "permission", "edit") !== "deny";
}

const REQUIRED_AGENTS = [
  "build",
  "plan",
  "harness-config",
  "discussion-adversary",
  "planner",
  "planner-fallback",
  "plan-reviewer",
  "adversary",
  "compliance",
  "security",
  "executor-low",
  "executor-medium",
  "executor-high",
  "sniper-low",
  "sniper-medium",
  "sniper-high",
  "test-author",
  "harvester",
  "shipper",
];

// Directory names (never prefixed — renaming a skill directory is forbidden). The `name:`
// frontmatter carries the `oc-` prefix; the dir↔name invariant is locked in skill-catalog.test.mjs.
export const REQUIRED_SKILLS = [
  "triaging-requests",
  "brainstorming",
  "orchestrating-delivery",
  "recording-findings",
  "distilling-learnings",
  "proposing-improvements",
  "surveying-codebase",
  "committing-changes",
  "releasing-versions",
  "canonical-critical-classes",
  "authoring-rules",
  "configuring-model-routing",
  "importing-claude-memory",
  "creating-issues",
  "grill",
  "proposing-deepening",
  "creating-plans",
  "updating-harness",
];

/** Expected model per agent file from harness.routing.json contract */
function expectedModels(routing) {
  const r = routing.roles;
  return {
    build: r.build.model,
    plan: r.build.model,
    "harness-config": r.build.model,
    planner: r.planner.model,
    "plan-reviewer": r["plan-reviewer"].model,
    adversary: r.adversary.model,
    compliance: r.compliance.model,
    security: r.security.model,
    "executor-low": r.executor.tiers.low.model,
    "executor-medium": r.executor.tiers.medium.model,
    "executor-high": r.executor.tiers.high.model,
    "sniper-low": r.sniper.tiers.low.model,
    "sniper-medium": r.sniper.tiers.medium.model,
    "sniper-high": r.sniper.tiers.high.model,
    "test-author": r["test-author"].model,
    harvester: r.harvester.model,
    shipper: r.shipper.model,
  };
}

test("t6-agents: required agent files exist including test-author.md", () => {
  for (const name of REQUIRED_AGENTS) {
    const path = join(AGENTS_DIR, `${name}.md`);
    assert.ok(existsSync(path), `missing agent ${name}.md`);
  }
  assert.ok(existsSync(join(AGENTS_DIR, "test-author.md")), "test-author.md restored");
  assert.ok(
    !existsSync(join(AGENTS_DIR, "SPAWN-PATTERN.md")),
    "SPAWN-PATTERN.md must not live under agents/ (not a loadable agent)",
  );
  assert.ok(
    existsSync(join(OC_ROOT, "docs", "SPAWN-PATTERN.md")),
    "SPAWN-PATTERN.md documents P2 under docs/",
  );
});

test("t6-single-evaluator-files: canonical eyes + compatibility alias stubs", () => {
  assert.ok(existsSync(join(AGENTS_DIR, "plan-reviewer.md")));
  assert.ok(existsSync(join(AGENTS_DIR, "adversary.md")));
  for (const alias of [
    "plan-reviewer-openai.md",
    "adversary-openai.md",
    "plan-reviewer-family-1.md",
    "adversary-family-1.md",
  ]) {
    assert.ok(existsSync(join(AGENTS_DIR, alias)), `${alias} alias stub`);
  }
  // Optional second-eye agents exist for opt-in secondEyeModel dispatch
  assert.ok(existsSync(join(AGENTS_DIR, "plan-reviewer-family-2.md")));
  assert.ok(existsSync(join(AGENTS_DIR, "adversary-family-2.md")));
  const pr = frontmatter(read(join(AGENTS_DIR, "plan-reviewer.md")));
  const ad = frontmatter(read(join(AGENTS_DIR, "adversary.md")));
  assert.equal(fmField(pr, "model"), "openai/gpt-5.6-sol");
  assert.equal(fmField(ad, "model"), "openai/gpt-5.6-sol");
});

test("t6-build-prose: build.md still documents dual_status / secondary failure fields", () => {
  const body = read(join(AGENTS_DIR, "build.md"));
  const skill = read(join(SKILLS_DIR, "orchestrating-delivery", "SKILL.md"));
  assert.match(body, /primary_only|dual_status|secondary_status/i);
  assert.match(body, /dualPostsFor\(routing\)\[post\]\.secondary/i);
  assert.match(body, /secondEyeModel.*legacy `families\.family-2`/i);
  assert.match(skill, /dualPostsFor\(routing\).*secondary/i);
  for (const name of [
    "plan-reviewer-openai", "plan-reviewer-family-2",
    "adversary-openai", "adversary-family-2",
  ]) {
    const optionalPrompt = read(join(AGENTS_DIR, `${name}.md`));
    assert.match(optionalPrompt, /dualPostsFor\(routing\).*secondary/i, `${name} must use routing-resolved opt-in`);
    assert.match(optionalPrompt, /secondEyeModel.*legacy `families\.family-2`/i, `${name} must preserve legacy opt-in`);
  }
  assert.match(body, /two separate passes/i);
  assert.match(body, /file:function/i);
  for (const name of [
    "plan-reviewer", "plan-reviewer-family-1", "plan-reviewer-openai", "plan-reviewer-family-2",
    "adversary", "adversary-family-1", "adversary-openai", "adversary-family-2",
  ]) {
    const prompt = read(join(AGENTS_DIR, `${name}.md`));
    assert.match(prompt, /Artifact-consistency pass/i, `${name} must require artifact consistency`);
    assert.match(prompt, /Code-reality pass/i, `${name} must require code reality`);
    assert.match(prompt, /file:function/i, `${name} must require anchored evidence`);
  }
});

test("t6-skills: required loop skills exist under core/opencode/skills", () => {
  for (const name of REQUIRED_SKILLS) {
    const skillPath = join(SKILLS_DIR, name, "SKILL.md");
    assert.ok(existsSync(skillPath), `missing skill ${name}/SKILL.md`);
  }
});

test("t6-shared-hands: no spawn twins exist and each shared hand preserves its full contract", () => {
  const files = readdirSync(AGENTS_DIR).filter((f) => f.endsWith("-spawn.md"));
  assert.deepEqual(files, [], "retired *-spawn.md twins must not exist");
  for (const name of [
    "executor-low",
    "executor-medium",
    "executor-high",
    "sniper-low",
    "sniper-medium",
    "sniper-high",
    "test-author",
  ]) {
    const f = `${name}.md`;
    const fm = frontmatter(read(join(AGENTS_DIR, f)));
    assert.equal(fmField(fm, "mode"), "all", `${f} mode must be all`);
    assert.equal(fmField(fm, "model"), expectedModels(JSON.parse(read(ROUTING_PATH)))[name]);
    assert.equal(fmNestedBool(fm, "permission", "edit"), "allow", `${f} permission.edit must stay allow`);
    assert.equal(fmNestedBool(fm, "tools", "task"), false, `${f} tools.task must be false`);
  }
});

test("t6-mode-all-lockdown: every writable mode-all agent explicitly disables task dispatch", () => {
  assert.equal(requiresTaskLockdown("mode: all\nmodel: test/model"), true);
  assert.equal(requiresTaskLockdown("mode: all\npermission:\n  edit: deny"), false);
  for (const f of readdirSync(AGENTS_DIR).filter((name) => name.endsWith(".md"))) {
    const fm = frontmatter(read(join(AGENTS_DIR, f)));
    if (!requiresTaskLockdown(fm)) continue;
    assert.equal(fmNestedBool(fm, "tools", "task"), false, `${f} tools.task must be false`);
  }
});

test("t6-models-match-routing: agent frontmatter models match harness.routing.json", () => {
  const routing = JSON.parse(read(ROUTING_PATH));
  const expected = expectedModels(routing);
  for (const [name, model] of Object.entries(expected)) {
    const fm = frontmatter(read(join(AGENTS_DIR, `${name}.md`)));
    assert.equal(
      fmField(fm, "model"),
      model,
      `${name}.md model must be ${model}`,
    );
  }
  // Alias stubs: family-1 tracks primary; family-2 / openai are second-eye stubs (cross-provider).
  assert.equal(fmField(frontmatter(read(join(AGENTS_DIR, "adversary-family-1.md"))), "model"), expected.adversary);
  assert.equal(fmField(frontmatter(read(join(AGENTS_DIR, "plan-reviewer-family-1.md"))), "model"), expected["plan-reviewer"]);
  for (const second of ["adversary-family-2", "adversary-openai", "plan-reviewer-family-2", "plan-reviewer-openai"]) {
    const model = fmField(frontmatter(read(join(AGENTS_DIR, `${second}.md`))), "model");
    assert.ok(model && model.includes("/"), `${second} has a model`);
    assert.notEqual(model.split("/")[0], expected.adversary.split("/")[0], `${second} stays cross-provider vs primary`);
  }
});

test("executor and sniper tiers use the Ollama Cloud default ladder", () => {
  const routing = JSON.parse(read(ROUTING_PATH));
  const expected = [
    "ollama-cloud/gemma4:31b",
    "ollama-cloud/glm-5.2",
    "ollama-cloud/kimi-k2.7-code",
  ];
  for (const role of ["executor", "sniper"]) {
    assert.deepEqual(
      ["low", "medium", "high"].map((tier) => routing.roles[role].tiers[tier].model),
      expected,
      `${role} must use the Ollama Cloud ladder`,
    );
  }
  assert.match(read(join(DECISIONS_DIR, "ADR-001-no-ollama-default.md")), /superseded by ADR-004/i);
  assert.match(read(join(DECISIONS_DIR, "ADR-004-ollama-cloud-default-hands.md")), /Ollama Cloud/i);
});
