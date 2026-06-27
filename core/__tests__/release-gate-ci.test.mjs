import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

test("release-gate-ci: SKILL.md contains CI-green gate in MODO FINISH", () => {
  const skillPath = resolve(__dirname, "../skills/releasing-versions/SKILL.md");
  const content = readFileSync(skillPath, "utf-8");

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
  const skillPath = resolve(__dirname, "../skills/releasing-versions/SKILL.md");
  const content = readFileSync(skillPath, "utf-8");

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
  const skillPath = resolve(__dirname, "../skills/releasing-versions/SKILL.md");
  const content = readFileSync(skillPath, "utf-8");

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
