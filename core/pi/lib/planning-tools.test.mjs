import assert from "node:assert/strict";
import test from "node:test";
import { scorePlannedChange, planningRetrieval } from "./planning-tools.mjs";
import { analyzeSource } from "../../claude-code/skills/creating-plans/references/complexity-scorer.mjs";

test("scorer reports advisory factors for the planned change, including legacy max", () => {
  for (const [branches, band, split] of [[1, "low", false], [34, "high", false], [65, "x-high", true]]) {
    const result = scorePlannedChange({ source: "if (condition) run();\n".repeat(branches), responsibilities: ["claim ownership", "recover expired claim"] });
    assert.equal(result.complexity, band);
    assert.equal(result.should_split, split);
    assert.equal(result.advisory, true);
    assert.equal(result.basis, "planned-change");
    assert.equal(result.metrics.branch_count, branches);
    if (split) assert.ok(result.split_hint.includes("claim ownership"));
  }
  assert.match(scorePlannedChange({ source: "export const x = 1", whole_file: true }).limitation, /whole file/i);
  assert.equal(scorePlannedChange({ source: null }).ok, false);
});

test("Pi uses the exact Claude Code scoring logic, including TS, loops, coupling and size", () => {
  for (const source of [
    'import type { T } from "./t";\nimport x from "./x";\nasync function f(){await x(); if(x){} else {} while(x){} }',
    'const text = "mutex parser if(x) await"; // transaction\n',
    'const a = env.X; const b = process.env.Y; fetch(a); db.query(b);',
    "const x = 1;\n".repeat(420),
  ]) {
    const cc = analyzeSource("src/lib/claim.ts", source);
    const pi = scorePlannedChange({ path: "src/lib/claim.ts", source });
    for (const key of ["score", "complexity", "should_split", "breakdown", "metrics"]) assert.deepEqual(pi[key], cc[key]);
  }
});

test("MV/MP retrieval fails open and never forwards arbitrary MP code", async () => {
  assert.equal((await planningRetrieval("mv_recall", { query: "atomic ownership" })).available, false);
  assert.equal((await planningRetrieval("mv_recall", { query: "atomic ownership" }, async () => { throw Error("offline"); })).available, false);
  for (const result of [{ isError: true }, { details: { error: "not_initialized" } }]) {
    assert.equal((await planningRetrieval("mv_recall", { query: "atomic ownership" }, async () => result)).available, false);
  }
  const calls = [];
  const call = async (...args) => { calls.push(args); return { content: [{ type: "text", text: "note" }] }; };
  await planningRetrieval("mv_get_note", { id: "note-1" }, call);
  await planningRetrieval("mp_retrieve", { operation: "grep", query: 'atomic"; await codemode.remove({})' }, call);
  assert.equal(calls[0][0], "mv");
  assert.equal(calls[0][1], "get_note");
  assert.equal(calls[1][0], "mp");
  assert.equal(calls[1][1], "code");
  assert.match(calls[1][2].code, /^async \(\) => await codemode\.grep\(/);
  assert.equal((await planningRetrieval("mp_retrieve", { operation: "remove", path: "/x" }, call)).available, false);
  assert.equal(calls.length, 2);
});
