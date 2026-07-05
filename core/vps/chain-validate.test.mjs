/**
 * @description Contract tests for chain-validate.mjs — the roadmap DAG linter that catches the two
 * authoring mistakes the runtime cannot self-heal from: dependency cycles and dangling references.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { validateRoadmap, buildRoadmapGraph, formatReport, runValidate } from "./chain-validate.mjs";

test("validateRoadmap: a clean linear roadmap reports no cycles and no dangling", () => {
  const report = validateRoadmap([
    { number: 1, deps: [] },
    { number: 2, deps: [1] },
    { number: 3, deps: [2] },
  ]);
  assert.deepEqual(report.cycles, []);
  assert.deepEqual(report.dangling, []);
});

test("validateRoadmap: a clean diamond reports no cycles", () => {
  const report = validateRoadmap([
    { number: 1, deps: [] },
    { number: 2, deps: [1] },
    { number: 3, deps: [1] },
    { number: 4, deps: [2, 3] },
  ]);
  assert.deepEqual(report.cycles, []);
  assert.deepEqual(report.dangling, []);
});

test("validateRoadmap: detects a 2-node cycle", () => {
  const report = validateRoadmap([
    { number: 1, deps: [2] },
    { number: 2, deps: [1] },
  ]);
  assert.equal(report.cycles.length, 1, "one cycle");
  assert.deepEqual([...report.cycles[0]].sort((a, b) => a - b), [1, 2]);
});

test("validateRoadmap: detects a 3-node cycle and reports it once (not once per entry point)", () => {
  const report = validateRoadmap([
    { number: 1, deps: [2] },
    { number: 2, deps: [3] },
    { number: 3, deps: [1] },
  ]);
  assert.equal(report.cycles.length, 1, "the same cycle must be reported exactly once");
  assert.deepEqual([...report.cycles[0]].sort((a, b) => a - b), [1, 2, 3]);
});

test("validateRoadmap: flags a dangling dependency (#9999 not among known issues)", () => {
  const report = validateRoadmap([
    { number: 1, deps: [] },
    { number: 2, deps: [1, 9999] },
  ]);
  assert.deepEqual(report.cycles, []);
  assert.deepEqual(report.dangling, [{ issue: 2, missing: [9999] }]);
});

test("validateRoadmap: a dangling edge is NOT mistaken for a cycle", () => {
  const report = validateRoadmap([{ number: 5, deps: [5] }]); // self-dep to self is a cycle...
  assert.equal(report.cycles.length, 1, "a self-dependency IS a 1-node cycle");
  const report2 = validateRoadmap([{ number: 5, deps: [42] }]); // ...but a dangling self-ref is not
  assert.deepEqual(report2.cycles, []);
  assert.deepEqual(report2.dangling, [{ issue: 5, missing: [42] }]);
});

test("buildRoadmapGraph: parses each open issue's harness-deps block into {number, deps}", () => {
  const gh = (args) => {
    if (args[0] === "issue" && args[1] === "list") {
      return [
        { number: 1, body: "no deps" },
        { number: 2, body: "```harness-deps\n#1\n```" },
      ];
    }
    return [];
  };
  const graph = buildRoadmapGraph(gh);
  assert.deepEqual(graph, [
    { number: 1, deps: [] },
    { number: 2, deps: [1] },
  ]);
});

test("formatReport: clean roadmap yields a single OK line", () => {
  assert.match(formatReport({ cycles: [], dangling: [] }), /OK/);
});

test("formatReport: names the members of a cycle and the dangling refs", () => {
  const text = formatReport({ cycles: [[1, 2]], dangling: [{ issue: 3, missing: [9999] }] });
  assert.match(text, /CICLO.*#1.*#2/s);
  assert.match(text, /INEXISTENTE.*#3.*#9999/s);
});

test("runValidate: returns ok:false and logs the report when the roadmap has a cycle", () => {
  const gh = (args) => {
    if (args[0] === "issue" && args[1] === "list") {
      return [
        { number: 1, body: "```harness-deps\n#2\n```" },
        { number: 2, body: "```harness-deps\n#1\n```" },
      ];
    }
    return [];
  };
  const logs = [];
  const result = runValidate({ owner: "acme", repo: "demo" }, { gh, log: (m) => logs.push(m) });
  assert.equal(result.ok, false, "a cyclic roadmap must fail validation");
  assert.equal(result.report.cycles.length, 1);
  assert.ok(logs.some((l) => /CICLO/.test(l)), "the report must be logged");
});

test("runValidate: returns ok:true for a clean roadmap", () => {
  const gh = (args) => {
    if (args[0] === "issue" && args[1] === "list") {
      return [
        { number: 1, body: "" },
        { number: 2, body: "```harness-deps\n#1\n```" },
      ];
    }
    return [];
  };
  const result = runValidate({ owner: "acme", repo: "demo" }, { gh, log: () => {} });
  assert.equal(result.ok, true);
});
