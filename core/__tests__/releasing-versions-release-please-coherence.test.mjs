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

const TARGETS = [
  {
    label: "core/claude-code/skills/releasing-versions/SKILL.md",
    url: new URL("core/claude-code/skills/releasing-versions/SKILL.md", REPO_ROOT),
    twice: /duas vezes/i,
    never: /NUNCA/,
    manualHeadings: ["## MODO OPEN", "## MODO FINISH"],
  },
  {
    label: "core/opencode/skills/releasing-versions/SKILL.md",
    url: new URL("core/opencode/skills/releasing-versions/SKILL.md", REPO_ROOT),
    twice: /twice/i,
    never: /NEVER/,
    manualHeadings: ["## OPEN mode", "## FINISH mode"],
  },
];

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
