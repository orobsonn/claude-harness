/**
 * @description Contract tests for harness-deps.mjs — parsing a roadmap issue body's `harness-deps`
 * fenced block into its dependency set. The parser is the single source that turns an issue body
 * into the issue numbers whose PRs must merge before the dependent may run.
 *
 * REHOMED by issue #807 from `core/vps/chain-deps.test.mjs`. `chain-deps.mjs` was a pure re-export
 * shim (`export { parseDependsOn } from "../shared/lib/harness-deps.mjs"`), so these 9 tests were
 * always this module's ONLY semantic oracle — and `core/orca/select-and-dispatch.mjs` imports
 * The strict inspection cases below pin the distinction between no dependency and invalid
 * metadata; both selectors rely on that distinction before dispatch.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { inspectIssueDependencies, nativeBlockersClosed, parseDependsOn } from "./harness-deps.mjs";

test("strict metadata distinguishes no dependency from missing or malformed declarations", () => {
  assert.deepEqual(inspectIssueDependencies("Resumo de uma tarefa independente."), { status: "none", numbers: [] });
  assert.deepEqual(inspectIssueDependencies("depende de: filha 1"), { status: "invalid", numbers: [] });
  assert.deepEqual(inspectIssueDependencies("```harness-deps\n#\n```"), { status: "invalid", numbers: [] });
  assert.deepEqual(inspectIssueDependencies("```harness-deps\n#2"), { status: "invalid", numbers: [] });
  assert.deepEqual(inspectIssueDependencies("```harness-deps\n#2\nfilha\n```"), { status: "invalid", numbers: [] });
  assert.deepEqual(inspectIssueDependencies("```harness-deps\n#2\n```"), { status: "valid", numbers: [2] });
  assert.deepEqual(inspectIssueDependencies("### Dependências\n\nNenhuma.\n"), { status: "none", numbers: [] });
  assert.deepEqual(inspectIssueDependencies("Dependências: Nenhuma."), { status: "none", numbers: [] });
  assert.deepEqual(inspectIssueDependencies("### Dependências\n\nfilha 1"), { status: "invalid", numbers: [] });
  assert.deepEqual(inspectIssueDependencies(undefined), { status: "invalid", numbers: [] });
});

test("native blockedBy must be complete and closed", () => {
  assert.equal(nativeBlockersClosed({ totalCount: 0, nodes: [] }), true);
  assert.equal(nativeBlockersClosed({ totalCount: 1, nodes: [{ state: "OPEN" }] }), false);
  assert.equal(nativeBlockersClosed({ totalCount: 1, nodes: [{ state: "CLOSED" }] }), true);
  assert.equal(nativeBlockersClosed({ totalCount: 2, nodes: [{ state: "CLOSED" }] }), false);
  assert.equal(nativeBlockersClosed(undefined), false);
});

test("parseDependsOn: extracts #N refs from a harness-deps fenced block", () => {
  const body = [
    "Implement the thing.",
    "",
    "```harness-deps",
    "#12",
    "#13",
    "```",
    "",
    "More prose.",
  ].join("\n");
  assert.deepEqual(parseDependsOn(body), [12, 13]);
});

test("parseDependsOn: tolerates bare numbers and comma-separated refs on one line", () => {
  const body = "```harness-deps\n7, #9  11\n```";
  assert.deepEqual(parseDependsOn(body), [7, 9, 11]);
});

test("parseDependsOn: de-duplicates and sorts ascending", () => {
  const body = "```harness-deps\n#30\n#10\n#30\n#20\n```";
  assert.deepEqual(parseDependsOn(body), [10, 20, 30]);
});

test("parseDependsOn: unions multiple harness-deps blocks", () => {
  const body = "```harness-deps\n#1\n```\nmiddle\n```harness-deps\n#2\n```";
  assert.deepEqual(parseDependsOn(body), [1, 2]);
});

test("parseDependsOn: absent block yields an empty dependency set", () => {
  assert.deepEqual(parseDependsOn("Just a normal issue body, no deps."), []);
});

test("parseDependsOn: prose 'depends on #5' OUTSIDE a fenced block is ignored (fence-only, not prose)", () => {
  assert.deepEqual(parseDependsOn("This depends on #5 conceptually."), []);
});

test("parseDependsOn: an empty or non-string body yields []", () => {
  assert.deepEqual(parseDependsOn(""), []);
  assert.deepEqual(parseDependsOn(undefined), []);
  assert.deepEqual(parseDependsOn(null), []);
  assert.deepEqual(parseDependsOn(42), []);
});

test("parseDependsOn: #0 and non-positive noise inside the block are dropped", () => {
  const body = "```harness-deps\n#0\n#5\n```";
  assert.deepEqual(parseDependsOn(body), [5]);
});

test("parseDependsOn: an info string after harness-deps (e.g. a language hint) still parses", () => {
  const body = "```harness-deps roadmap\n#8\n```";
  assert.deepEqual(parseDependsOn(body), [8]);
});
