/** @description Guards the removal of OpenCode-only count, retry, and review-engine modules. */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const retiredPaths = [
  "core/opencode/plugin/lib/loop-decide.mjs",
  "core/opencode/plugin/lib/plan-and-loop-decide.test.mjs",
  "core/opencode/plugin/review-guard.ts",
  "core/opencode/plugin/lib/review-accounting.test.mjs",
  "core/opencode/plugin/lib/adversary-nudge.mjs",
  "core/opencode/plugin/lib/adversary-nudge.test.mjs",
  "core/opencode/plugin/lib/revise-nudge.mjs",
  "core/opencode/plugin/lib/revise-nudge.test.mjs",
  "core/opencode/plugin/lib/review-restart.mjs",
  "core/opencode/skills/orchestrating-delivery/skill-plan-review-budget.test.mjs",
  "core/opencode/skills/orchestrating-delivery/skill-primary-failure-cap.test.mjs",
  "core/__tests__/skills-alignment.test.mjs",
  "core/shared/lib/agent-retry.mjs",
  "core/shared/lib/agent-retry.test.mjs",
  "core/shared/lib/agent-retry-call.mjs",
  "core/shared/lib/agent-retry-call.test.mjs",
];

test("OC-only count/retry/review engine paths stay absent", () => {
  for (const relativePath of retiredPaths) {
    assert.equal(existsSync(join(repositoryRoot, relativePath)), false, `retired engine path remains: ${relativePath}`);
  }
});

test("identity-based planner lifecycle carries no runtime review or retry counters", () => {
  for (const relativePath of [
    "core/opencode/lib/planner-state.mjs",
    "core/opencode/lib/planner-artifact.mjs",
    "core/opencode/plugin/lib/planner-brief.mjs",
    "core/opencode/plugin/planner-recovery.ts",
  ]) {
    const source = readFileSync(join(repositoryRoot, relativePath), "utf8");
    for (const rail of [
      "plan_review_count",
      "adversary_loop_count",
      "primary_failure_streak",
      "planner_primary_attempts",
      "planner_attempts_round",
      "planner_retry_outcome",
      "delivery-blocked",
      "agent_dispatch_failures",
      "agent_dispatch_outcomes",
      "gate_blocked_dispatches",
    ]) {
      assert.equal(source.includes(rail), false, `${relativePath} still contains runtime rail ${rail}`);
    }
  }
});

function liveSourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "fixtures" || entry.name === "docs" ? [] : liveSourceFiles(file);
    }
    return /\.(?:mjs|ts|md)$/.test(entry.name) && !entry.name.includes(".test.") ? [file] : [];
  });
}

test("live OC sources have zero consumers of retired review-engine vocabulary", () => {
  const roots = ["core/opencode", "core/shared", "core/vps", "scripts"];
  const retiredVocabulary = [
    "review-guard",
    "loop-decide",
    "adversary-nudge",
    "revise-nudge",
    "review-restart",
    "agent-retry",
    "plan_review_count",
    "adversary_loop_count",
    "primary_failure_streak",
    "primary_failure_cap_reached",
    "delivery-blocked",
    "agent_dispatch_failures",
    "agent_dispatch_outcomes",
    "gate_blocked_dispatches",
    "planner_failure_class",
    "planner_fallback_attempts",
    "planner_fallback_result",
    "planner_fallback_diagnostic",
  ];
  for (const root of roots) {
    for (const file of liveSourceFiles(join(repositoryRoot, root))) {
      const source = readFileSync(file, "utf8");
      for (const term of retiredVocabulary) {
        assert.equal(source.includes(term), false, `live source retains ${term}: ${file}`);
      }
    }
  }
});
