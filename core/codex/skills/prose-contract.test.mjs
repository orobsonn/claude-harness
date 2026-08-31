import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const SKILLS = join(new URL("..", import.meta.url).pathname, "skills");
const REQUIRED_CONTRACTS = [
  "harness-delivery/references/delivery-contract.md",
  "harness-rules/references/governance-contract.md",
  "harness-learning/references/knowledge-contract.md",
];

test("Codex skill layer carries executable delivery prose instead of empty routing stubs", () => {
  for (const entry of readdirSync(SKILLS, { withFileTypes: true }).filter((item) => item.isDirectory())) {
    const skill = join(SKILLS, entry.name, "SKILL.md");
    const text = readFileSync(skill, "utf8");
    assert.ok(text.trim().split(/\r?\n/).length >= 15, `${entry.name} needs a focused operational contract`);
    assert.match(text, /\.codex\/skills\/harness-(delivery|rules|learning)\/references\//, `${entry.name} must link its portable contract`);
  }
  for (const relative of REQUIRED_CONTRACTS) {
    assert.ok(existsSync(join(SKILLS, relative)), `missing shared Codex contract: ${relative}`);
  }
});

test("contracts retain high-leverage gates while avoiding a second mutable workflow engine", () => {
  const delivery = readFileSync(join(SKILLS, REQUIRED_CONTRACTS[0]), "utf8");
  const governance = readFileSync(join(SKILLS, REQUIRED_CONTRACTS[1]), "utf8");
  const knowledge = readFileSync(join(SKILLS, REQUIRED_CONTRACTS[2]), "utf8");
  for (const token of ["QUICK", "LIGHT", "FULL", "red", "green", "adversarial", "model", "evidência"]) {
    assert.match(delivery, new RegExp(token, "i"));
  }
  assert.match(delivery, /reasoning_effort/);
  assert.doesNotMatch(delivery, /model_reasoning_effort/);
  for (const token of ["UNARMED", "ARMED", "REARM", "fidelity-before-freeze", "hash da closure", "fresh-virgin", "fix HIGH"]) {
    assert.match(delivery, new RegExp(token, "i"));
  }
  assert.match(delivery, /Em dúvida.*ARMED|dúvida.*ARMED/i, "unknown arming must fail closed");
  assert.match(delivery, /escala pretendida/i, "UNARMED is about intended-scale coincidence, not missing reproduction");
  assert.match(delivery, /observável.*verificado falso|verificado falso.*observável/i, "a parked finding needs a checked-false REARM observable");
  for (const token of ["sandbox", "segredo", "release", "review", "force-with-lease"]) {
    assert.match(governance, new RegExp(token, "i"));
  }
  assert.match(knowledge, /MEMORY\.md/);
  assert.match(knowledge, /kaizen\.md/);
});
