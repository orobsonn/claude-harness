/**
 * @description Prevents the adversary from turning unsupported rare chains into
 * mandatory architecture while preserving concrete contract and safety failures.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const agentsDir = dirname(fileURLToPath(import.meta.url));
const opencodeRoot = join(agentsDir, "..");
const adversary = readFileSync(join(agentsDir, "adversary.md"), "utf8");
const orchestrator = readFileSync(
  join(opencodeRoot, "skills", "orchestrating-delivery", "SKILL.md"),
  "utf8",
);

test("upfront adversary: qualifies blockers by contract, concrete harm, or a concrete safety path", () => {
  assert.match(adversary, /not theoretical robustness/i);
  assert.match(adversary, /acceptance criterion|external contract|normal supported flow/i);
  assert.match(adversary, /security|privacy|irreversible/i);
  assert.match(adversary, /actor.*asset.*exploit path/i);
});

test("upfront adversary: records unsupported rare chains instead of mining them into scope", () => {
  assert.match(adversary, /rare concurrence|chained failures|unsupported states/i);
  assert.match(adversary, /separate opportunity/i);
  assert.match(adversary, /variations of the same hypothetical/i);
});

test("orchestrator: rejects architecture expansion for non-qualifying hardening", () => {
  assert.match(orchestrator, /state machine|persistence|retries|middleware|cross-boundary context/i);
  assert.match(orchestrator, /separate opportunity/i);
  assert.match(orchestrator, /acceptance criterion|external contract|concrete evidence|irreversible/i);
});
