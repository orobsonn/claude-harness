/**
 * @description The `-high` rung agents (`executor-high`, `sniper-high`) exist for ONE reason: the
 * `Agent` tool takes a `model` override but no effort parameter, so a rung whose escalation IS the
 * reasoning effort has to live in an agent DEFINITION (`effort:` frontmatter). That forces the
 * instruction body to be duplicated — and duplication that is only asked to stay in sync by a
 * comment always drifts. These tests make the drift unmergeable instead: the bodies must be
 * byte-identical, and only the four frontmatter keys that define the rung may differ.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HAND_LADDERS, HAND_EFFORT_BY_TIER, agentTypeForRung } from "../shared/lib/hand-model-ladder.mjs";

const AGENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "claude-code", "agents");

/** @description Splits an agent file into its frontmatter map and its instruction body. */
function parseAgent(name) {
  const raw = readFileSync(join(AGENTS_DIR, `${name}.md`), "utf8");
  const [, frontmatter, body] = raw.split(/^---$/m, 3);
  const fm = {};
  for (const line of frontmatter.split("\n")) {
    const match = line.match(/^([a-zA-Z_-]+):\s*(.*)$/);
    if (match) fm[match[1]] = match[2].trim();
  }
  return { fm, body, raw };
}

/** @description Strips the leading "this is the high rung" note the variant carries. */
function withoutRungNote(body) {
  return body.replace(/^\s*(> .*\n)+/, "").trimStart();
}

for (const role of ["executor", "sniper"]) {
  test(`${role}-high: same model, higher effort — the rung IS the effort`, () => {
    const base = parseAgent(role);
    const high = parseAgent(`${role}-high`);

    assert.equal(high.fm.name, `${role}-high`);
    assert.equal(high.fm.model, base.fm.model, "the high rung must pin the SAME model as its base role");
    assert.equal(
      high.fm.effort,
      HAND_EFFORT_BY_TIER.claude.high,
      "the high rung's effort must be the one the ladder declares",
    );
    assert.equal(base.fm.effort, undefined, "the base role must NOT pin an effort (it is the medium rung)");
  });

  test(`${role}-high: instruction body is byte-identical to its base role (drift is unmergeable)`, () => {
    const base = parseAgent(role);
    const high = parseAgent(`${role}-high`);
    assert.equal(
      withoutRungNote(high.body),
      base.body.trimStart(),
      `${role}-high.md must carry the SAME instructions as ${role}.md — only the frontmatter rung differs`,
    );
  });

  test(`${role}-high: same tool set — a rung must not quietly widen its own blast radius`, () => {
    const base = parseAgent(role);
    const high = parseAgent(`${role}-high`);
    const tools = (agent) => (agent.raw.split(/^---$/m, 2)[1].match(/^\s+- \w+$/gm) ?? []).join(",");
    assert.equal(tools(high), tools(base));
  });
}

test("agentTypeForRung: only the high rung of the claude ladder gets its own agent", () => {
  const ladder = HAND_LADDERS.claude;
  assert.equal(agentTypeForRung("executor", ladder.low, "low"), "executor");
  assert.equal(agentTypeForRung("executor", ladder.medium, "medium"), "executor");
  assert.equal(agentTypeForRung("executor", ladder.high, "high"), "executor-high");
  assert.equal(agentTypeForRung("sniper", ladder.high, "high"), "sniper-high");
  // The ollama family never routes through the Agent tool, so its rungs have no agent variant.
  assert.equal(agentTypeForRung("executor", HAND_LADDERS.ollama.high, "high"), "executor");
});
