/** @description Plugin-side contracts formerly coupled to the moved gate-state test. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { decidePlanGate, throwIfPlanDenied } from "./plan-decide.mjs";
import { LOOP_THRESHOLDS, decideLoopGuard, loopCounterKey, nextLoopCount, throwIfLoopDenied } from "./loop-decide.mjs";
import { readGateState, withGateStateLock, writeGateStateAtomic } from "../../lib/gate-state.mjs";
import { mergeGateStatePatch } from "../../../shared/lib/gate-state-shape.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @param {(dir: string, statePath: string) => void | Promise<void>} fn */
async function withTempState(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t5-gate-"));
  const statePath = path.join(dir, "plans", ".state", "ses_test", "gate-state.json");
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  try {
    await fn(dir, statePath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("t5-plan-full: plan-gate denies stub kind or empty tasks with expect full", () => {
  const stub = decidePlanGate({ plan: { kind: "stub", mode: "LIGHT", feature_id: "feat-a", tasks: [] }, expect: "full" });
  assert.equal(stub.decision, "deny");
  assert.match(stub.reason, /\[plan-gate\]/);
  assert.throws(() => throwIfPlanDenied(stub), /\[plan-gate\]/);

  const empty = decidePlanGate({ plan: { kind: "full", mode: "light", feature_id: "feat-a", tasks: [] }, expect: "full" });
  assert.equal(empty.decision, "deny");
  assert.match(empty.reason, /\[plan-gate\]/);

  const missing = decidePlanGate({ plan: null, expect: "full" });
  assert.equal(missing.decision, "deny");
});

test("t5-loop-inc: plan-review and adversary loop counters increment in disk gate-state and survive a fresh read/process boundary", async () => {
  await withTempState(async (_dir, statePath) => {
    writeGateStateAtomic(statePath, {
      plan_review_count: 0,
      adversary_loop_count: 0,
    });

    // Increment plan-review
    const r1 = withGateStateLock(statePath, (prev) => {
      const step = nextLoopCount(prev, "plan-reviewer");
      const applied = mergeGateStatePatch(prev, { [step.key]: step.next });
      return applied.state;
    });
    assert.equal(r1.ok, true);
    assert.equal(r1.state.plan_review_count, 1);

    // Increment adversary
    const r2 = withGateStateLock(statePath, (prev) => {
      const step = nextLoopCount(prev, "adversary");
      const applied = mergeGateStatePatch(prev, { [step.key]: step.next });
      return applied.state;
    });
    assert.equal(r2.ok, true);
    assert.equal(r2.state.adversary_loop_count, 1);

    // Fresh read (simulates new process)
    const fresh = readGateState(statePath);
    assert.equal(fresh.plan_review_count, 1);
    assert.equal(fresh.adversary_loop_count, 1);

    // Survive process boundary via child process re-read
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
        import { readGateState } from ${JSON.stringify(path.join(__dirname, "../../lib/gate-state.mjs"))};
        const s = readGateState(${JSON.stringify(statePath)});
        if (s.plan_review_count !== 1 || s.adversary_loop_count !== 1) {
          console.error(JSON.stringify(s));
          process.exit(1);
        }
        `,
      ],
      { encoding: "utf8" },
    );
    assert.equal(child.status, 0, child.stderr || child.stdout);
  });
});

test("t5-loop-thresh: after configured warn threshold emits warn; after deny threshold denies further loop", () => {
  // warn at 2
  const w = decideLoopGuard({ subagentType: "plan-reviewer", count: 2 });
  assert.equal(w.decision, "warn");
  assert.match(w.reason, /\[loop-guard\].*warn/i);

  const wAdv = decideLoopGuard({ subagentType: "adversary", count: 2 });
  assert.equal(wAdv.decision, "warn");

  // deny at each role's configured budget (plan-review and adversary are budgeted separately)
  const d = decideLoopGuard({ subagentType: "plan-reviewer", count: LOOP_THRESHOLDS.plan_review.deny });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /\[loop-guard\].*deny/i);
  assert.throws(() => throwIfLoopDenied(d), /\[loop-guard\]/);

  // one round below the budget is still allowed to run
  assert.notEqual(
    decideLoopGuard({ subagentType: "plan-reviewer", count: LOOP_THRESHOLDS.plan_review.deny - 1 }).decision,
    "deny",
  );

  // Adversary: warn only, never deny — see t5-loop-catalog-counts for why.
  const dAdv = decideLoopGuard({ subagentType: "adversary", count: LOOP_THRESHOLDS.adversary.deny });
  assert.equal(dAdv.decision, "warn");

  // below warn
  const a = decideLoopGuard({ subagentType: "plan-reviewer", count: 1 });
  assert.equal(a.decision, "allow");
});

test("t5-loop-catalog-counts: canonical and alias roles follow catalog countsLoop", () => {
  for (const role of ["adversary-family-1", "adversary"]) {
    assert.equal(loopCounterKey(role), "adversary_loop_count", role);
    assert.deepEqual(nextLoopCount({ adversary_loop_count: 2 }, role), {
      key: "adversary_loop_count",
      next: 3,
    });
  }
  for (const role of ["plan-reviewer-family-1", "plan-reviewer"]) {
    assert.equal(loopCounterKey(role), "plan_review_count", role);
    assert.deepEqual(nextLoopCount({ plan_review_count: 2 }, role), {
      key: "plan_review_count",
      next: 3,
    });
  }
  for (const role of [
    "adversary-family-2",
    "adversary-openai",
    "plan-reviewer-family-2",
    "plan-reviewer-openai",
  ]) {
    assert.equal(loopCounterKey(role), null, role);
    assert.equal(nextLoopCount({}, role), null, role);
  }
  assert.equal(loopCounterKey("adversary-family-99"), null);
  assert.equal(loopCounterKey("plan-reviewer-experimental"), null);
  assert.equal(loopCounterKey("@harness/adversary-family-99"), null);

  // The adversary loop is deliberately NEVER denied deterministically: a hard refusal stranded two
  // live runs (a spec-refinement loop before the planner ran, and one run-wide counter away from
  // doing it mid-implementation). Past the threshold it warns; stopping is the orchestrator's call,
  // driven by the escalation nudge. Only plan_review — where a REVISE forbids every hand — denies.
  const p = decideLoopGuard({ subagentType: "adversary", count: 4 });
  assert.equal(p.decision, "warn");
  assert.equal(decideLoopGuard({ subagentType: "adversary", count: 99 }).decision, "warn");

  // secondary uses the !key then-clause and is allowed regardless of passed count
  for (const role of [
    "adversary-family-2",
    "adversary-openai",
    "plan-reviewer-family-2",
    "plan-reviewer-openai",
  ]) {
    const secondary = decideLoopGuard({ subagentType: role, count: 5 });
    assert.equal(secondary.decision, "allow", role);
    assert.equal(secondary.reason, "not-loop-guarded", role);
  }
});
