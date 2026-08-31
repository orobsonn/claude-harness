/**
 * @description Locks the interactive autonomy directive: a present operator can
 * explicitly delegate engineering decisions without silently delegating product
 * scope or external authority.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const skill = readFileSync(join(here, "SKILL.md"), "utf8");
const triage = readFileSync(join(here, "..", "triaging-requests", "SKILL.md"), "utf8");
const brainstorming = readFileSync(join(here, "..", "brainstorming", "SKILL.md"), "utf8");

test("#autonomy — delegation is prose, never an idle host continuation", () => {
  for (const document of [skill, triage, brainstorming]) {
    assert.doesNotMatch(document, /native autonomy controller|idle motor|re-prompt/i);
    assert.match(document, /does not\s+inject|does not\s+re-open|no host continuation/i);
  }
});

test("#autonomy — explicit operator directive delegates autonomous delivery in a live session", () => {
  assert.match(skill, /Delegated autonomy/i);
  assert.match(skill, /aut[oô]nom|sem (?:parar|perguntar)/i);
  assert.match(skill, /prompt-level delegation/i);
  assert.match(triage, /Autonomy directive/i);
  assert.doesNotMatch(triage, /communicate progress normally/i);
  assert.match(triage, /do not emit intermediate status/i);
  assert.match(brainstorming, /Autonomy directive/i);
});

test("#autonomy — same-contract engineering is resolved and verified without an operator stop", () => {
  assert.match(skill, /decomposition|split|re-plan/i);
  assert.match(skill, /rail error|marker|gate/i);
  assert.match(skill, /provider|transient/i);
  assert.match(skill, /do not ask the operator/i);
  assert.match(skill, /deterministic|bounded|limit/i);
  assert.match(skill, /virgin/i);
});

test("#autonomy — autonomous delivery emits no textual progress turn between lawful actions", () => {
  assert.doesNotMatch(skill, /while retaining normal progress messages/i);
  assert.match(skill, /do not send\s+(?:an )?intermediate textual (?:build )?response/i);
  assert.match(skill, /next lawful tool call/i);
  assert.match(skill, /final delivery[\s\S]*product decision[\s\S]*formal rail block/i);
  assert.match(skill, /do not say.*vou|do not say.*na sequ|continuando automaticamente/i);
  assert.match(skill, /partial delivery is not a terminal state/i);
  assert.match(skill, /any remaining task, gate, review, demo, PR, or merge/i);
  assert.match(skill, /stable plan plus durable\s+task\/capture\/final-review\/ship evidence/i);
  assert.match(skill, /literal native\s+tool output and the authority required/i);
});

test("#autonomy — only a choice that changes the delivered product remains human-owned", () => {
  assert.match(skill, /product (?:behavior|contract)|user receives/i);
  assert.match(skill, /only permitted question/i);
  assert.match(skill, /same observable contract/i);
  assert.match(skill, /infrastructure|deploy|publish/i);
});

test("#autonomy — engineering repairs may not weaken rails or mutate frozen tests through an executor", () => {
  assert.match(skill, /never disable a rail, relax a locked assertion/i);
  assert.match(skill, /test-author/i);
  assert.match(skill, /fidelity/i);
});
