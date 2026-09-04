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

test("updating-harness — native tool owns the default all-runtimes selection and does not expose a shell recipe", () => {
  assert.match(skill, /lifecycle-update\(\{\}\)/i);
  assert.match(skill, /Claude Code, OpenCode, Codex and Pi/i);
  assert.doesNotMatch(skill, /test -f \.claude\/\.harness-version/i);
  assert.doesNotMatch(skill, /npx --yes --package=/i);
});

test("updating-harness — one isolated native operation lands the tag and fast-forwards active main", () => {
  assert.match(skill, /native tool exactly once/i);
  assert.match(skill, /resolves the latest release tag once/i);
  assert.match(skill, /clean clone.*origin\/main/i);
  assert.match(skill, /fast-forwards the invoking default-branch checkout/i);
  assert.match(skill, /never switches a feature branch/i);
  assert.doesNotMatch(skill, /lifecycle-snapshot updating-harness/i);
  assert.doesNotMatch(skill, /`adopt`/i);
});

test("updating-harness — merge does not wait for a transient GitHub checks listing", () => {
  assert.match(skill, /requests the merge immediately/i);
  assert.doesNotMatch(skill, /waits for their checks/i);
});
