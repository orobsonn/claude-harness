/**
 * @description Locks issue #811: the `releasing-versions` skill (and its OpenCode mirror) must
 * describe the flow the repo ACTUALLY runs. When release-please is configured, release-please IS
 * the release flow; the manual PR flow survives only as an explicitly fenced fallback for the
 * vendored consumers that have no release-please.
 *
 * The whole suite is CONDITIONAL on release-please actually being configured here (all three
 * legitimate forms, per core/claude-code/rules/releases.md). In a consumer project without
 * release-please the manual flow is the correct flow, and these tests must not fire.
 *
 * Two markers carry the machine-readable contract (a separate namespace from the existing
 * `release-guard:allow-mention` idiom in rules/releases.md):
 *   <!-- release-please:fallback-start --> / <!-- release-please:fallback-end -->  fence the manual flow
 *   <!-- release-please:prohibition -->                                           marks a line that
 *       names a manual token only in order to FORBID it.
 * Outside the fence, a manual token is legal only on a prohibition line. That is the difference
 * between a gated fallback and an instruction that contradicts release-please (#ac-2.2).
 *
 * #831 extends this file to the operator guides (core/<shell>/docs/OPERATOR-GUIDE.md), which had
 * two rows that predated release-please and still described the pre-#811 manual-only flow. The
 * shells themselves are DISCOVERED from disk (never a hardcoded ["claude-code","opencode"] list) —
 * a shell is a real (non-symlink) directory under core/ that contains skills/ — so a future shell
 * (pi, codex, …) is covered the day it exists, and the SKILL.md TARGETS below are built from the
 * same discovery rather than a second hardcoded pair of paths. The conditional SKIP is unchanged
 * and applies to every new test here too: a vendored consumer without release-please must see this
 * whole file go quiet, guides included.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { decideMergeChecks } from "../shared/lib/merge-check-gate.mjs";

const REPO_ROOT = new URL("../../", import.meta.url);

/** @description The three legitimate ways release-please can be configured (rules/releases.md). */
function releasePleaseConfigured(root) {
  if (existsSync(new URL("release-please-config.json", root))) return true;
  if (existsSync(new URL(".release-please-manifest.json", root))) return true;
  const workflows = new URL(".github/workflows/", root);
  if (!existsSync(workflows)) return false;
  return readdirSync(workflows)
    .filter((file) => /\.ya?ml$/.test(file))
    .some((file) => readFileSync(new URL(file, workflows), "utf8").includes("release-please-action"));
}

const SKIP = releasePleaseConfigured(REPO_ROOT)
  ? false
  : "release-please is not configured here — the manual fallback is the legitimate flow";

/** The exact denial string the entry-gate emits for an empty rollup — imported, never retyped. */
const MISSING_REASON = decideMergeChecks([]).reason;

const FENCE_START = "<!-- release-please:fallback-start -->";
const FENCE_END = "<!-- release-please:fallback-end -->";
const PROHIBITION = "<!-- release-please:prohibition -->";

/** Manual-flow tokens from the issue's own grep alternation (#ac-2.2). */
const MANUAL_TOKENS = ["gh release create", "npm version", "[Unreleased]"];

/** A description that promises a hand-rolled version bump + CHANGELOG edit as the skill's behavior. */
const MANUAL_PROMISE = /(bump[^.]{0,40}CHANGELOG|CHANGELOG[^.]{0,40}bump)/i;

const CORE = new URL("core/", REPO_ROOT);

/**
 * @description A shell = a REAL directory under core/ that contains skills/ (#ac-X.1).
 * `withFileTypes` dirents carry lstat semantics: for core/skills, core/agents, core/hooks,
 * core/memory and core/rules — symlinks into claude-code/ — isDirectory() is false and
 * isSymbolicLink() is true, so the legacy "claude-code is primary" layout can never be counted
 * as an extra shell, and neither could a future `core/<alias> -> claude-code`. isDirectory() is
 * the filter that actually does the excluding (a real alias like `core/cc -> claude-code` would
 * still pass a bare `skills/`-exists probe, since the symlink resolves); `!isSymbolicLink()` is
 * kept alongside it only to document intent and stay correct if this ever becomes a stat-based
 * walk. The predicate deliberately ignores docs/ and the releasing-versions skill: adding either
 * to the definition would let a new shell escape the assertions below by simply not shipping
 * that file — exactly the silent-pass shape #ac-X.2/#ac-X.3 forbid.
 */
function discoverShells(core) {
  return readdirSync(core, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
    .filter((name) => existsSync(new URL(`${name}/skills/`, core)))
    .sort();
}

const SHELLS = discoverShells(CORE);

const RELEASE_SKILL_DIR = /(?:^|-)releasing-versions$/;

/**
 * @description The release skill a shell ships, or null. The guide row is keyed by the frontmatter
 * `name:` (claude-code → `releasing-versions`, opencode → `oc-releasing-versions`), never by the
 * directory, which is identical in both shells. This function must NEVER assert — it is called at
 * module scope, ungated by SKIP, so an assertion here would hard-crash the whole file (including
 * the 15 pre-existing #811 tests) for a vendored consumer with no release-please instead of letting
 * the SKIP-gated tests report the problem cleanly.
 */
function releaseSkillOf(shell) {
  const skills = new URL(`${shell}/skills/`, CORE);
  const dirs = readdirSync(skills, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && RELEASE_SKILL_DIR.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (dirs.length === 0) return null;
  const [dir] = dirs;
  const url = new URL(`${dir}/SKILL.md`, skills);
  const label = `core/${shell}/skills/${dir}/SKILL.md`;
  if (!existsSync(url)) return { shell, dir, url, label, name: null };
  const matched = readFileSync(url, "utf8").match(/^name:\s*(.+)$/m);
  return { shell, dir, url, label, name: matched ? matched[1].trim() : null };
}

const RELEASE_SKILLS = SHELLS.map(releaseSkillOf).filter(Boolean);

/** Per-shell language of the SKILL.md. Discovery finds the shells; this table carries only what
 *  disk cannot tell us — which language the file is written in. A shell absent here fails the
 *  guard below rather than passing in silence (#ac-X.2); a shell present here that no longer ships
 *  the skill fails the OTHER guard below, so coverage cannot shrink in silence either (#4 of the
 *  adversarial review — SKILL_LANGUAGE is checked in both directions). */
const SKILL_LANGUAGE = {
  "claude-code": { twice: /duas vezes/i, never: /NUNCA/, manualHeadings: ["## MODO OPEN", "## MODO FINISH"] },
  codex: { twice: /duas vezes/i, never: /NUNCA/, manualHeadings: ["## MODO OPEN", "## MODO FINISH"] },
  opencode: { twice: /twice/i, never: /NEVER/, manualHeadings: ["## OPEN mode", "## FINISH mode"] },
};

const TARGETS = RELEASE_SKILLS.filter((skill) => SKILL_LANGUAGE[skill.shell]).map((skill) => ({
  ...skill,
  ...SKILL_LANGUAGE[skill.shell],
}));

const GUIDE_OF = (shell) => new URL(`${shell}/docs/OPERATOR-GUIDE.md`, CORE);
/** Strips markdown emphasis (`**`, `` ` ``) and a leading `/` (slash-command prefix) from a table cell. */
const cellName = (cell) => cell.replace(/[`*]/g, "").trim().replace(/^\//, "");
const CONVENTIONAL = /(conventional commits|commits convencionais)/i;

/** @description The single table row whose FIRST cell names `skillName`, plus its body (every cell
 *  except the name cell — column-count agnostic, so a shell with a 4-column table still works).
 *  Anchoring to the row, not the document, is the whole point: matching anywhere in the file
 *  re-enacts the /pipe/i-style toothlessness of #810 — both guides mention "release" many times
 *  outside this row. */
function guideRow(guide, skillName, label) {
  const rows = guide.split("\n").filter((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) return false;
    const cells = trimmed.split("|").slice(1, -1);
    return cells.length >= 2 && cellName(cells[0]) === skillName;
  });
  assert.equal(
    rows.length,
    1,
    `${label}: expected exactly one table row whose first cell is \`${skillName}\`, found ${rows.length}`,
  );
  const cells = rows[0]
    .trim()
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());
  return { row: rows[0], body: cells.slice(1).join(" ") };
}

/** @description Splits a SKILL.md into what is outside the manual fence and what is inside it. */
function split(content, label) {
  assert.equal(
    content.split(FENCE_START).length,
    2,
    `${label}: ${FENCE_START} must appear exactly once — a duplicate silently redraws the fence`,
  );
  assert.equal(
    content.split(FENCE_END).length,
    2,
    `${label}: ${FENCE_END} must appear exactly once — a duplicate silently redraws the fence`,
  );
  const start = content.indexOf(FENCE_START);
  const end = content.indexOf(FENCE_END);
  assert.ok(end > start, `${label}: ${FENCE_END} must come after ${FENCE_START}`);
  return { head: content.slice(0, start), fallback: content.slice(start, end), tail: content.slice(end) };
}

/** @description The `## 2.` section of the head, sliced at real heading boundaries (not a window). */
function sectionTwo(head, label) {
  const start = head.indexOf("\n## 2.");
  assert.notEqual(start, -1, `${label}: the head must have a "## 2." section documenting Release-As`);
  const rest = head.indexOf("\n## ", start + 1);
  return rest === -1 ? head.slice(start) : head.slice(start, rest);
}

/** @description The frontmatter `description:` — the only text the model reads before invoking. */
function description(content, label) {
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(fm, `${label}: missing YAML frontmatter`);
  const desc = fm[1].match(/^description:\s*(.+)$/m);
  assert.ok(desc, `${label}: missing a description: in the frontmatter`);
  return desc[1].trim();
}

function load(target) {
  const content = readFileSync(target.url, "utf8");
  const parts = split(content, target.label);
  return { content, ...parts, lines: [...parts.head.split("\n")] };
}

test("ac-1.2 — release-please-config.json still says what SKILL.md §2.1 documents", { skip: SKIP }, () => {
  const cfg = JSON.parse(readFileSync(new URL("release-please-config.json", REPO_ROOT), "utf8"));
  assert.equal(
    cfg["bump-minor-pre-major"],
    true,
    "release-please-config.json changed: update SKILL.md §2.1 (breaking → minor pre-1.0) and this test together",
  );
  assert.equal(
    cfg["bump-patch-for-minor-pre-major"],
    false,
    "release-please-config.json changed: update SKILL.md §2.1 (feat: → minor pre-1.0) and this test together",
  );
});

test("#831 ac-X.1 — every shell discovered under core/ ships an OPERATOR-GUIDE", { skip: SKIP }, () => {
  assert.ok(SHELLS.length > 0, "no shell discovered under core/ — the discovery predicate is broken");
  const missing = SHELLS.filter((shell) => !existsSync(GUIDE_OF(shell)));
  assert.deepEqual(
    missing,
    [],
    `shells without docs/OPERATOR-GUIDE.md: ${missing.join(", ")} — the guide is the index an operator reads before opening a skill`,
  );
});

test("#831 ac-X.2 — discovery reads the disk and never counts a symlink as a shell", { skip: SKIP }, () => {
  for (const entry of readdirSync(CORE, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      assert.ok(!SHELLS.includes(entry.name), `symlink core/${entry.name} counted as a shell`);
    }
  }
  for (const shell of SHELLS) {
    assert.ok(existsSync(new URL(`${shell}/skills/`, CORE)), `discovered shell without skills/: ${shell}`);
  }
});

test("#831 ac-X.2 — every discovered releasing-versions SKILL.md declares a frontmatter name", { skip: SKIP }, () => {
  const nameless = RELEASE_SKILLS.filter((skill) => skill.name === null).map((skill) => skill.label);
  assert.deepEqual(
    nameless,
    [],
    `SKILL.md without a name: frontmatter: ${nameless.join(", ")} — the guide row is keyed by that name`,
  );
});

test("#831 ac-X.2 — every shell shipping releasing-versions has a language profile here", { skip: SKIP }, () => {
  const uncovered = RELEASE_SKILLS.filter((skill) => !SKILL_LANGUAGE[skill.shell]).map((skill) => skill.shell);
  assert.deepEqual(
    uncovered,
    [],
    `shells with a releasing-versions skill and no SKILL_LANGUAGE entry: ${uncovered.join(", ")} — add { twice, never, manualHeadings } before the shell ships`,
  );
});

test("#831 ac-X.2 — every SKILL_LANGUAGE entry still matches a shell that ships the skill", { skip: SKIP }, () => {
  const covered = RELEASE_SKILLS.map((skill) => skill.shell);
  const orphaned = Object.keys(SKILL_LANGUAGE)
    .filter((shell) => !covered.includes(shell))
    .sort();
  assert.deepEqual(
    orphaned,
    [],
    `SKILL_LANGUAGE names shells that no longer ship a releasing-versions skill: ${orphaned.join(", ")} — discovery would silently drop their SKILL.md tests; delete the entry deliberately or restore the skill`,
  );
});

for (const shell of SHELLS) {
  const skill = RELEASE_SKILLS.find((s) => s.shell === shell) ?? null;
  const label = `core/${shell}/docs/OPERATOR-GUIDE.md`;

  test(`#831 ac-1.1/1.2 — the releasing-versions row describes the release-please regime (${label})`, { skip: SKIP }, () => {
    if (!existsSync(GUIDE_OF(shell))) return; // #ac-X.1 owns the missing-guide failure

    const guide = readFileSync(GUIDE_OF(shell), "utf8");
    if (!skill || !skill.name) {
      // Shell ships no (nameable) release skill: the guide must not document one either.
      const orphans = guide.split("\n").filter((line) => {
        const trimmed = line.trim();
        return trimmed.startsWith("|") && RELEASE_SKILL_DIR.test(cellName(trimmed.split("|")[1] ?? ""));
      });
      assert.deepEqual(
        orphans,
        [],
        `${label}: documents a releasing-versions skill that core/${shell}/skills/ does not ship`,
      );
      return;
    }

    const { body } = guideRow(guide, skill.name, label);
    assert.match(body, /release-please/i, `${label}: the ${skill.name} row must name the release-please regime`);
    assert.ok(body.includes("chore(main): release"), `${label}: the row must name the PR the action opens`);
    assert.match(body, CONVENTIONAL, `${label}: the row must name Conventional Commits as the input`);
    assert.match(body, /\btag\b/i, `${label}: the row must state the merge creates the tag`);
    assert.ok(body.includes("GitHub Release"), `${label}: the row must state the merge creates the GitHub Release`);
    assert.match(body, /autom[aá]tic/i, `${label}: the row must state tag + Release happen automatically`);
  });

  test(`#831 ac-1.3 — the row never presents the manual flow as the flow (${label})`, { skip: SKIP }, () => {
    if (!skill || !skill.name || !existsSync(GUIDE_OF(shell))) return; // covered by the tests above

    const { body } = guideRow(readFileSync(GUIDE_OF(shell), "utf8"), skill.name, label);
    const releasePlease = body.search(/release-please/i);
    const manual = body.search(/\bmanual\b/i);
    assert.notEqual(releasePlease, -1, `${label}: the row must name release-please`);
    assert.ok(
      manual === -1 || releasePlease < manual,
      `${label}: the row names the manual flow before release-please — where release-please is configured it IS the flow`,
    );
    if (manual !== -1) {
      assert.match(body, /fallback/i, `${label}: the manual flow may appear in the row only as the declared fallback`);
    }
    for (const token of MANUAL_TOKENS) {
      assert.ok(
        !body.includes(token),
        `${label}: the row carries the manual token "${token}" — the index must not hand out the fallback recipe`,
      );
    }
  });
}

for (const t of TARGETS) {
  test(`ac-1.1 — release-please is the primary flow above the fence (${t.label})`, { skip: SKIP }, () => {
    const { head } = load(t);

    assert.match(head, /release-please/i, `${t.label}: the primary section must name release-please`);
    for (const form of ["release-please-config.json", ".release-please-manifest.json", "release-please-action"]) {
      assert.ok(head.includes(form), `${t.label}: regime detection must check "${form}" (all three forms)`);
    }
    assert.ok(head.includes("chore(main): release"), `${t.label}: must name the PR title the action opens`);
    assert.match(head, /\btag\b/i, `${t.label}: must state the merge creates the tag`);
    assert.match(head, /Release\b/, `${t.label}: must state the merge creates the GitHub Release`);
    assert.match(head, /autom[aá]tic/i, `${t.label}: must state tag + Release happen automatically`);
    assert.match(head, /Conventional Commits/i, `${t.label}: must state the input is Conventional Commits`);
    assert.match(head, /npm/i, `${t.label}: must state the release-please flow does not publish to npm here`);
  });

  test(`ac-1.1 — the frontmatter description names the release-please regime (${t.label})`, { skip: SKIP }, () => {
    const content = readFileSync(t.url, "utf8");
    const desc = description(content, t.label);

    assert.match(desc, /release-please/i, `${t.label}: the description must name the release-please regime`);
    assert.ok(
      !MANUAL_PROMISE.test(desc),
      `${t.label}: the description must not promise a hand-rolled version bump + CHANGELOG edit — it is read before §0`,
    );
    for (const token of MANUAL_TOKENS) {
      assert.ok(!desc.includes(token), `${t.label}: the description must not carry the manual token "${token}"`);
    }
  });

  test(`ac-1.2 — Release-As and the pre-major bump rules are documented (${t.label})`, { skip: SKIP }, () => {
    const { head } = load(t);

    assert.ok(head.includes("Release-As:"), `${t.label}: must document the Release-As footer`);
    assert.ok(head.includes("bump-minor-pre-major"), `${t.label}: must document bump-minor-pre-major`);
    assert.ok(head.includes("bump-patch-for-minor-pre-major"), `${t.label}: must document bump-patch-for-minor-pre-major`);
    assert.match(head, /squash/i, `${t.label}: must document the squash-merge gotcha for the Release-As footer`);

    const section = sectionTwo(head, t.label);
    assert.match(section, /feat!/, `${t.label}: §2 must work the breaking-change case concretely`);
    assert.match(section, /0\.56\.0/, `${t.label}: §2 must show 0.55.71 + feat! = 0.56.0`);
    assert.match(section, /1\.0\.0/, `${t.label}: §2 must state Release-As is the only path to 1.0.0`);
  });

  test(`ac-1.3 — major double-confirmation and never-commit-to-main survive (${t.label})`, { skip: SKIP }, () => {
    const { lines } = load(t);

    assert.ok(
      lines.some((line) => line.includes("Release-As") && t.twice.test(line)),
      `${t.label}: the double-confirmation for a major must be stated on the Release-As rule itself`,
    );
    assert.ok(
      lines.some((line) => t.never.test(line) && /\bmain\b/.test(line)),
      `${t.label}: the release-please regime must keep the "never commit a release to main" rule`,
    );
  });

  test(`ac-2.1 — github-actions[bot]/action_required failure mode and its unblock (${t.label})`, { skip: SKIP }, () => {
    const { head, lines } = load(t);

    assert.ok(head.includes("github-actions[bot]"), `${t.label}: must name the bot that authors the release PR`);
    assert.ok(head.includes("action_required"), `${t.label}: must name the action_required state`);
    assert.match(head, /zero jobs|0 jobs|nenhum job/i, `${t.label}: must state the run materialises no jobs`);
    assert.ok(head.includes(MISSING_REASON), `${t.label}: must quote the entry-gate denial verbatim: "${MISSING_REASON}"`);

    assert.ok(head.includes("statusCheckRollup"), `${t.label}: diagnosis must read what the gate reads`);
    assert.match(head, /approve|aprovar/i, `${t.label}: must document approving the pending run`);
    assert.match(head, /reopen/i, `${t.label}: must document the close/reopen exit for the no-run-at-all case`);
    assert.match(head, /toggle/i, `${t.label}: must situate the repo toggle`);
    assert.match(head, /Settings\s*→\s*Actions/, `${t.label}: must name Settings → Actions`);

    assert.ok(
      lines.some((line) => t.never.test(line) && /gate/i.test(line) && /(contorn|bypass|work.?around)/i.test(line)),
      `${t.label}: must forbid bypassing the entry-gate on an explicit line`,
    );
    assert.ok(head.includes("--admin"), `${t.label}: must name the concrete bypass it forbids`);
  });

  test(`ac-2.2 — no manual instruction outside the fenced fallback (${t.label})`, { skip: SKIP }, () => {
    const { head, tail } = load(t);
    const outside = [...head.split("\n"), ...tail.split("\n")];

    for (const token of MANUAL_TOKENS) {
      const offenders = outside.filter((line) => line.includes(token) && !line.includes(PROHIBITION));
      assert.deepEqual(
        offenders,
        [],
        `${t.label}: "${token}" appears outside the fenced manual fallback and is not marked ${PROHIBITION}`,
      );
    }
  });

  test(`ac-3.1 — the manual modes exist only as a gated fallback (${t.label})`, { skip: SKIP }, () => {
    const { head, fallback, tail } = load(t);

    const gate = fallback.slice(0, 900);
    assert.match(gate, /fallback/i, `${t.label}: the fenced section must declare itself the fallback`);
    assert.match(gate, /release-please/i, `${t.label}: the fallback gate must name release-please`);
    assert.match(gate, /(PARE|STOP)/, `${t.label}: the fallback must open with an explicit stop`);
    assert.match(
      gate,
      /(SEM release-please|WITHOUT release-please)/i,
      `${t.label}: the fallback must state it is only for projects without release-please`,
    );

    for (const heading of t.manualHeadings) {
      assert.ok(fallback.includes(heading), `${t.label}: ${heading} must still exist — vendored consumers depend on it`);
      assert.ok(!head.includes(heading), `${t.label}: ${heading} must not appear above the fence as the primary flow`);
      assert.ok(!tail.includes(heading), `${t.label}: ${heading} must not be re-appended after the fence ends`);
    }
  });
}
