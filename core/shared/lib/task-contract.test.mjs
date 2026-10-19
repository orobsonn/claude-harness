import { test } from "node:test";
import assert from "node:assert/strict";

import {
  availableTaskWorktreeName,
  hashTaskReceipt,
  stableTaskJson,
  taskScopeOf,
  taskScopesOverlap,
  taskWorktreeName,
  unsupportedTaskScopePattern,
} from "./task-contract.mjs";

const task = (fields) => ({ id: "t", scope_paths: [], locked_tests: [], ...fields });

test("canonical receipt hash is independent of key order at every depth", () => {
  const a = { b: 1, a: { d: [3, { y: 1, x: 2 }], c: null } };
  const b = { a: { c: null, d: [3, { x: 2, y: 1 }] }, b: 1 };
  assert.equal(stableTaskJson(a), stableTaskJson(b));
  assert.equal(hashTaskReceipt(a), hashTaskReceipt(b));
  assert.match(hashTaskReceipt(a), /^[a-f0-9]{64}$/);
  // Array order is meaningful and must change the digest.
  assert.notEqual(hashTaskReceipt({ a: [1, 2] }), hashTaskReceipt({ a: [2, 1] }));
});

test("glob syntax is rejected while literal brackets and single-word braces are accepted", () => {
  for (const glob of ["src/*.mjs", "src/**", "src/a?.js", "src/{a,b}.js", "src/{1..3}.js"]) {
    assert.equal(unsupportedTaskScopePattern(glob), true, glob);
    assert.throws(() => taskScopeOf(task({ scope_paths: [glob] })), /unsupported glob syntax/, glob);
  }
  for (const literal of ["app/[slug]/page.tsx", "docs/{version}/index.md"]) {
    assert.equal(unsupportedTaskScopePattern(literal), false, literal);
    assert.deepEqual(taskScopeOf(task({ scope_paths: [literal] })), [literal]);
  }
});

test("unsafe scope paths are rejected before any effect", () => {
  for (const unsafe of ["../outside", "src/../../etc", "/etc/passwd", "src\\win.js", "src/\0x", ""]) {
    assert.throws(() => taskScopeOf(task({ scope_paths: [unsafe] })), /safe repo-relative paths/, JSON.stringify(unsafe));
  }
  assert.throws(() => taskScopeOf(task({ locked_tests: [{ path: "/abs/test.mjs" }] })), /safe repo-relative/);
  assert.throws(() => taskScopeOf(task({ allowed_writes: ["../x"] })), /safe repo-relative/);
});

test("scope normalizes trailing slashes and maps the repository root to the empty path", () => {
  assert.deepEqual(taskScopeOf(task({ scope_paths: ["src/a/", "./lib", "."] })), ["src/a", "lib", ""]);
});

test("overlap compares whole path components", () => {
  const a = task({ scope_paths: ["src/a"] });
  assert.equal(taskScopesOverlap(a, task({ scope_paths: ["src/ab"] })), false);
  assert.equal(taskScopesOverlap(task({ scope_paths: ["src/a/"] }), task({ scope_paths: ["src/a/x"] })), true);
  assert.equal(taskScopesOverlap(a, task({ scope_paths: ["src/a"] })), true);
  assert.equal(taskScopesOverlap(task({ scope_paths: ["."] }), task({ scope_paths: ["anything/at/all"] })), true);
  assert.equal(taskScopesOverlap(task({ scope_paths: ["docs"] }), task({ scope_paths: ["."] })), true);
});

test("locked tests, fixtures and allowed writes all count toward overlap", () => {
  const product = task({ scope_paths: ["src/feature"] });
  assert.equal(taskScopesOverlap(product, task({ scope_paths: ["src/other"], locked_tests: [{ path: "src/feature/x.test.mjs" }] })), true);
  assert.equal(taskScopesOverlap(product, task({ scope_paths: ["src/other"], locked_tests: [{ path: "t/y.test.mjs", fixture_paths: ["src/feature/fixture.json"] }] })), true);
  assert.equal(taskScopesOverlap(product, task({ scope_paths: ["src/other"], allowed_writes: ["src/feature/generated.js"] })), true);
  assert.equal(taskScopesOverlap(product, task({ scope_paths: ["src/other"], locked_tests: [{ path: "t/z.test.mjs", fixture_paths: ["t/fx"] }] })), false);
});

test("readable worktree names strip accents, cap words and length, and fall back safely", () => {
  assert.equal(taskWorktreeName({ id: "a", title: "Ação de cobrança automática mensal" }, 1), "task-1-acao-de-cobranca");
  assert.equal(taskWorktreeName({ id: "task-3-foo", title: "" }, 3), "task-3-foo");
  assert.equal(taskWorktreeName({ id: "task-3", title: "", description: "" }, 2), "task-2-implementacao");
  assert.equal(taskWorktreeName({ id: "x", description: "Refatorar o módulo" }, 4), "task-4-refatorar-o-modulo");
  const long = taskWorktreeName({ id: "x", title: "supercalifragilisticexpialidocious-anticonstitutionnellement" }, 1);
  assert.ok(long.length - "task-1-".length <= 36, long);
  assert.doesNotMatch(long, /-$/);
});

test("worktree name collisions get numeric suffixes and never reuse a taken name", () => {
  const taken = new Set(["task-1-foo", "task-1-foo-2"]);
  assert.equal(availableTaskWorktreeName("task-1-foo", (name) => taken.has(name)), "task-1-foo-3");
  assert.equal(availableTaskWorktreeName("task-2-bar", (name) => taken.has(name)), "task-2-bar");
  assert.throws(() => availableTaskWorktreeName("x", () => true), /no free task worktree name/);
});
