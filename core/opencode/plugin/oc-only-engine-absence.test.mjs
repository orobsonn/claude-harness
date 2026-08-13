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
  "core/opencode/skills/orchestrating-delivery/skill-regate-stop-predicate.test.mjs",
  "core/opencode/skills/orchestrating-delivery/skill-regate-stagnation-ceiling.test.mjs",
  "core/opencode/skills/orchestrating-delivery/skill-regate-deadlock-escape.test.mjs",
  "core/__tests__/skills-alignment.test.mjs",
  "core/shared/lib/agent-retry.mjs",
  "core/shared/lib/agent-retry.test.mjs",
  "core/shared/lib/agent-retry-call.mjs",
  "core/shared/lib/agent-retry-call.test.mjs",
  "core/opencode/lib/planner-fallback-config.mjs",
  "core/opencode/agents/planner-fallback.md",
];

test("OC-only count/retry/review engine paths stay absent", () => {
  for (const relativePath of retiredPaths) {
    assert.equal(existsSync(join(repositoryRoot, relativePath)), false, `retired engine path remains: ${relativePath}`);
  }
});

test("obsolete OpenCode implementation playbook stays absent and the live operator guide never routes to it", () => {
  const playbook = "docs/opencode-implementation-playbook.md";
  assert.equal(existsSync(join(repositoryRoot, playbook)), false, `obsolete root playbook returned: ${playbook}`);
  const operatorGuide = readFileSync(join(repositoryRoot, "core/opencode/docs/OPERATOR-GUIDE.md"), "utf8");
  assert.equal(operatorGuide.includes(playbook), false, "live operator guide still references the obsolete playbook");
});

test("the retired planner lifecycle stays absent", () => {
  for (const relativePath of [
    "core/opencode/lib/planner-state.mjs",
    "core/opencode/lib/planner-artifact.mjs",
    "core/opencode/plugin/lib/planner-brief.mjs",
    "core/opencode/plugin/planner-recovery.ts",
  ]) {
    assert.equal(existsSync(join(repositoryRoot, relativePath)), false, `retired planner lifecycle returned: ${relativePath}`);
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
    "adversary_nudge",
    "revise-nudge",
    "revise_nudge",
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
    "same-agent K=3",
    "CAP = 3",
    "round counter",
    "retry status",
    "isGrave",
    "CAP escalation",
    "iteration cap",
    "re-gate→sniper cycles",
    "Adversary re-dispatch stop-rule",
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

test("live OC sources retain no planner-fallback role or native resolver consumers", () => {
  for (const root of ["core/opencode", "core/shared", "core/vps"]) {
    for (const file of liveSourceFiles(join(repositoryRoot, root))) {
      const source = readFileSync(file, "utf8");
      assert.equal(source.includes("planner-fallback"), false, `live source retains retired planner fallback: ${file}`);
    }
  }
});
