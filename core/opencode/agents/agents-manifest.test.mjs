/**
 * @description Locked tests for T6 OC agents/skills manifest (routing-aligned models, dual eyes, spawn primary, skills).
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

const REQUIRED_AGENTS = [
  "build",
  "plan",
  "harness-config",
  "discussion-adversary",
  "planner",
  "planner-fallback",
  "plan-reviewer",
  "plan-reviewer-openai",
  "plan-reviewer-family-1",
  "plan-reviewer-family-2",
  "adversary",
  "adversary-openai",
  "adversary-family-1",
  "adversary-family-2",
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
    "plan-reviewer": r["plan-reviewer"].families["family-1"].model,
    "plan-reviewer-openai": r["plan-reviewer"].families["family-2"].model,
    "plan-reviewer-family-1": r["plan-reviewer"].families["family-1"].model,
    "plan-reviewer-family-2": r["plan-reviewer"].families["family-2"].model,
    adversary: r.adversary.families["family-1"].model,
    "adversary-openai": r.adversary.families["family-2"].model,
    "adversary-family-1": r.adversary.families["family-1"].model,
    "adversary-family-2": r.adversary.families["family-2"].model,
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

/** The second-family eye is read from routing, not restated — the routing file is the single source. */
const SECOND_FAMILY_EYE = JSON.parse(read(ROUTING_PATH)).roles["plan-reviewer"].families["family-2"].model;

test("t6-dual-files: canonical family files and compatibility aliases exist", () => {
  assert.ok(existsSync(join(AGENTS_DIR, "plan-reviewer-openai.md")));
  assert.ok(existsSync(join(AGENTS_DIR, "adversary-openai.md")));
  const pr = frontmatter(read(join(AGENTS_DIR, "plan-reviewer-family-1.md")));
  const pro = frontmatter(read(join(AGENTS_DIR, "plan-reviewer-family-2.md")));
  const ad = frontmatter(read(join(AGENTS_DIR, "adversary-family-1.md")));
  const ado = frontmatter(read(join(AGENTS_DIR, "adversary-family-2.md")));
  assert.equal(fmField(pr, "model"), "openai/gpt-5.6-sol");
  assert.equal(fmField(pro, "model"), SECOND_FAMILY_EYE);
  assert.equal(fmField(ad, "model"), "openai/gpt-5.6-sol");
  assert.equal(fmField(ado, "model"), SECOND_FAMILY_EYE);
});

test("t6-build-prose: build.md contains dual-always protocol text", () => {
  const body = read(join(AGENTS_DIR, "build.md"));
  assert.match(body, /dual-always|Dual-always|Always dual/i);
  assert.match(body, /plan-reviewer-family-2/);
  assert.match(body, /adversary-family-2/);
  assert.match(body, /requireDualOn|ADR-003|policy B/i);
});

test("t6-skills: required loop skills exist under core/opencode/skills", () => {
  for (const name of REQUIRED_SKILLS) {
    const skillPath = join(SKILLS_DIR, name, "SKILL.md");
    assert.ok(existsSync(skillPath), `missing skill ${name}/SKILL.md`);
  }
});

test("t6-spawn-primary: every *-spawn.md agent used by hands has mode primary and tools.task false", () => {
  const files = readdirSync(AGENTS_DIR).filter((f) => f.endsWith("-spawn.md"));
  assert.ok(files.length >= 1, "at least one *-spawn.md hand agent");
  assert.ok(
    files.includes("executor-medium-spawn.md"),
    "executor-medium-spawn.md present (scope contract)",
  );
  for (const f of files) {
    const fm = frontmatter(read(join(AGENTS_DIR, f)));
    assert.equal(fmField(fm, "mode"), "primary", `${f} mode must be primary`);
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
  // Spawn twins share models with base hands
  const spawnMap = {
    "executor-low-spawn": expected["executor-low"],
    "executor-medium-spawn": expected["executor-medium"],
    "executor-high-spawn": expected["executor-high"],
    "sniper-low-spawn": expected["sniper-low"],
    "sniper-medium-spawn": expected["sniper-medium"],
    "sniper-high-spawn": expected["sniper-high"],
    "test-author-spawn": expected["test-author"],
  };
  for (const [name, model] of Object.entries(spawnMap)) {
    const path = join(AGENTS_DIR, `${name}.md`);
    if (!existsSync(path)) continue;
    const fm = frontmatter(read(path));
    assert.equal(fmField(fm, "model"), model, `${name}.md model must be ${model}`);
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

test("sniper-low spawn twin preserves model, temperature, and role contract", () => {
  const base = read(join(AGENTS_DIR, "sniper-low.md"));
  const spawn = read(join(AGENTS_DIR, "sniper-low-spawn.md"));
  const baseFm = frontmatter(base);
  const spawnFm = frontmatter(spawn);
  assert.equal(fmField(baseFm, "model"), fmField(spawnFm, "model"));
  assert.equal(fmField(baseFm, "temperature"), fmField(spawnFm, "temperature"));
  assert.ok(spawn.includes(base.slice(base.indexOf("# Sniper"), base.indexOf("## Output format"))));
  assert.equal(fmField(spawnFm, "mode"), "primary");
  assert.equal(fmNestedBool(spawnFm, "tools", "task"), false);
});
