/**
 * @description Locks the read-only Plan conversation lane, its Build Spec handoff, and its sole adversarial delegation.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decideEntryTask } from "../lib/entry-decide.mjs";

const AGENTS_DIR = dirname(fileURLToPath(import.meta.url));
const OC_ROOT = join(AGENTS_DIR, "..");
const KNOWLEDGE_EYES = [
  "plan.md",
  "planner.md",
  "planner-fallback.md",
  "plan-reviewer.md",
  "discussion-adversary.md",
  "adversary.md",
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

/**
 * @description Parses `permissionRules()` output ('"pattern": action' lines) into {pattern, action} pairs.
 */
function parsePatternRules(rules) {
  return rules.map((line) => {
    const m = line.match(/^"((?:[^"\\]|\\.)*)":\s*(allow|deny|ask)$/);
    assert.ok(m, `unparsable permission rule line: ${line}`);
    return { pattern: m[1], action: m[2] };
  });
}

/**
 * @description Mirrors the OpenCode 1.18.4 `Wildcard.match` engine, read directly from the shipped
 * binary across two independent adversarial rounds: both the command and the pattern normalize
 * backslashes to forward slashes, `*` becomes an unanchored `.*`, `?` becomes a single-char `.`, a
 * pattern ending in a literal ` *` gets its trailing ` .*` rewritten to `( .*)?`, and the whole
 * thing is a `^...$`-anchored regex with the dotAll flag. The winning rule is the LAST one in file
 * order whose pattern matches (`rulesets.flat().findLast(...)`), defaulting to "ask" when nothing
 * matches — but every rule list here starts with `"*": deny`, so something always matches.
 *
 * KNOWN BLIND SPOT — do not "fix" by adding a grouped/subshelled case to `dangerous` below. The
 * real `ShellTool` only ever submits a `command` AST node's OWN text (or its immediate
 * `redirected_statement` parent's text when a redirect attaches directly to that node). Wrapping
 * the same command in a group or subshell — `{ git log ...; } > /path` — pushes the redirect one
 * level up the parse tree; the string actually submitted is then just `git log ...`, indistinguishable
 * from the safe bare command. No glob pattern — real or simulated — can see that redirect, so
 * neither this simulator nor the allowlist it mirrors can deny it. This is a confirmed, accepted
 * residual risk (see plan.md's "Known residual gap" paragraph), not something a `dangerous` test
 * case here could ever assert honestly.
 */
function patternToRegExp(pattern) {
  const normalizedPattern = pattern.replaceAll("\\", "/");
  let escaped = normalizedPattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  if (escaped.endsWith(" .*")) escaped = `${escaped.slice(0, -3)}( .*)?`;
  return new RegExp(`^${escaped}$`, "s");
}

function resolveBashAction(rules, command) {
  const normalizedCommand = command.replaceAll("\\", "/");
  let resolved = "ask";
  for (const { pattern, action } of parsePatternRules(rules)) {
    if (patternToRegExp(pattern).test(normalizedCommand)) resolved = action;
  }
  return resolved;
}

test("plan lane is primary, read-only, web-enabled, and cannot mutate ceremony", () => {
  const body = read("plan.md");
  const fm = frontmatter(body);

  assert.match(fm, /^mode: primary$/m);
  assert.match(fm, /^model: openai\/gpt-5\.6-terra$/m);
  assert.match(fm, /^  "\*": deny$/m, "unknown and MCP tools must fail closed");
  for (const permission of ["external_directory", "classify", "mark", "verify"]) {
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
  // Bash carve-out (oc-agents-permission-parity, issue #472): a narrow read-only git-history
  // allowlist, never a flat allow — mutation and every other shell command stay denied.
  // The deny rows AFTER the allow rows are load-bearing: the permission engine resolves a
  // pattern list with `findLast` (last matching rule wins), so closing `difftool` (RCE via
  // `--extcmd`), `--output=<file>` (arbitrary-content write via `--format=tformat:`), and a bare
  // `>`/`>>` shell redirect (same arbitrary-write class, via the shell instead of a git flag)
  // must stay ordered after the broad `git diff*`/`git log*`/`git show*` allows, never before.
  assert.doesNotMatch(fm, /^ {2}bash: *(allow|ask)$/m, "bash must never be a flat allow/ask");
  assert.deepEqual(
    permissionRules(fm, "bash"),
    [
      '"*": deny',
      '"git log*": allow',
      '"git diff*": allow',
      '"git show*": allow',
      '"git blame*": allow',
      '"git status*": allow',
      '"git difftool*": deny',
      '"git show-ref*": deny',
      '"git show-branch*": deny',
      '"git log*--output*": deny',
      '"git diff*--output*": deny',
      '"git show*--output*": deny',
      '"git blame*--output*": deny',
      '"git log*>*": deny',
      '"git diff*>*": deny',
      '"git show*>*": deny',
      '"git blame*>*": deny',
      '"git status*>*": deny',
      '"git diff*--ext-diff*": deny',
      '"git log*--ext-diff*": deny',
      '"git diff*--textconv*": deny',
      '"git show*--textconv*": deny',
      '"git blame*--textconv*": deny',
    ],
    "bash must deny by default, allow ONLY the read-only git-history commands, and close difftool/--output/redirect/--ext-diff/--textconv after them",
  );
  assert.deepEqual(
    permissionRules(fm, "task"),
    ['"*": deny', '"discussion-adversary": allow'],
    "task must deny by default and allow ONLY discussion-adversary",
  );
  assert.deepEqual(
    permissionRules(fm, "skill"),
    ['"*": deny', '"oc-brainstorming": allow', '"oc-grill": allow', '"oc-proposing-deepening": allow'],
    "skill must deny by default and allow ONLY oc-brainstorming, oc-grill and oc-proposing-deepening",
  );
  assert.match(fm, /^  "mv_\*": allow$/m);
  assert.match(fm, /^  "mp_\*": allow$/m);
  assert.match(fm, /read:\n    "\*": allow[\s\S]*"\*\*\/\.env\*": deny/);
});

test("plan lane's bash allowlist denies every known write/exec vector riding on an allowed git command", () => {
  const fm = frontmatter(read("plan.md"));
  const rules = permissionRules(fm, "bash");

  const dangerous = [
    // Bare shell redirect (this test's regression target): the redirect target rides through
    // the same prefix match as the "read-only" command it decorates.
    "git log --format=tformat:%H > /tmp/pwned.txt",
    "git log --format=tformat:%H >> /tmp/pwned.txt",
    "git diff --format=tformat:%H > /tmp/pwned.txt",
    "git show --format=tformat:%H > /tmp/pwned.txt",
    "git blame src/foo.ts > /tmp/pwned.txt",
    "git status > /tmp/pwned.txt",
    // Previously-fixed vectors, locked here so a future edit can't silently reopen them.
    "git difftool --no-prompt --extcmd=sh -- a.txt b.txt",
    "git show-ref --head",
    "git show-branch --all",
    "git log -1 --format=tformat:X --output=/tmp/pwned.txt",
    "git blame --output=/tmp/pwned.txt README.md",
    "git diff --ext-diff",
    "git log -p --ext-diff",
    "git diff --textconv a.bin b.bin",
    "git show --textconv HEAD:a.bin",
    "git blame --textconv README.md",
  ];
  for (const command of dangerous) {
    assert.strictEqual(resolveBashAction(rules, command), "deny", `must deny: ${command}`);
  }

  const legitimate = [
    "git log --oneline -20",
    "git diff HEAD~1",
    "git show HEAD",
    "git blame src/foo.ts",
    "git status",
  ];
  for (const command of legitimate) {
    assert.strictEqual(resolveBashAction(rules, command), "allow", `must still allow: ${command}`);
  }
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
  assert.match(body, /`oc-grill`/, "a carve-out must be bound to the oc-grill skill");
  assert.match(
    body,
    /`bash` remains restricted to a read-only git-history allowlist/,
    "the carve-outs must not expand shell access beyond the read-only git-history allowlist",
  );
  assert.match(body, /never mutate git, run any other shell command/);
});

test("plan hosts proposing-deepening as a propose-only, bash-restricted, local-only lane", () => {
  const body = read("plan.md");

  assert.match(
    body,
    /`docs\/architecture\/deepening-candidates\.md`/,
    "the deepening candidates path must be documented",
  );
  assert.match(body, /`oc-proposing-deepening`/, "the second carve-out must be bound to its skill");
  assert.match(
    body,
    /`bash` remains restricted to a read-only git-history allowlist/,
    "hosting the skill must not unlock a shell beyond the read-only git-history allowlist",
  );
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
  for (const permission of ["edit", "bash", "external_directory", "task", "skill", "classify", "mark", "verify"]) {
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
  assert.match(branch, /do not call `classify`, `mark`, `planner`, `oc-orchestrating-delivery`/);
  assert.match(branch, /switch to `build` with Tab/);
});
