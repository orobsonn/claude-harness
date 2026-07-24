/**
 * @description Locks the read-only Plan conversation lane, its Build Spec handoff, and its sole adversarial delegation.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decideEntryTask } from "../plugin/lib/entry-decide.mjs";

const AGENTS_DIR = dirname(fileURLToPath(import.meta.url));
const OC_ROOT = join(AGENTS_DIR, "..");
const KNOWLEDGE_EYES = [
  "plan.md",
  "planner.md",
  "planner-fallback.md",
  "plan-reviewer.md",
  "plan-reviewer-openai.md",
  "plan-reviewer-family-1.md",
  "plan-reviewer-family-2.md",
  "discussion-adversary.md",
  "adversary.md",
  "adversary-openai.md",
  "adversary-family-1.md",
  "adversary-family-2.md",
];

function read(file) {
  return readFileSync(join(AGENTS_DIR, file), "utf8");
}

function frontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(match, "missing YAML frontmatter");
  return match[1];
}

/**
 * @description Every rule line of a nested `permission.<key>:` pattern map, in file order.
 * Asserts the key is a map (not a flat scalar) so a blanket grant can never satisfy it.
 */
function permissionRules(fm, key) {
  const block = fm.match(new RegExp(`^ {2}${key}:\\r?\\n((?: {4}.+\\r?\\n?)+)`, "m"));
  assert.ok(block, `permission.${key} must be a scoped pattern map, never a flat scalar`);
  return block[1]
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

test("plan lane is primary, read-only, web-enabled, and cannot mutate ceremony", () => {
  const body = read("plan.md");
  const fm = frontmatter(body);

  assert.match(fm, /^mode: primary$/m);
  assert.match(fm, /^model: openai\/gpt-5\.6-terra$/m);
  assert.match(fm, /^  "\*": deny$/m, "unknown and MCP tools must fail closed");
  for (const permission of ["bash", "external_directory", "classify", "mark", "verify", "ceremony-next"]) {
    assert.match(fm, new RegExp(`^  ${permission}: deny$`, "m"), `${permission} must be denied`);
  }
  for (const permission of ["webfetch", "websearch"]) {
    assert.match(fm, new RegExp(`^  ${permission}: allow$`, "m"), `${permission} must be allowed`);
  }
  // Write carve-out: the ONLY allowed edit targets are the two read-only-analysis artifacts —
  // the grill PRD and the proposing-deepening candidates file.
  // A flat `edit: allow` — or any extra allowed path — must fail these assertions.
  assert.doesNotMatch(fm, /^ {2}edit: *(allow|ask)$/m, "edit must never be a flat allow/ask");
  assert.deepEqual(
    permissionRules(fm, "edit"),
    ['"*": deny', '"docs/prd/*.md": allow', '"docs/architecture/deepening-candidates.md": allow'],
    "edit must deny by default and allow ONLY the grill PRD and the deepening candidates file",
  );
  assert.deepEqual(
    permissionRules(fm, "task"),
    ['"*": deny', '"discussion-adversary": allow'],
    "task must deny by default and allow ONLY discussion-adversary",
  );
  assert.deepEqual(
    permissionRules(fm, "skill"),
    ['"*": deny', '"brainstorming": allow', '"grill": allow', '"proposing-deepening": allow'],
    "skill must deny by default and allow ONLY brainstorming, grill and proposing-deepening",
  );
  assert.match(fm, /^  "mv_\*": allow$/m);
  assert.match(fm, /^  "mp_\*": allow$/m);
  assert.match(fm, /read:\n    "\*": allow[\s\S]*"\*\*\/\.env\*": deny/);
});

test("plan lane emits an in-conversation Build Spec and hands execution to build", () => {
  const body = read("plan.md");

  assert.match(body, /exact heading `## Build Spec`/);
  assert.match(body, /Status: READY \| DRAFT/);
  assert.match(body, /### User Journeys/);
  assert.match(body, /### Acceptance Criteria/);
  assert.match(body, /### Locked Decisions/);
  assert.match(body, /### Risks And Adversarial Findings/);
  assert.match(body, /switch preserves this session context/i);
  assert.match(body, /Troque para build com Tab/);
  assert.match(body, /Never write a spec or decision ledger to disk/);
});

test("plan lane documents its write carve-outs without weakening read-only identity", () => {
  const body = read("plan.md");

  assert.match(body, /`docs\/prd\/<slug>\.md`/, "the PRD artifact path must be explicit");
  assert.match(body, /ONLY permitted write/, "the carve-outs must be stated as the sole writes");
  assert.match(body, /`grill`/, "a carve-out must be bound to the grill skill");
  assert.match(body, /`bash` stays denied/, "the carve-outs must not imply shell access");
  assert.match(body, /Never run shell commands, mutate git/);
});

test("plan hosts proposing-deepening as a propose-only, bash-denied, local-only lane", () => {
  const body = read("plan.md");

  assert.match(
    body,
    /`docs\/architecture\/deepening-candidates\.md`/,
    "the deepening candidates path must be documented",
  );
  assert.match(body, /`proposing-deepening`/, "the second carve-out must be bound to its skill");
  assert.match(body, /`bash` stays denied/, "hosting the skill must not unlock a shell");
  assert.match(
    body,
    /never `harness:ready`/,
    "a deepening candidate must never become an autonomous issue",
  );
  assert.match(
    body,
    /read-only on source, propose-only/i,
    "the skill's propose-only identity must be stated in its host",
  );
});

test("discussion adversary is a hidden read-only subagent with no delegation", () => {
  const body = read("discussion-adversary.md");
  const fm = frontmatter(body);

  assert.match(fm, /^mode: subagent$/m);
  assert.match(fm, /^hidden: true$/m);
  assert.doesNotMatch(fm, /^model:/m, "helper must inherit the invoking Plan model");
  assert.match(fm, /^  "\*": deny$/m, "unknown and MCP tools must fail closed");
  for (const permission of ["edit", "bash", "external_directory", "task", "skill", "classify", "mark", "verify", "ceremony-next"]) {
    assert.match(fm, new RegExp(`^  ${permission}: deny$`, "m"), `${permission} must be denied`);
  }
  for (const permission of ["webfetch", "websearch"]) {
    assert.match(fm, new RegExp(`^  ${permission}: allow$`, "m"), `${permission} must be allowed`);
  }
  assert.match(body, /Security:/);
  assert.match(body, /Scalability:/);
  assert.match(body, /Simplicity:/);
  assert.match(body, /Veredito: SOUND \| REVISE \| BLOCKED/);
});

test("all planning and adversarial eyes can consult MV and MP read-only", () => {
  for (const file of KNOWLEDGE_EYES) {
    const body = read(file);
    const fm = frontmatter(body);
    assert.match(fm, /^  "mv_\*": allow$/m, `${file} must allow MV tools`);
    assert.match(fm, /^  "mp_\*": allow$/m, `${file} must allow MP tools`);
    assert.match(body, /\bmv\b/i, `${file} must instruct MV use`);
    assert.match(body, /\bmp\b/i, `${file} must instruct MP use`);
    assert.match(body, /best-effort|unavailable/i, `${file} must not hard-depend on MCP availability`);
    assert.match(body, /never save, create, update, delete|strictly read-only/i, `${file} must forbid MCP mutation`);
  }
});

test("entry gate leaves discussion adversary outside delivery ceremony", () => {
  assert.deepEqual(
    decideEntryTask({ subagentType: "discussion-adversary", gateState: {} }),
    { ok: true, decision: "allow", reason: "non-delivery-role" },
  );
});

test("project policy scopes triage to build and documents the Plan handoff", () => {
  const policy = readFileSync(join(OC_ROOT, "AGENTS.md"), "utf8");

  assert.match(policy, /### Conversational Plan lane/);
  assert.match(policy, /exempt from\s+the `build` entry policy/);
  assert.match(policy, /terminal artifact is a `## Build Spec`/);
  assert.match(policy, /switches to `build` with Tab/);
});

test("brainstorming has a closed Plan branch without persistence or ceremony", () => {
  const skill = readFileSync(join(OC_ROOT, "skills", "brainstorming", "SKILL.md"), "utf8");
  const branch = skill.slice(skill.indexOf("## Plan conversational branch"), skill.indexOf("This skill runs inside"));

  assert.match(branch, /branch overrides every delivery instruction below/);
  assert.match(branch, /invoke only `discussion-adversary`/);
  assert.match(branch, /Return the `## Build Spec`/);
  assert.match(branch, /Do not write `.opencode\/decision-ledger\.md`/);
  assert.match(branch, /do not call `classify`, `mark`, `planner`, `orchestrating-delivery`/);
  assert.match(branch, /switch to `build` with Tab/);
});
