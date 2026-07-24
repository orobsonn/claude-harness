/**
 * @description Locks the OpenCode skill catalog against the #445 collision: every skill's `name:`
 * frontmatter carries the `oc-` prefix (so `.claude` homonyms can never win the loader's
 * nondeterministic overwrite), the directory is NEVER renamed, and every reference to a harness
 * skill — in an agent's permission map, a machine skill-load descriptor, or prose — uses the
 * prefixed name. Without this, renaming only the frontmatter passes every other test green and
 * breaks at runtime (the original bug's silent-failure mode, re-enacted).
 *
 * Three reference classes are deliberately NOT prefixed, and the checks below must never force them:
 *  - path segments (`skills/<slug>/…`, the directory is not renamed);
 *  - persisted gate-state protocol values (`phase: "brainstorming"`, the `brainstormed` marker,
 *    `brainstorming_completion_evidence`) — double-quoted, live on disk of running sessions;
 *  - the unprefixed slash-commands (`/updating-harness`, `/configuring-model-routing`) — the OC
 *    command namespace never collides with `.claude`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { REQUIRED_SKILLS } from "./agents-manifest.test.mjs";

const AGENTS_DIR = dirname(fileURLToPath(import.meta.url));
const OC_ROOT = join(AGENTS_DIR, "..");
const SKILLS_DIR = join(OC_ROOT, "skills");

/** Personal / cross-domain skills the harness legitimately references but does not own. */
const FOREIGN_SKILLS = new Set(["deploying-workers"]);

function read(path) {
  return readFileSync(path, "utf8");
}

/** @description Every skill directory under skills/ that carries a SKILL.md, with its frontmatter name. */
function readCatalog() {
  const entries = readdirSync(SKILLS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory());
  const catalog = [];
  for (const entry of entries) {
    const skillPath = join(SKILLS_DIR, entry.name, "SKILL.md");
    if (!existsSync(skillPath)) continue;
    const m = read(skillPath).match(/^name:\s*(.+)$/m);
    assert.ok(m, `skills/${entry.name}/SKILL.md is missing a name: frontmatter`);
    catalog.push({ dir: entry.name, name: m[1].trim() });
  }
  return catalog;
}

const CATALOG = readCatalog();
const CATALOG_DIRS = new Set(CATALOG.map((s) => s.dir));
const CATALOG_NAMES = new Set(CATALOG.map((s) => s.name));

/** @description Every file under core/opencode with one of the given extensions. */
function walk(dir, exts, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      walk(full, exts, out);
    } else if (exts.some((ext) => entry.name.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

/** @description The base skill slug a token refers to, or null when it is not a harness-skill reference. */
function harnessSlug(token) {
  const bare = token.startsWith("oc-") ? token.slice(3) : token;
  return CATALOG_DIRS.has(bare) ? bare : null;
}

test("catalog: every skill name is oc-<dir>, directories are never renamed", () => {
  assert.ok(CATALOG.length >= 1, "no skills found under skills/");
  for (const { dir, name } of CATALOG) {
    assert.equal(name, `oc-${dir}`, `skills/${dir}/SKILL.md name must be "oc-${dir}", got "${name}"`);
  }
  // Names are unique — two skills resolving to the same name reintroduce an in-catalog collision.
  assert.equal(CATALOG_NAMES.size, CATALOG.length, "skill names must be unique");
});

test("catalog: the directory set matches REQUIRED_SKILLS exactly (no drift, all 18)", () => {
  assert.deepEqual(
    [...CATALOG_DIRS].sort(),
    [...new Set(REQUIRED_SKILLS)].sort(),
    "skills/ on disk and REQUIRED_SKILLS must be identical — neither may silently drift",
  );
});

test("machine positions: every skill identifier the runtime consumes is the prefixed catalog name", () => {
  // permission.skill keys in every agent frontmatter.
  for (const file of walk(AGENTS_DIR, [".md"])) {
    const fm = read(file).match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!fm) continue;
    const block = fm[1].match(/^ {2}skill:\r?\n((?: {4}.+\r?\n?)*)/m);
    if (!block) continue;
    for (const line of block[1].split(/\r?\n/)) {
      const key = line.match(/^ {4}"([^"]+)":/);
      if (!key || key[1] === "*") continue;
      assertMachineToken(key[1], `${relative(OC_ROOT, file)} permission.skill key`);
    }
  }
  // skill({ name: "X" }) and { kind: "skill", name: "X" } in non-test code and prose.
  const sources = walk(OC_ROOT, [".md", ".mjs", ".ts"]).filter((f) => !f.endsWith(".test.mjs"));
  for (const file of sources) {
    const body = read(file);
    const where = relative(OC_ROOT, file);
    for (const m of body.matchAll(/skill\(\{\s*name:\s*"([a-z0-9-]+)"/g)) {
      assertMachineToken(m[1], `${where} skill({ name })`);
    }
    for (const m of body.matchAll(/kind:\s*"skill",\s*name:\s*"([a-z0-9-]+)"/g)) {
      assertMachineToken(m[1], `${where} { kind: "skill", name }`);
    }
  }
});

/** @description A machine skill identifier must be an exact catalog name (oc-*) or a known foreign skill. */
function assertMachineToken(token, where) {
  if (FOREIGN_SKILLS.has(token)) return;
  if (token.startsWith("oc-")) {
    assert.ok(CATALOG_NAMES.has(token), `${where}: "${token}" is not a catalog skill (typo or dead reference)`);
  } else {
    assert.ok(
      !CATALOG_DIRS.has(token),
      `${where}: "${token}" is a bare harness-skill name — it must be "oc-${token}", or the .claude homonym can win the loader`,
    );
  }
}

test("prose: no backticked reference to a harness skill is left unprefixed", () => {
  // Prose the model reads as instructions, plus the operator guide. Slash-command forms (`/x`) and
  // path segments (`a/b`) are naturally excluded: the token regex requires a bare [a-z…] identifier
  // between the backticks, so a leading `/` or an embedded `/` never matches.
  const proseRoots = ["agents", "skills", "docs", "rules", "command"];
  const proseFiles = proseRoots
    .flatMap((sub) => (existsSync(join(OC_ROOT, sub)) ? walk(join(OC_ROOT, sub), [".md"]) : []))
    .concat(existsSync(join(OC_ROOT, "AGENTS.md")) ? [join(OC_ROOT, "AGENTS.md")] : []);

  for (const file of proseFiles) {
    const where = relative(OC_ROOT, file);
    for (const m of read(file).matchAll(/`([a-z][a-z0-9-]*)`/g)) {
      const token = m[1];
      const slug = harnessSlug(token);
      if (!slug) continue; // not a harness-skill reference (agent name, tool, foreign word, oc-port, …)
      assert.equal(
        token,
        `oc-${slug}`,
        `${where}: backticked \`${token}\` references harness skill "${slug}" unprefixed — use \`oc-${slug}\``,
      );
    }
  }
});
