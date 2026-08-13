/** @description Locks Claude Code parity for an operator-requested stable-plan resume. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const triage = readFileSync(join(root, "SKILL.md"), "utf8");
const build = readFileSync(join(root, "../../agents/build.md"), "utf8");

test("an explicit resume uses the stable feature plan without repeating ceremony", () => {
  for (const text of [triage, build]) {
    assert.match(text, /\.opencode\/plans\/<feature_id>\/execution-plan\.json/);
    assert.match(text, /explicit.*resume|explicit.*retom|operator.*resume/i);
    assert.match(text, /do not (?:load |dispatch |invoke )?(?:brainstorming, )?planner.*plan-reviewer|do not invoke planner or reviewer/i);
  }
  assert.match(triage, /current checkout is the context, exactly as in Claude Code/i);
  assert.match(triage, /use that plan's own[\s\S]{0,100}feature_id[\s\S]{0,100}mode/i);
  assert.match(triage, /do not[\s\S]{0,100}silently create a replacement plan/i);
});
