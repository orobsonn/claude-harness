/** @description Locked tests for merge-findings (T4). Policy B: keep unless explicit refute. Never throw. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyFindings, finalizeFindings, dedupKey, PLAN_REVIEW_DEDUP_FIELDS } from "./merge-findings.mjs";

function planFinding(over = {}) {
  return {
    area: "race",
    severity: "high",
    task_id: "task-1",
    problem: "race no lock",
    planner_instruction: "add mutex",
    ...over,
  };
}

test("t4-keep-a: only-A finding kept after finalizeFindings", () => {
  const onlyA = [{ id: "f1", title: "only in A", severity: "high" }];
  const classified = classifyFindings(onlyA, []);
  const res = finalizeFindings(classified);
  assert.equal(res.policy, "B");
  assert.equal(res.findings.length, 1);
  assert.equal(res.findings[0].id, "f1");
  assert.equal(res.dropped.length, 0);
});

test("t4-refute: B refutes matching A.id drops or marks A refuted", () => {
  const onlyA = [{ id: "f1", title: "to be refuted", severity: "medium", family: "primary" }];
  const onlyB = [
    {
      id: "refuter",
      title: "refute",
      refutes: { target_id: "f1", target_family: "primary", reason: "explicit refute" },
    },
  ];
  const classified = classifyFindings(onlyA, onlyB);
  const res = finalizeFindings(classified);
  assert.equal(res.policy, "B");
  // A should be dropped (not in findings)
  assert.equal(res.findings.length, 1); // only the refuter remains
  assert.ok(res.dropped.some((d) => d.id === "f1" && d.refuted === true));
});

test("t4-free-text: free-text disagreement without refutes keeps A", () => {
  const onlyA = [{ title: "foo issue here", severity: "low" }];
  const onlyB = [{ title: "completely different bar", severity: "low" }];
  const classified = classifyFindings(onlyA, onlyB);
  const res = finalizeFindings(classified);
  assert.equal(res.policy, "B");
  // both kept since different keys and no refutes
  assert.equal(res.findings.length, 2);
  assert.ok(res.findings.some((f) => f.title.includes("foo")));
  assert.equal(res.dropped.length, 0);
});

// #531 — plan-review findings (closed schema: area, severity, task_id, problem,
// planner_instruction — no id/title/description) must not dedup on severity alone.

test("ac-1.1: plan-review findings with same severity but distinct task_id/area/problem are not merged", () => {
  const A = [planFinding({ task_id: "t1", area: "race", problem: "race no lock" })];
  const B = [planFinding({ task_id: "t9", area: "perf", problem: "N+1 query" })];
  const classified = classifyFindings(A, B, { a: "primary", b: "secondary" }, PLAN_REVIEW_DEDUP_FIELDS);
  assert.equal(classified.both.length, 0);
  assert.equal(classified.onlyA.length, 1);
  assert.equal(classified.onlyB.length, 1);
});

test("ac-1.2: plan-review findings describing the same defect (same task_id + problem) unify into one `both` entry", () => {
  const A = [planFinding({ task_id: "t1", area: "race", problem: "race no lock" })];
  const B = [planFinding({ task_id: "t1", area: "race", problem: "race no lock" })];
  const classified = classifyFindings(A, B, { a: "primary", b: "secondary" }, PLAN_REVIEW_DEDUP_FIELDS);
  assert.equal(classified.both.length, 1);
  assert.equal(classified.onlyA.length, 0);
  assert.equal(classified.onlyB.length, 0);
});

test("ac-1.3: no plan-review finding disappears from the merge — both+onlyA+onlyB covers every distinct input", () => {
  const A = [
    planFinding({ task_id: "t1", area: "race", problem: "race no lock" }),
    planFinding({ task_id: "t2", area: "scope", problem: "scope creep" }),
  ];
  const B = [
    planFinding({ task_id: "t1", area: "race", problem: "race no lock" }), // same defect as A[0]
    planFinding({ task_id: "t9", area: "perf", problem: "N+1 query" }), // distinct
  ];
  const classified = classifyFindings(A, B, { a: "primary", b: "secondary" }, PLAN_REVIEW_DEDUP_FIELDS);
  const total = classified.both.length + classified.onlyA.length + classified.onlyB.length;
  // 3 distinct defects: (t1/race/race no lock), (t2/scope/scope creep), (t9/perf/N+1 query)
  assert.equal(total, 3);
  assert.equal(classified.both.length, 1);
  assert.equal(classified.onlyA.length, 1);
  assert.equal(classified.onlyB.length, 1);
});

test("ac-1.4: non-plan-review findings (adversary/compliance shape, id/title present) keep identical behavior without the fields override", () => {
  const A = [{ id: "f1", title: "only in A", severity: "high" }];
  const B = [{ id: "f2", title: "only in B", severity: "high" }];
  // No `fields` override passed — same call shape as before this fix.
  const classified = classifyFindings(A, B);
  assert.equal(classified.both.length, 0);
  assert.equal(classified.onlyA.length, 1);
  assert.equal(classified.onlyB.length, 1);

  // dedupKey itself: an explicit fields override that yields no usable identity
  // still falls back to id, never to severity alone.
  assert.equal(dedupKey({ id: "f1", severity: "high" }, ["missing_field"]), "id:f1");
  // And with no override at all, behavior is untouched (id wins).
  assert.equal(dedupKey({ id: "f1", severity: "high" }), "id:f1");
});

// #549 — the guard must hold on its own: a multi-field override that degenerates at runtime
// (fewer than 2 non-empty parts) must never fall through to a severity-only key. These call
// dedupKey directly, bypassing validatePlanReviewFinding, to prove the guard is self-standing.

test("ac-1.2 (#549): multi-field override with only one field filled never yields a severity-only key", () => {
  const degenerate = {
    task_id: "",
    problem: "",
    area: "race",
    severity: "high",
    planner_instruction: "add mutex",
  };
  const key = dedupKey(degenerate, PLAN_REVIEW_DEDUP_FIELDS);
  assert.notEqual(key, "|high|");
  assert.ok(!/^\|[a-z]*\|$/.test(key), `key collapsed to severity-only: ${key}`);
  assert.ok(key.includes("race"), `key lost the only identity available: ${key}`);
});

test("ac-1.1 (#549): two distinct degenerate plan-review findings of equal severity keep distinct keys", () => {
  const a = { task_id: "", problem: "", area: "race", severity: "high", planner_instruction: "add mutex" };
  const b = { task_id: "", problem: "", area: "perf", severity: "high", planner_instruction: "batch queries" };
  assert.notEqual(dedupKey(a, PLAN_REVIEW_DEDUP_FIELDS), dedupKey(b, PLAN_REVIEW_DEDUP_FIELDS));

  // ...and identical degenerate findings still unify (dedup keeps working on the safe path).
  const bTwin = { ...b };
  assert.equal(dedupKey(b, PLAN_REVIEW_DEDUP_FIELDS), dedupKey(bTwin, PLAN_REVIEW_DEDUP_FIELDS));
});

test("ac-1.1 (#549): degenerate multi-field override still prefers a stable id when present", () => {
  assert.equal(dedupKey({ id: "f7", area: "race", severity: "high" }, PLAN_REVIEW_DEDUP_FIELDS), "id:f7");
});

test("ac-1.1 (#549): classifyFindings does not merge distinct degenerate findings of equal severity", () => {
  const A = [{ task_id: "", problem: "", area: "race", severity: "high", planner_instruction: "add mutex" }];
  const B = [{ task_id: "", problem: "", area: "perf", severity: "high", planner_instruction: "batch queries" }];
  const classified = classifyFindings(A, B, { a: "primary", b: "secondary" }, PLAN_REVIEW_DEDUP_FIELDS);
  assert.equal(classified.both.length, 0);
  assert.equal(classified.onlyA.length, 1);
  assert.equal(classified.onlyB.length, 1);
});

test("ac-1.1 (#549): a finding whose only content is nested (refutes vehicle) still gets a distinct key", () => {
  const rv1 = { severity: "high", refutes: { target_id: "f1", target_family: "primary", reason: "FP A" } };
  const rv2 = { severity: "high", refutes: { target_id: "f2", target_family: "primary", reason: "FP B" } };
  assert.notEqual(dedupKey(rv1), dedupKey(rv2));
  assert.ok(!dedupKey(rv1).endsWith(":|high"), `nested-only finding read as contentless: ${dedupKey(rv1)}`);
  // Same nested content still unifies — dedup keeps working, it just stopped over-merging.
  assert.equal(dedupKey(rv1), dedupKey({ severity: "high", refutes: { reason: "FP A", target_family: "primary", target_id: "f1" } }));
});

test("ac-1.1 (#549): dedupKey never throws — cyclic and throwing-getter findings still produce a key", () => {
  const cyclic = { severity: "high", area: "race", meta: {} };
  cyclic.meta.self = cyclic.meta;
  assert.equal(typeof dedupKey(cyclic, PLAN_REVIEW_DEDUP_FIELDS), "string");

  const hostile = { severity: "high", area: "race" };
  Object.defineProperty(hostile, "problem", { enumerable: true, get() { throw new Error("boom"); } });
  const key = dedupKey(hostile, PLAN_REVIEW_DEDUP_FIELDS);
  assert.ok(key.includes("race"), `hostile finding lost its identity: ${key}`);

  // Hazards nested one level down — JSON-hostile values and a throwing getter inside an object.
  assert.equal(typeof dedupKey({ severity: "high", meta: { n: 1n } }), "string");
  const nestedHostile = { severity: "high", meta: {} };
  Object.defineProperty(nestedHostile.meta, "x", { enumerable: true, get() { throw new Error("boom"); } });
  assert.equal(typeof dedupKey(nestedHostile), "string");

  // A BigInt still carries identity — it must not silently erase the field it lives in.
  assert.notEqual(dedupKey({ severity: "high", meta: { n: 1n } }), dedupKey({ severity: "high", meta: { n: 2n } }));
});

test("ac-1.1 (#549): the `family` label injected by classifyFindings does not block cross-family unification", () => {
  const shared = { task_id: "", problem: "", area: "race", severity: "high", planner_instruction: "add mutex" };
  const classified = classifyFindings([{ ...shared }], [{ ...shared }], { a: "primary", b: "secondary" }, PLAN_REVIEW_DEDUP_FIELDS);
  assert.equal(classified.both.length, 1);
  assert.equal(classified.onlyA.length, 0);
  assert.equal(classified.onlyB.length, 0);
});
