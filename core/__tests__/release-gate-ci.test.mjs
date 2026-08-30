import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

// #833 — the three pre-existing tests below stay on the Claude Code file, byte-parallel to before.
// The only change to them is HOW that path is built: it now resolves through the real
// core/claude-code/ directory instead of the legacy core/skills -> claude-code/skills symlink
// (readlink -f core/skills/releasing-versions/SKILL.md == core/claude-code/skills/releasing-versions/SKILL.md,
// so this is a zero-behavior-change move, per #ac-X.1).
const CC_SKILL_PATH = resolve(__dirname, "../claude-code/skills/releasing-versions/SKILL.md");

test("release-gate-ci: SKILL.md contains CI-green gate in MODO FINISH", () => {
  const content = readFileSync(CC_SKILL_PATH, "utf-8");

  // Assertion 1: MODO FINISH mentions gh pr checks and PR number parsing
  const modoFinishMatch = content.match(
    /## MODO FINISH.*?(?=## Regras|$)/s
  );
  assert(modoFinishMatch, "SKILL.md must contain MODO FINISH section");

  const modoFinishText = modoFinishMatch[0];
  assert(
    modoFinishText.includes("gh pr checks") && modoFinishText.includes("PR number"),
    "MODO FINISH must instruct running `gh pr checks` with PR number"
  );
  assert(
    modoFinishText.includes("refuse") && (modoFinishText.includes("red") || modoFinishText.includes("Red")),
    "MODO FINISH must state refusal when checks are red"
  );
});

test("release-gate-ci: gate is fail-soft when no CI workflow", () => {
  const content = readFileSync(CC_SKILL_PATH, "utf-8");

  // Assertion 2: states the gate is fail-soft (warn, not block) when no CI
  const modoFinishMatch = content.match(
    /## MODO FINISH.*?(?=## Regras|$)/s
  );
  assert(modoFinishMatch, "SKILL.md must contain MODO FINISH section");

  const modoFinishText = modoFinishMatch[0];
  assert(
    (modoFinishText.includes("fail-soft") || modoFinishText.includes("warn")) &&
    modoFinishText.includes("CI workflow"),
    "MODO FINISH must state gate is fail-soft (warn, not block) when no CI workflow"
  );
});

test("release-gate-ci: MODO OPEN step 4 does not assume package.json", () => {
  const content = readFileSync(CC_SKILL_PATH, "utf-8");

  // Assertion 3: MODO OPEN step 4 handles both project types
  const modoOpenMatch = content.match(
    /## MODO OPEN.*?(?=## MODO FINISH|$)/s
  );
  assert(modoOpenMatch, "SKILL.md must contain MODO OPEN section");

  const modoOpenText = modoOpenMatch[0];

  // Step 4 should mention detecting project type and running appropriate test command
  const step4Match = modoOpenText.match(
    /### 4\..*?(?=### \d+|## |$)/s
  );
  assert(step4Match, "MODO OPEN must have step 4");

  const step4Text = step4Match[0];
  assert(
    (step4Text.includes("package.json") || step4Text.includes("project type")) &&
    (step4Text.includes("node --test") || step4Text.includes("detect")),
    "Step 4 must detect project type and not assume package.json (e.g., support VERSION + node --test)"
  );
});

// ---------------------------------------------------------------------------
// #833 ac-2.1 — the CI gate becomes a shell-general oracle.
//
// A shell = a REAL directory under core/ that contains skills/ (#831's discovery predicate).
// This is duplicated here rather than imported from a shared module deliberately: this file's
// task is to own core/__tests__/release-gate-ci.test.mjs only, and
// core/__tests__/releasing-versions-release-please-coherence.test.mjs is the canonical definition
// (see its #831 JSDoc) — keep the two in sync by hand if the predicate ever changes.
// ---------------------------------------------------------------------------

const REPO_ROOT = new URL("../../", import.meta.url);
const CORE = new URL("core/", REPO_ROOT);

function discoverShells(core) {
  return readdirSync(core, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
    .filter((name) => existsSync(new URL(`${name}/skills/`, core)))
    .sort();
}

const SHELLS = discoverShells(CORE);
const RELEASE_SKILL_DIR = /(?:^|-)releasing-versions$/;

/** The releasing-versions skill a shell ships, or null. Keyed on directory name, per the spec —
 *  the gate is about file content, not the frontmatter `name:` used for guide-row lookups. */
function releaseSkillOf(shell) {
  const skills = new URL(`${shell}/skills/`, CORE);
  if (!existsSync(skills)) return null;
  const dirs = readdirSync(skills, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && RELEASE_SKILL_DIR.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (dirs.length === 0) return null;
  const [dir] = dirs;
  const url = new URL(`${dir}/SKILL.md`, skills);
  const label = `core/${shell}/skills/${dir}/SKILL.md`;
  if (!existsSync(url)) return null;
  return { shell, dir, url, label };
}

// A shell that legitimately ships no releasing-versions skill must be added here, deliberately,
// with a reason. Coverage cannot shrink in silence: test below fails first and forces the entry.
const KNOWN_WITHOUT_RELEASE_SKILL = [];

test("#833 ac-2.1 — every discovered shell ships a releasing-versions SKILL.md the gate is pinned on", () => {
  assert.ok(SHELLS.length > 0, "no shell discovered under core/ — the discovery predicate is broken");
  const missing = SHELLS.filter(
    (s) => !releaseSkillOf(s) && !KNOWN_WITHOUT_RELEASE_SKILL.includes(s)
  );
  assert.deepEqual(
    missing,
    [],
    `shells with no releasing-versions skill and no allowlist entry: ${missing.join(", ")} — ` +
      "add a KNOWN_WITHOUT_RELEASE_SKILL entry with a reason, deliberately, or restore the skill"
  );
});

const FENCE_START = "<!-- release-please:fallback-start -->";
const FENCE_END = "<!-- release-please:fallback-end -->";
const FINISH_HEADING = /^##[^\n]*\bFINISH\b[^\n]*$/m;

const RED = ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT"];
const GREEN = ["SUCCESS", "SKIPPED", "NEUTRAL", "PENDING"];

/** Slices a SKILL.md into head/fallback/tail (fence-anchored) and, inside the fallback, the FINISH
 *  section (from its heading to the next "## " heading, or fallback end). Language-independent:
 *  FINISH is a protocol token identical in "## MODO FINISH" and "## FINISH mode". */
function loadTarget(target) {
  const content = readFileSync(target.url, "utf8");

  assert.equal(
    content.split(FENCE_START).length,
    2,
    `${target.label}: ${FENCE_START} must appear exactly once`
  );
  assert.equal(
    content.split(FENCE_END).length,
    2,
    `${target.label}: ${FENCE_END} must appear exactly once`
  );

  const start = content.indexOf(FENCE_START);
  const end = content.indexOf(FENCE_END);
  assert.ok(end > start, `${target.label}: ${FENCE_END} must come after ${FENCE_START}`);

  const head = content.slice(0, start);
  const fallback = content.slice(start, end);
  const tail = content.slice(end);

  const finishMatch = fallback.match(FINISH_HEADING);
  assert.ok(finishMatch, `${target.label}: no FINISH-mode heading found inside the fenced fallback`);
  const finishStart = finishMatch.index;
  const nextHeading = fallback.indexOf("\n## ", finishStart + 1);
  const finish = nextHeading === -1 ? fallback.slice(finishStart) : fallback.slice(finishStart, nextHeading);

  return { content, head, fallback, tail, finish };
}

const TARGETS = SHELLS.map(releaseSkillOf).filter(Boolean);

// ---------------------------------------------------------------------------
// #840 — CC catches up to OC on three points: the "(#N)" suffix in mode detection, the empty
// PR-number guard, and the non-green fourth branch. Both files now carry the same trigger, the
// same verdict and the same action at each point.
//
// Two differences remain, both PROSE and both file-wide conventions that predate this issue,
// not rules one shell enforces and the other does not (paridade_nao_superacao is about rules):
//   1. language and mode labels — CC is pt-br-without-accents with "MODO FINISH" and no trailing
//      period on its bullets; OC is English with "FINISH mode". Normalizing that is another issue.
//   2. CC's guard additionally names the mechanism verified in #833 — `gh` resolves the CURRENT
//      BRANCH's PR and exits 1 with "no pull requests found for branch <name>". Same rule, same
//      trigger, same action; CC just states why the degradation happens.
// The guard rationale is therefore asserted at its SEMANTIC CORE (/fail-soft|silent|silenci|degrad/),
// which both files satisfy today, and never at CC's extra clause: #840 forbids adding a single line
// of prose to the OpenCode file, so no assertion here may push a future author toward editing it.
// ---------------------------------------------------------------------------

const NON_GREEN = [
  "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE",
  "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED", "EXPECTED",
];
// Word-bounded on purpose: a naive includes() reads "FAILURE" inside "STARTUP_FAILURE" and the
// branch-partition assertions below collapse into false positives.
const tokenRe = (tok) => new RegExp(`\\b${tok}\\b`);

for (const t of TARGETS) {
  test(`#833 ac-1.1 — the FINISH mode gates on gh pr checks before creating the tag (${t.label})`, () => {
    const { finish } = loadTarget(t);

    assert.ok(finish.includes("gh pr checks"), `${t.label}: FINISH mode must run gh pr checks`);
    assert.ok(
      finish.includes("--json state"),
      `${t.label}: must read the STATE via --json state, not a bare exit-code call`
    );

    const gateAt = finish.search(/gh pr checks/);
    const tagAt = finish.search(/^\s*git tag v/m);
    assert.notEqual(gateAt, -1, `${t.label}: "gh pr checks" not found in the FINISH slice`);
    assert.notEqual(tagAt, -1, `${t.label}: "git tag vX.Y.Z" not found in the FINISH slice`);
    assert.ok(
      gateAt < tagAt,
      `${t.label}: the CI gate must run BEFORE "git tag vX.Y.Z", not after (a renumber that moves the gate past tag creation must fail here)`
    );
  });

  test(`#833 ac-1.1 — the gate evaluates the STATE, never the exit code (${t.label})`, () => {
    const { finish } = loadTarget(t);

    assert.match(finish, /STATE/, `${t.label}: must reference STATE explicitly`);
    assert.match(finish, /exit code/i, `${t.label}: must name "exit code" as what is NOT used`);
    assert.match(finish, /ambig/i, `${t.label}: must state the exit-code ambiguity rationale`);
    assert.match(finish, /\bexit 1\b/, `${t.label}: must cite the concrete "exit 1" ambiguity`);

    for (const tok of RED) {
      assert.ok(finish.includes(tok), `${t.label}: red token "${tok}" missing from the FINISH slice`);
    }
    for (const tok of GREEN) {
      assert.ok(finish.includes(tok), `${t.label}: green token "${tok}" missing from the FINISH slice`);
    }
  });

  test(`#833 ac-1.2 — the FAIL-SOFT branch is scoped to this manual fallback (${t.label})`, () => {
    const { finish } = loadTarget(t);

    const line = finish
      .split("\n")
      .find(
        (l) =>
          /fail-soft/i.test(l) &&
          /release-please/i.test(l) &&
          /fail-closed/i.test(l) &&
          l.includes("CI workflow")
      );
    assert.ok(
      line,
      `${t.label}: no single line scopes FAIL-SOFT to this fallback ` +
        '(must carry "FAIL-SOFT", "release-please", "fail-closed" and "CI workflow" together)'
    );
  });

  test(`#833 ac-1.1 — the refusing branch names every red STATE and no green one (${t.label})`, () => {
    const { finish } = loadTarget(t);

    assert.match(finish, /\bred\b/i, `${t.label}: the gate must call the failing case red`);

    const redLine = finish
      .split("\n")
      .find((l) => /(refuse|recus)/i.test(l) && RED.some((tok) => l.includes(tok)));
    assert.ok(
      redLine,
      `${t.label}: no single line both names a red STATE and refuses the release`
    );
    for (const tok of RED) {
      assert.ok(
        redLine.includes(tok),
        `${t.label}: the refusing branch dropped "${tok}" — that STATE would now proceed`
      );
    }
    for (const tok of GREEN) {
      assert.ok(
        !redLine.includes(tok),
        `${t.label}: green token "${tok}" leaked into the refusing branch`
      );
    }
    assert.match(
      redLine,
      /(do not create the tag|nao criar tag)/i,
      `${t.label}: the refusing branch must forbid creating the tag`
    );
  });

  test(`#833 ac-1.1 — the proceed branch names every green STATE and no red one (${t.label})`, () => {
    const { finish } = loadTarget(t);

    const greenLine = finish
      .split("\n")
      .find((l) => !/(refuse|recus)/i.test(l) && GREEN.every((tok) => l.includes(tok)));
    assert.ok(
      greenLine,
      `${t.label}: no single line lists all of ${GREEN.join("/")} as the proceed branch`
    );
    for (const tok of RED) {
      assert.ok(
        !greenLine.includes(tok),
        `${t.label}: red STATE "${tok}" is listed as a reason to proceed`
      );
    }
  });

  test(`#833 ac-1.3 — the PR number comes from the (#N) squash suffix (${t.label})`, () => {
    const { finish } = loadTarget(t);

    assert.ok(finish.includes("PR_NUMBER="), `${t.label}: must extract PR_NUMBER`);
    assert.match(
      finish,
      /gh pr checks\s+"?\$\{?PR_NUMBER/,
      `${t.label}: the extracted PR_NUMBER must be what "gh pr checks" is run against`
    );
    assert.ok(finish.includes("sed -nE"), `${t.label}: must use the sed -nE extraction idiom`);
    assert.ok(
      finish.includes("\\(#([0-9]+)\\)"),
      `${t.label}: must use the literal "(#N)" capture-group idiom to pull the PR number`
    );
  });

  test(`#833 ac-1.3 — an unextractable PR number stops the release, it does not fail soft (${t.label})`, () => {
    const { fallback, finish } = loadTarget(t);

    // Derived from the file's own mode-detection line, never from a shell name (#ac-X.2): this
    // shell's regex must literally make the "(#N)" suffix optional for the guard to be reachable.
    const OPTIONAL_SUFFIX = "\\(#[0-9]+\\))?";
    const detect = fallback.split("\n").find((l) => l.includes("chore: release v[0-9]"));
    const suffixOptional = Boolean(detect && detect.includes(OPTIONAL_SUFFIX));

    if (!suffixOptional) return; // this shell's FINISH cannot be entered without the "(#N)" suffix

    const guard = finish
      .split("\n")
      .some(
        (l) =>
          l.includes("PR_NUMBER") &&
          /(empty|vazio|blank)/i.test(l) &&
          /(stop|par(ar|e)\b|ask|pergunt)/i.test(l)
      );
    assert.ok(
      guard,
      `${t.label}: detection makes "(#N)" optional, so FINISH is reachable with no PR number — ` +
        "the gate must stop and ask instead of silently degrading to FAIL-SOFT"
    );
  });

  test(`#833 ac-2.2/#811 — the gate lives inside the release-please fallback fence (${t.label})`, () => {
    const { head, tail } = loadTarget(t);

    assert.ok(
      !head.includes("gh pr checks"),
      `${t.label}: "gh pr checks" appears above the fence — it must live only inside the manual fallback`
    );
    assert.ok(
      !tail.includes("gh pr checks"),
      `${t.label}: "gh pr checks" appears after the fence ends — it must live only inside the manual fallback`
    );
  });

  test(`#840 ac-1.1 — mode detection accepts the "(#N)" squash suffix as optional (${t.label})`, () => {
    const { fallback } = loadTarget(t);
    const detect = fallback.split("\n").find((l) => l.includes("chore: release v[0-9]"));
    assert.ok(detect, `${t.label}: no mode-detection line carrying the release-commit regex`);
    const literal = detect.match(/`(\^chore: release v[^`]*)`/);
    assert.ok(literal, `${t.label}: the mode-detection regex must be a backticked, ^-anchored literal`);
    const re = new RegExp(literal[1]);

    assert.ok(re.test("chore: release v1.0.0 (#839)"),
      `${t.label}: the detection regex rejects the squash commit this same file documents as expected ` +
      `("chore: release vX.Y.Z (#N)") — FINISH is never detected and the skill opens a SECOND release PR`);
    assert.ok(re.test("chore: release v1.0.0"),
      `${t.label}: the "(#N)" suffix must stay OPTIONAL — a non-squash merge must still enter FINISH`);
    assert.ok(!re.test("chore: release v1.0.0 (#839) and then some"),
      `${t.label}: the regex must stay anchored — trailing text must not match`);
  });

  test(`#840 ac-1.2 — an empty PR number stops the release and says why (${t.label})`, () => {
    const { finish } = loadTarget(t);
    const guard = finish.split("\n").find(
      (l) =>
        l.includes("PR_NUMBER") &&
        /(empty|vazio|blank)/i.test(l) &&
        /(stop|par(ar|e)\b|ask|pergunt)/i.test(l)
    );
    assert.ok(guard,
      `${t.label}: nothing stops the release on an empty PR_NUMBER — \`gh pr checks ""\` does not reject ` +
      `the empty argument, it resolves the CURRENT BRANCH's PR, so the gate degrades to FAIL-SOFT or gates the wrong PR`);

    assert.match(guard, /(fail-soft|silent|silenci|degrad)/i,
      `${t.label}: the guard gives no reason it exists — a guard that reads like boilerplate is deleted by the ` +
      `next author. It must say the empty number degrades the gate silently rather than erroring`);

    const tagAt = finish.search(/^\s*git tag v/m);
    assert.ok(finish.indexOf(guard) < tagAt, `${t.label}: the guard must come before "git tag vX.Y.Z"`);
  });

  test(`#840 ac-2.1 — a STATE in none of the known lists is NOT green: stop and ask (${t.label})`, () => {
    const lines = loadTarget(t).finish.split("\n");

    const otherLine = lines.find(
      (l) => NON_GREEN.every((tok) => tokenRe(tok).test(l)) &&
             /(stop|par(ar|e)\b|ask|pergunt)/i.test(l)
    );
    assert.ok(otherLine,
      `${t.label}: no branch enumerates ${NON_GREEN.join("/")} and stops on them — reading "none of the four ` +
      `red tokens is present" as green is the hole (ACTION_REQUIRED is the state this repo's v1.0.0 release PR sat in)`);
    assert.match(otherLine, /(not green|nao e verde|não é verde)/i,
      `${t.label}: the branch must state the verdict: NOT green`);

    const redLine   = lines.find((l) =>  /(refuse|recus)/i.test(l) && RED.some((tok) => l.includes(tok)));
    const greenLine = lines.find((l) => !/(refuse|recus)/i.test(l) && GREEN.every((tok) => l.includes(tok)));
    assert.ok(redLine && greenLine, `${t.label}: the red and green branches must both still exist`);

    // Partition: each STATE is claimed by exactly one branch. This is the #833 lesson made structural —
    // moving TIMED_OUT from red to green left every presence assertion green; it cannot here.
    for (const tok of NON_GREEN) {
      assert.ok(!tokenRe(tok).test(greenLine), `${t.label}: non-green STATE "${tok}" is listed as a reason to PROCEED`);
      assert.ok(!tokenRe(tok).test(redLine),   `${t.label}: "${tok}" is on the red branch — it is not a failure, it is unconcluded`);
    }
    for (const tok of [...RED, ...GREEN]) {
      assert.ok(!tokenRe(tok).test(otherLine), `${t.label}: known STATE "${tok}" leaked into the "any other state" branch`);
    }

    assert.match(loadTarget(t).finish, /\b(four|quatro)\s+(branch|ramo)/i,
      `${t.label}: the gate preamble still announces the old branch count — the file contradicts itself`);
  });
}

// #840 ac-4.1 — the detection regex is the one rule both shells must carry CHARACTER for
// character; it is protocol, not prose, so language cannot excuse a difference. Locked across
// every discovered shell so a semantically-equal rewrite (\d for [0-9], \s for the literal space)
// cannot re-open the drift this issue closed while the behavior assertions above stay green.
test("#840 ac-4.1 — every shell carries the SAME mode-detection regex, character for character", () => {
  const literals = TARGETS.map((t) => {
    const { fallback } = loadTarget(t);
    const detect = fallback.split("\n").find((l) => l.includes("chore: release v[0-9]"));
    assert.ok(detect, `${t.label}: no mode-detection line carrying the release-commit regex`);
    const m = detect.match(/`(\^chore: release v[^`]*)`/);
    assert.ok(m, `${t.label}: the mode-detection regex must be a backticked, ^-anchored literal`);
    return { label: t.label, re: m[1] };
  });
  const [first, ...rest] = literals;
  for (const other of rest) {
    assert.equal(
      other.re,
      first.re,
      `${other.label} and ${first.label} carry DIFFERENT mode-detection regexes ` +
        `(${other.re} vs ${first.re}) — #840 closed this drift; a shell may not re-open it`
    );
  }
});
