/** @description Active delivery prose must not advertise the retired shell marker CLI/checkpoints. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const skill = join(dirname(fileURLToPath(import.meta.url)), "SKILL.md");

test("OC orchestrating-delivery skill: no retired shell marker CLI or manual checkpoints", () => {
  const text = readFileSync(skill, "utf8");
  assert.equal(
    /mark-gate\.mjs/.test(text),
    false,
    "retired shell marker path must not remain in active prose",
  );
  for (const command of ["spec-adversaried", "final-review-done"]) {
    assert.equal(text.includes(command), false, `retired manual checkpoint remains: ${command}`);
  }
  assert.match(text, /task-executing/, "structural hand observation must remain documented");
});
