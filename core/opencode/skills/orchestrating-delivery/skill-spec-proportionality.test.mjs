/** @description Locks the bounded spec-adversary contract for OpenCode delivery. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const skill = readFileSync(join(here, "SKILL.md"), "utf8");

test("spec adversary re-attack is bounded to prior findings and direct consequences", () => {
  assert.match(skill, /re-attack[\s\S]{0,240}prior material findings[\s\S]{0,240}direct consequences/i);
  assert.match(skill, /rare hypothesis[\s\S]{0,180}open risk/i);
});
