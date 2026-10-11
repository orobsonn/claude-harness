import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isSensitiveTaskScope,
  laneBashDenyReason,
  laneDispatchRoutes,
  laneFrozenPaths,
  laneTaskScope,
  laneWriteDenyReason,
  parseEyeVerdict,
  parseHandStatus,
  parseMarkCommand,
  parseTaskDispatchMarker,
  pathInScope,
  routeAllows,
} from "./task-lane-contract.mjs";

const plan = {
  model_strategy: {
    hand_tiers: { low: "haiku", medium: "sonnet", high: "sonnet" },
    compliance: "sonnet", security: "opus", adversary: "opus",
  },
};
const task = {
  id: "task-a", severity: "medium", complexity: "low", scope_paths: ["src/a"],
  locked_tests: [{ test_path: "test/a.test.mjs", assertion: "G/W/T", fixture_paths: ["test/fx/a.json"] }],
  adversarial: { enabled: true },
};
const identity = { featureId: "demo", taskId: "task-a", parentRoot: "/srv/parent" };
const marker = (taskId = "task-a") => `[HARNESS_TASK_CONTEXT]{"task_id":"${taskId}"}[/HARNESS_TASK_CONTEXT]\nDo it.`;

test("dispatch markers: exactly one exact context, fidelity and final-review flags", () => {
  assert.deepEqual(parseTaskDispatchMarker(marker()), { ok: true, taskId: "task-a", fidelity: false, finalReview: false });
  assert.equal(parseTaskDispatchMarker(`[HARNESS_TASK_FIDELITY]\n${marker()}`).fidelity, true);
  assert.equal(parseTaskDispatchMarker(`${marker()}\n[HARNESS_FINAL_REVIEW]`).finalReview, true);
  assert.equal(parseTaskDispatchMarker("no marker").ok, false);
  assert.equal(parseTaskDispatchMarker(`${marker()}${marker("task-b")}`).ok, false);
  assert.equal(parseTaskDispatchMarker('[HARNESS_TASK_CONTEXT]{"task_id":"task-a","x":1}[/HARNESS_TASK_CONTEXT]').ok, false);
  assert.equal(parseTaskDispatchMarker("[HARNESS_TASK_CONTEXT]task-a[/HARNESS_TASK_CONTEXT]").ok, false);
  assert.equal(parseTaskDispatchMarker(marker("task-b")).taskId, "task-b");
});

test("routes are literal from the frozen plan and the claude ladder", () => {
  const routes = laneDispatchRoutes(plan, task);
  assert.deepEqual(routes.executor, { agent: "executor", model: "haiku", tier: "low" });
  assert.equal(routes.adversary.model, "sonnet");
  assert.equal(routes.adversary.required, true);
  assert.equal(routes.security.required, false);
  assert.deepEqual(routes.sniper.rungs.map((rung) => `${rung.agent}:${rung.model}`), ["sniper:haiku", "sniper:sonnet", "sniper-high:sonnet"]);
  const high = laneDispatchRoutes(plan, { ...task, complexity: "high", severity: "high", scope_paths: ["src/auth/login.ts"] });
  assert.deepEqual(high.executor, { agent: "executor-high", model: "sonnet", tier: "high" });
  assert.equal(high.adversary.model, "opus");
  assert.equal(high.security.required, true);
  assert.throws(() => laneDispatchRoutes({ model_strategy: { ...plan.model_strategy, hand_tiers: { low: "gemma4", medium: "glm-5.2", high: "kimi-k2.7-code" } } }, task), /claude hand family/);
  assert.equal(routeAllows(routes, "executor", "haiku"), true);
  assert.equal(routeAllows(routes, "executor", "sonnet"), false);
  assert.equal(routeAllows(routes, "executor-high", "sonnet"), false);
  assert.equal(routeAllows(routes, "sniper-high", "sonnet"), true);
  assert.equal(routeAllows(routes, "sniper", "opus"), false);
  assert.equal(routeAllows(routes, "compliance", "sonnet"), true);
  assert.equal(routeAllows(routes, "compliance", undefined), false, "model must be explicit");
  assert.equal(routeAllows(routes, "planner", "opus"), false);
});

test("scope helpers compare components and know the frozen set", () => {
  assert.deepEqual(laneTaskScope(task), ["src/a", "test/a.test.mjs", "test/fx/a.json"]);
  assert.deepEqual(laneFrozenPaths(task), ["test/a.test.mjs", "test/fx/a.json"]);
  assert.deepEqual(laneFrozenPaths({ ...task, no_tests: true, locked_tests: [] }), []);
  assert.equal(pathInScope("src/a/x.mjs", ["src/a"]), true);
  assert.equal(pathInScope("src/ab.mjs", ["src/a"]), false);
  assert.equal(pathInScope("./src/a", ["src/a"]), true);
  assert.equal(pathInScope("anything", [""]), true);
  assert.equal(isSensitiveTaskScope(["src/billing/x.ts"]), true);
  assert.equal(isSensitiveTaskScope(["db/0001.sql"]), true);
  assert.equal(isSensitiveTaskScope(["src/authority/x.ts"]), false);
});

test("lane Bash denies coordination, delivery, integration, amend and harness access", () => {
  for (const command of [
    "node .claude/hooks/tasks.mjs status",
    "node .claude/hooks/classify.mjs --mode FULL",
    "git push origin HEAD",
    "git pull",
    "git fetch origin",
    "git merge main",
    "git rebase main",
    "git tag v1",
    "git cherry-pick abc",
    "git worktree add ../x",
    "git switch main",
    "git checkout main",
    "git checkout -b other",
    "git -C /srv/parent status",
    "git -c core.hooksPath=/dev/null commit -m x",
    "git commit --amend --no-edit",
    "git add -A && git commit --amend -m x",
    "git merge-base A B && git merge X",
    "git merge-base A B; git push",
    "gh pr create --fill",
    "gh pr merge 1",
    "gh issue create -t x",
    "gh api repos/x/y/pulls",
    "npm run deploy",
    "pnpm deploy",
    "npx wrangler deploy",
    "node .claude/skills/orchestrating-delivery/references/spawn-hand.mjs --descriptor d.json",
    "cat .claude/plans/.state/x/gate-state.json",
    "rm .claude/plans/.state/task-admission/a.json.claim",
    "ls /srv/parent/.claude",
    "sed -i s/deny/allow/ .claude/hooks/task-gate.mjs",
    "cp evil.json .claude/settings.json",
    "echo x > .claude/plans/demo/execution-plan.json",
    "cat .claude/plans/other/run/x",
  ]) {
    assert.ok(laneBashDenyReason(command, identity), command);
  }
});

test("lane Bash allows ordinary work, isolated merge-base and own markers only", () => {
  for (const command of [
    "git status --porcelain",
    "git diff HEAD~1",
    "git add src/a/x.mjs && git commit -m 'feat(a): x'",
    "git commit -m 'test(a): freeze locked tests for task-a'",
    "git merge-base --is-ancestor abc123 HEAD",
    "git checkout -- src/a/x.mjs",
    "git restore --staged -- src/a/x.mjs",
    "node --test test/a.test.mjs",
    "git diff > .claude/plans/demo/run/diff.txt",
    "npm test",
    "node .claude/hooks/mark.mjs fidelity-pass --feature-id demo --task-id task-a",
    "node .claude/hooks/mark.mjs capture-verified --feature-id demo --task-id task-a",
    "node .claude/hooks/mark.mjs active-scope --feature-id demo --task-id task-a --role executor --scope-paths src/a",
  ]) {
    assert.equal(laneBashDenyReason(command, identity), null, command);
  }
  assert.match(laneBashDenyReason("node .claude/hooks/mark.mjs fidelity-pass --feature-id demo --task-id task-b", identity), /own feature and task/);
  assert.match(laneBashDenyReason("node .claude/hooks/mark.mjs final-review-done --feature-id demo", identity), /global parent/);
  assert.match(laneBashDenyReason("node .claude/hooks/mark.mjs regate-passed --feature-id demo --task-id task-a > /dev/null", identity), /alone/);
  assert.match(laneBashDenyReason("node .claude/hooks/mark.mjs capture-verified --feature-id demo --task-id task-a --sha abc", identity), /no --sha/);
  assert.deepEqual(parseMarkCommand("node .claude/hooks/mark.mjs hand-finished --feature-id demo --task-id task-a"),
    { action: "hand-finished", flags: { "feature-id": "demo", "task-id": "task-a" } });
});

test("write policy: orchestrator only run buffers, hands only their authorized paths", () => {
  const ctx = (role) => ({ role, task, featureId: "demo" });
  assert.equal(laneWriteDenyReason(".claude/plans/demo/run/shared_context.md", ctx(null)), null);
  assert.ok(laneWriteDenyReason("src/a/x.mjs", ctx(null)));
  assert.ok(laneWriteDenyReason(".claude/plans/demo/execution-plan.json", ctx(null)));
  assert.equal(laneWriteDenyReason("test/a.test.mjs", ctx("test-author")), null);
  assert.equal(laneWriteDenyReason("test/fx/a.json", ctx("test-author")), null);
  assert.ok(laneWriteDenyReason("src/a/x.mjs", ctx("test-author")));
  assert.equal(laneWriteDenyReason("src/a/x.mjs", ctx("executor")), null);
  assert.ok(laneWriteDenyReason("src/b/x.mjs", ctx("sniper-high")));
  assert.ok(laneWriteDenyReason(".claude/hooks/mark.mjs", ctx("executor")));
  assert.ok(laneWriteDenyReason("src/a/x.mjs", ctx("compliance")));
  assert.ok(laneWriteDenyReason(null, ctx("executor")));
});

test("verdict parsers read the agents' canonical blocks", () => {
  assert.deepEqual(parseEyeVerdict("compliance", "...\n## Veredito: pass\n"), { verdict: "pass", positive: true });
  assert.equal(parseEyeVerdict("compliance", "## Veredito: partial").positive, false);
  assert.equal(parseEyeVerdict("compliance", "nothing"), null);
  const adv = (issues) => `\`\`\`json\n${JSON.stringify({ issues })}\n\`\`\``;
  assert.equal(parseEyeVerdict("adversary", adv([])).positive, true);
  assert.equal(parseEyeVerdict("adversary", adv([{ severity: "low", description: "ARMED · x" }])).positive, true);
  assert.equal(parseEyeVerdict("adversary", adv([{ severity: "high", description: "ARMED · x" }])).positive, false);
  assert.equal(parseEyeVerdict("adversary", adv([{ severity: "medium", description: "UNARMED · x" }])).positive, true);
  assert.equal(parseEyeVerdict("adversary", "no json"), null);
  const sec = (verdict) => `\`\`\`json\n${JSON.stringify({ verdict, issues: [] })}\n\`\`\``;
  assert.equal(parseEyeVerdict("security", sec("SECURE")).positive, true);
  assert.equal(parseEyeVerdict("security", sec("UNSAFE")).positive, false);
  assert.equal(parseHandStatus("## Status: DONE\n### Arquivos"), "DONE");
  assert.equal(parseHandStatus("Status: BLOCKED"), "BLOCKED");
  assert.equal(parseHandStatus("## Status: DONE_WITH_CONCERNS"), "DONE_WITH_CONCERNS");
  assert.equal(parseHandStatus("done!"), null);
});
