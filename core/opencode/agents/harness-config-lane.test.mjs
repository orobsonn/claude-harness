/**
 * @description Locks the harness lifecycle lane: a ceremony-less `harness-config` agent reachable
 * only through the two lifecycle commands, and its delivery to vendored projects.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const AGENTS_DIR = dirname(fileURLToPath(import.meta.url));
const OC_ROOT = join(AGENTS_DIR, "..");
const COMMAND_DIR = join(OC_ROOT, "command");
const SKILLS_DIR = join(OC_ROOT, "skills");
const VENDOR_CORE = join(
  OC_ROOT,
  "..",
  "claude-code",
  "skills",
  "initializing-projects",
  "references",
  "vendor-core.mjs",
);

/**
 * The lane's entire surface: one command file per lifecycle skill, and nothing else.
 * The command file name and slash-command stay UNPREFIXED (the OC command namespace never
 * collides with .claude — verified: OpenCode scans only .opencode/command{,s}/). The skill
 * `name:` frontmatter carries the `oc-` prefix (issue #445), so the permission.skill key and
 * the in-body skill reference are `oc-<op>`, while the directory that holds the skill is `<op>`.
 */
const LIFECYCLE_OPERATIONS = ["configuring-model-routing", "updating-harness"];
const LIFECYCLE_SKILL_NAMES = LIFECYCLE_OPERATIONS.map((op) => `oc-${op}`);

/** Command heads the lane's shell allowlist may grant — lifecycle engines + ship-to-main. */
const ALLOWED_BASH_HEADS = [
  "test -f .opencode/.harness-version",
  "echo ",
  "gh release view --repo orobsonn/claude-harness",
  'npx -y "github:orobsonn/claude-harness#v',
  "opencode models",
  "git status",
  "git branch",
  "git diff",
  "git rev-parse",
  "git switch",
  "git checkout main",
  "git pull",
  "git add .opencode",
  "git add .claude",
  "git add opencode.json",
  "git add AGENTS.md",
  "git add harness.routing.json",
  "git add core/opencode",
  "git commit -m ",
  "git push -u origin HEAD",
  "git push -u origin ",
  "gh pr create ",
  "gh pr merge ",
  "gh pr view ",
  "gh pr checks ",
  "gh pr list ",
];

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

/** @description Splits a `"pattern": action` rule line into its pattern and action. */
function splitRule(rule) {
  const match = rule.match(/^"((?:[^"\\]|\\.)*)":\s*(\S+)$/);
  assert.ok(match, `unparseable permission rule: ${rule}`);
  return { pattern: match[1].replace(/\\"/g, '"'), action: match[2] };
}

test("harness-config is a primary lane that cannot open ceremony, delegate, or write", () => {
  const path = join(AGENTS_DIR, "harness-config.md");
  assert.ok(existsSync(path), "harness-config.md must exist");
  const fm = frontmatter(readFileSync(path, "utf8"));

  assert.match(fm, /^mode: primary$/m, "the lane replaces the session agent, so it must be primary");
  assert.match(fm, /^  "\*": deny$/m, "unknown and MCP tools must fail closed");
  for (const permission of ["classify", "mark", "verify", "task", "edit", "external_directory"]) {
    assert.match(fm, new RegExp(`^  ${permission}: deny$`, "m"), `${permission} must be denied`);
  }
  assert.match(fm, /read:\n    "\*": allow[\s\S]*"\*\*\/\.env\*": deny/);
});

test("harness-config reaches exactly the two lifecycle skills", () => {
  const fm = frontmatter(readFileSync(join(AGENTS_DIR, "harness-config.md"), "utf8"));

  assert.deepEqual(
    permissionRules(fm, "skill"),
    ['"*": deny', ...LIFECYCLE_SKILL_NAMES.map((name) => `"${name}": allow`)],
    "skill must deny by default and allow ONLY the two lifecycle skills (oc- prefixed name)",
  );
});

test("harness-config shell allowlist is closed and holds no open wildcard", () => {
  const fm = frontmatter(readFileSync(join(AGENTS_DIR, "harness-config.md"), "utf8"));
  const rules = permissionRules(fm, "bash");

  assert.equal(rules[0], '"*": deny', "bash must deny by default before any grant");
  for (const rule of rules.slice(1)) {
    const { pattern, action } = splitRule(rule);
    assert.equal(action, "allow", `unexpected action in bash allowlist: ${rule}`);
    assert.ok(!pattern.startsWith("*"), `bash pattern must not open with a wildcard: ${pattern}`);
    assert.ok(
      ALLOWED_BASH_HEADS.some((head) => pattern.startsWith(head)),
      `bash pattern outside the lifecycle command set: ${pattern}`,
    );
  }
});

/**
 * @description Every shell command a markdown file fences in a ```bash block, split into the
 * sub-commands OpenCode actually matches. The permission layer walks the tree-sitter `command`
 * nodes, so a composite line grants nothing unless each of its parts is allowed on its own.
 */
function bashSubCommandsFrom(filePath) {
  const body = readFileSync(filePath, "utf8");
  return [...body.matchAll(/^```bash\r?\n([\s\S]*?)^```/gm)]
    .flatMap((block) => block[1].split(/\r?\n/))
    // Trailing `# comment`, never the `#tag` fragment inside a git URL.
    .map((line) => line.replace(/\s+#\s.*$/, "").trim())
    .filter((line) => line && !line.startsWith("#"))
    .flatMap((line) => line.split(/&&|\|\||;/))
    .map((part) => part.trim())
    .filter(Boolean)
    // Smoke-only `node --test core/...` fences in skills are not run by the lane.
    .filter((part) => !part.includes(" core/") && !part.startsWith("node --test"));
}

/** Lifecycle skills + shared ship-to-main procedure (same session close-out). */
const LIFECYCLE_BASH_SOURCES = [
  ...LIFECYCLE_OPERATIONS.map((name) => ({ label: name, path: join(SKILLS_DIR, name, "SKILL.md") })),
  {
    label: "lifecycle-ship-to-main",
    path: join(SKILLS_DIR, "lifecycle-ship-to-main.md"),
  },
];

test("every command the lifecycle skills run is covered by the lane's allowlist", () => {
  const fm = frontmatter(readFileSync(join(AGENTS_DIR, "harness-config.md"), "utf8"));
  // Both sides carry an unresolvable tail — `<placeholder>` in the skill, `*` in the pattern — so
  // each is compared by its literal stem. Neither is the hand-kept mirror above.
  const grantedStems = permissionRules(fm, "bash")
    .slice(1)
    .map((rule) => splitRule(rule).pattern.split("*")[0]);

  for (const source of LIFECYCLE_BASH_SOURCES) {
    assert.ok(existsSync(source.path), `missing lifecycle bash source ${source.label}`);
    for (const command of bashSubCommandsFrom(source.path)) {
      const stem = command.split("<")[0];
      assert.ok(
        grantedStems.some((granted) => stem.startsWith(granted) || granted.startsWith(stem)),
        `${source.label} runs "${command}", which no allowlist entry grants — the lane would deny it`,
      );
    }
  }
});

test("each lifecycle command routes to harness-config in the same session", () => {
  for (const name of LIFECYCLE_OPERATIONS) {
    const path = join(COMMAND_DIR, `${name}.md`);
    assert.ok(existsSync(path), `missing command ${name}.md`);
    const body = readFileSync(path, "utf8");
    const fm = frontmatter(body);

    assert.match(fm, /^agent: harness-config$/m, `${name}.md must switch the session agent`);
    assert.doesNotMatch(
      fm,
      /^subtask:\s*true$/m,
      `${name}.md must not spawn a child session — the lane would lose the operator`,
    );
    assert.match(body, new RegExp(`\`oc-${name}\``), `${name}.md must name the oc- prefixed skill it loads`);
    assert.ok(
      existsSync(join(SKILLS_DIR, name, "SKILL.md")),
      `command ${name} has no skill directory of the same (unprefixed) name`,
    );
  }
});

test("triaging routes lifecycle requests to the lane instead of policing them in prose", () => {
  const skill = readFileSync(join(SKILLS_DIR, "triaging-requests", "SKILL.md"), "utf8");
  const step = skill.slice(skill.indexOf("### Step 0"), skill.indexOf("### Step 1"));

  assert.match(step, /`harness-config`/, "Step 0 must name the lane agent");
  for (const name of LIFECYCLE_OPERATIONS) {
    assert.match(step, new RegExp(`/${name}`), `Step 0 must point at the /${name} command`);
  }
});

test("the command directory is framework-owned, so vendored projects receive the lane", () => {
  const source = readFileSync(VENDOR_CORE, "utf8");
  const declaration = source.match(/^const OC_FRAMEWORK_OWNED = \[(.+)\];$/m);
  assert.ok(declaration, "OC_FRAMEWORK_OWNED must stay a single-line literal");
  assert.ok(
    declaration[1].includes('"command"'),
    "OC_FRAMEWORK_OWNED must include command, or the lane never reaches a vendored project",
  );
});
