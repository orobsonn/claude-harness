/** @description Locked tests for merge-findings (T4). Policy B: keep unless explicit refute. Never throw. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyFindings, finalizeFindings } from "./merge-findings.mjs";

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
