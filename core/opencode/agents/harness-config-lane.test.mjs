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

/**
 * Command heads the lane's shell allowlist may grant — lifecycle engines + ship-to-main.
 * Deny rules are separate (see MUST_DENY_COMMANDS).
 */
const ALLOWED_BASH_HEADS = [
  "test -f .opencode/.harness-version",
  "echo ",
  "gh release view --repo orobsonn/claude-harness",
  "npx --yes --package=github:orobsonn/claude-harness#v",
  "opencode models",
  "git status",
  "git branch",
  "git diff",
  "git rev-parse",
  "git fetch origin",
  "git switch main",
  "git switch master",
  "git switch -c chore/harness-lifecycle",
  "git switch -c chore/harness-update",
  "git switch -c chore/harness-routing",
  "git checkout main",
  "git checkout master",
  "git pull --ff-only",
  "node .opencode/tools/lifecycle-ship.mjs prepare ",
  "node .opencode/tools/lifecycle-ship.mjs snapshot ",
  "git push -u origin HEAD",
  "gh pr create --title ",
  "gh pr view ",
  "gh pr checks --watch",
  "gh pr checks ",
  "gh pr list ",
  "gh pr merge --squash --delete-branch",
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

/**
 * @description OpenCode-style wildcard → RegExp (`*` → `.*`), anchored. Mirrors plan-conversation-contract.
 * @param {string} pattern
 * @returns {RegExp}
 */
function patternToRegExp(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/**
 * @description Last-match-wins resolution over bash rules (same as OpenCode permission maps).
 * @param {string[]} rules
 * @param {string} command
 * @returns {"allow" | "deny" | undefined}
 */
function resolveBash(rules, command) {
  let hit;
  for (const rule of rules) {
    const { pattern, action } = splitRule(rule);
    if (patternToRegExp(pattern).test(command)) hit = action;
  }
  return hit;
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
    assert.ok(action === "allow" || action === "deny", `unexpected action in bash map: ${rule}`);
    if (action === "allow") {
      assert.ok(!pattern.startsWith("*"), `bash allow pattern must not open with a wildcard: ${pattern}`);
      assert.ok(
        ALLOWED_BASH_HEADS.some((head) => pattern === head || pattern.startsWith(head) || head.startsWith(pattern.replace(/\*$/, ""))),
        `bash allow pattern outside the lifecycle command set: ${pattern}`,
      );
    }
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
  const rules = permissionRules(fm, "bash");

  for (const source of LIFECYCLE_BASH_SOURCES) {
    assert.ok(existsSync(source.path), `missing lifecycle bash source ${source.label}`);
    for (const command of bashSubCommandsFrom(source.path)) {
      // Placeholders like <latest-tag> → concrete-shaped stand-in for match.
      const concrete = command
        .replace(/<latest-tag>/g, "v0.54.0")
        .replace(/<tag>/g, "v0.54.0");
      const action = resolveBash(rules, concrete);
      assert.equal(
        action,
        "allow",
        `${source.label} runs "${command}" (as "${concrete}"), resolve=${action} — lane would deny it`,
      );
    }
  }
});

test("updating-harness invokes the named CLI from its pinned GitHub package", () => {
  const skill = readFileSync(join(SKILLS_DIR, "updating-harness", "SKILL.md"), "utf8");
  assert.match(
    skill,
    /npx --yes --package=github:orobsonn\/claude-harness#<latest-tag> claude-harness init --target opencode/,
  );
  assert.doesNotMatch(skill, /npx -y "github:orobsonn\/claude-harness#<latest-tag>" init/);
  assert.match(skill, /claude-harness lifecycle-snapshot updating-harness/);
});

test("ship allowlist denies force-push, no-verify, admin merge, and multi-path git add", () => {
  const fm = frontmatter(readFileSync(join(AGENTS_DIR, "harness-config.md"), "utf8"));
  const rules = permissionRules(fm, "bash");

  const mustDeny = [
    "git push -u origin HEAD --force",
    "git push -u origin main --force",
    "git push --force origin HEAD",
    "git commit -m \"x\" --no-verify",
    "git commit -m x --no-gpg-sign",
    "gh pr merge --squash --delete-branch --admin",
    "gh pr merge --merge",
    "gh pr merge --rebase --delete-branch",
    "node .opencode/tools/lifecycle-ship.mjs prepare updating-harness --extra",
    "node .opencode/tools/lifecycle-ship.mjs prepare product-delivery",
    "git push -u origin main",
  ];

  for (const command of mustDeny) {
    const action = resolveBash(rules, command);
    assert.notEqual(action, "allow", `dangerous command must not allow: ${command} (got ${action})`);
  }

  const mustAllow = [
    "node .opencode/tools/lifecycle-ship.mjs prepare updating-harness",
    "git push -u origin HEAD",
    "gh pr merge --squash --delete-branch",
    "git fetch origin",
    "git switch -c chore/harness-lifecycle",
    'gh pr create --title "chore: lifecycle harness" --body "x"',
    "gh pr view --json url,baseRefName,headRefName",
  ];

  for (const command of mustAllow) {
    assert.equal(resolveBash(rules, command), "allow", `expected allow: ${command}`);
  }
});

test("lifecycle-ship resumes an isolated lifecycle branch without absorbing unrelated work", () => {
  const body = readFileSync(join(SKILLS_DIR, "lifecycle-ship-to-main.md"), "utf8");
  assert.match(body, /fixed vendor ownership set/i);
  assert.match(body, /already-created lifecycle commit/i);
  assert.match(body, /Product work may be dirty or already staged/i);
  assert.match(body, /\.opencode.*\.claude.*outside the/i);
  assert.match(body, /baseRefName/);
  assert.match(body, /git commit --only/);
  assert.doesNotMatch(body, /shows \*\*any path outside\*\* the lifecycle allowlist/i);
  // Prose may name the forbidden forms; fenced bash must never invoke them.
  const fenced = [...body.matchAll(/^```bash\r?\n([\s\S]*?)^```/gm)].map((m) => m[1]).join("\n");
  assert.doesNotMatch(fenced, /^git add -A\s*$/m);
  assert.doesNotMatch(fenced, /^git add \.\s*$/m);
  assert.doesNotMatch(fenced, /^git add \.opencode\s*$/m);
  assert.doesNotMatch(fenced, /^git add \.claude\s*$/m);
  assert.doesNotMatch(fenced, /--force|--no-verify|--admin/);
  assert.match(fenced, /^node \.opencode\/tools\/lifecycle-ship\.mjs prepare /m);
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
