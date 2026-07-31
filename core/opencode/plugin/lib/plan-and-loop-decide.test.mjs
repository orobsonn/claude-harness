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

test("plan-decide rejects stub, empty, and missing full plans", () => {
  const stub = decidePlanGate({ plan: { kind: "stub", mode: "LIGHT", feature_id: "feat-a", tasks: [] }, expect: "full" });
  assert.equal(stub.decision, "deny");
  assert.throws(() => throwIfPlanDenied(stub), /\[plan-gate\]/);
  assert.equal(decidePlanGate({ plan: { kind: "full", mode: "light", feature_id: "feat-a", tasks: [] }, expect: "full" }).decision, "deny");
  assert.equal(decidePlanGate({ plan: null, expect: "full" }).decision, "deny");
});

test("loop-decide applies role-specific counters and thresholds", () => {
  assert.deepEqual(nextLoopCount({ adversary_loop_count: 2 }, "adversary"), { key: "adversary_loop_count", next: 3 });
  assert.deepEqual(nextLoopCount({ plan_review_count: 2 }, "plan-reviewer"), { key: "plan_review_count", next: 3 });
  assert.equal(loopCounterKey("adversary-family-2"), null);
  assert.equal(decideLoopGuard({ subagentType: "plan-reviewer", count: 2 }).decision, "warn");
  const denied = decideLoopGuard({ subagentType: "plan-reviewer", count: LOOP_THRESHOLDS.plan_review.deny });
  assert.equal(denied.decision, "deny");
  assert.throws(() => throwIfLoopDenied(denied), /\[loop-guard\]/);
  assert.equal(decideLoopGuard({ subagentType: "adversary", count: LOOP_THRESHOLDS.adversary.deny }).decision, "warn");
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
