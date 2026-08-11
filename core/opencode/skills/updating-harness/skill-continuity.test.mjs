/**
 * @description Locks the lifecycle lane's turn-continuity contract: command results are internal
 * progress, so an OpenCode session must not end on a status sentence before the prescribed ship.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const skill = readFileSync(join(here, "SKILL.md"), "utf8");

test("updating-harness — lifecycle command results do not end the active turn", () => {
  assert.match(skill, /lifecycle command results are internal progress/i);
  assert.match(skill, /do not send an\s+intermediate textual response/i);
  assert.match(skill, /same active turn/i);
  assert.match(skill, /next prescribed command/i);
});

test("updating-harness — only a final lifecycle result or formal block may answer the operator", () => {
  assert.match(skill, /only send an operator-facing response after/i);
  assert.match(skill, /merged|noop/i);
  assert.match(skill, /formal block/i);
});

test("updating-harness — an OpenCode-only project does not treat an absent Claude shell as an error", () => {
  assert.match(skill, /never use `read` to probe an absent optional shell/i);
  assert.match(skill, /absent Claude marker means `opencode`/i);
});

test("updating-harness — one isolated command lands the tag requested by this invocation", () => {
  assert.match(skill, /resolve the latest release tag\s+\*\*once\*\*/i);
  assert.match(skill, /claude-harness lifecycle-update --target <resolved-runtime> --ref <latest-tag>/i);
  assert.match(skill, /clean clone.*origin\/main/i);
  assert.match(skill, /does not modify the\s+invoking checkout/i);
  assert.doesNotMatch(skill, /lifecycle-snapshot updating-harness/i);
  assert.doesNotMatch(skill, /`adopt`/i);
});
