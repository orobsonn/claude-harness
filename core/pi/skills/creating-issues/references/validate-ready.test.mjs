import { test } from "node:test";
import assert from "node:assert/strict";
import { validateReadyIssue } from "./validate-ready.mjs";

const view = (body, blockedBy = { nodes: [], totalCount: 0 }) =>
  () => JSON.stringify({ body, blockedBy });

test("Pi issue validation refuses prose and malformed blocks before ready", () => {
  for (const body of ["depende de: filha 1", "```harness-deps\n#\n```", "```harness-deps\n#1"]) {
    assert.throws(() => validateReadyIssue("owner/repo", 2, view(body)), /dependency metadata/);
  }
});

test("Pi issue validation accepts numbered prerequisites and explicit independence", () => {
  assert.deepEqual(validateReadyIssue("owner/repo", 2, view("```harness-deps\n#1\n```")),
    { ok: true, dependencies: [1], native_blockers: 0 });
  assert.deepEqual(validateReadyIssue("owner/repo", 2, view("### Dependências\n\nNenhuma.")),
    { ok: true, dependencies: [], native_blockers: 0 });
  assert.throws(() => validateReadyIssue("owner/repo", 2, view("independente", null)), /native blockedBy/);
});
