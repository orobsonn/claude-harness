#!/usr/bin/env node
/**
 * @description Locked unit tests for synthesizeContract(pr) — the pseudo-contract
 * synthesizer that lets the compliance agent review a raw diff (a PR has no plan of
 * its own to check against).
 *
 * Pinned signature:
 *   synthesizeContract(pr: { title: string, body: string, changedFiles: string[] })
 *     => { criterion_refs: string[], scope_paths: string[] }
 *
 * Pinned behavior:
 *   - criterion_refs = every `/#ac-[\d.]+/g` match found in title+body, in order.
 *   - When NO #ac-N.M reference exists anywhere in title/body, criterion_refs falls
 *     back to a NON-EMPTY, title-derived synthetic ref — pinned shape:
 *       `#ac-title:<kebab-case-title>` where kebab-case lowercases the title, replaces
 *       every run of non-alphanumeric characters with a single '-', and trims leading/
 *       trailing '-'. An empty criterion_refs is NEVER acceptable — it would let
 *       compliance pass vacuously against a raw diff with no plan to anchor on.
 *   - scope_paths = pr.changedFiles, unmodified.
 *
 * Tests run under node:test.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { synthesizeContract } from "./compliance-diff-adapter.mjs";

// ─── #ac reference found in the PR body -> criterion_refs mirrors it exactly ──
test("Given a PR whose body contains #ac-1.1, When synthesizeContract(pr) runs, Then it returns criterion_refs=['#ac-1.1'] and scope_paths=changedFiles", () => {
  const pr = {
    title: "fix: repara loop de redirect no login",
    body: "Closes #ac-1.1. Ajusta o handler de callback do OAuth.",
    changedFiles: ["core/vps/x.mjs"],
  };

  const result = synthesizeContract(pr);

  assert.deepEqual(result, {
    criterion_refs: ["#ac-1.1"],
    scope_paths: ["core/vps/x.mjs"],
  });
});

// ─── no #ac reference anywhere -> non-empty, title-derived fallback ──────────
test("Given a PR body with NO #ac lines, When synthesizeContract runs, Then criterion_refs is a non-empty fallback derived from the PR title (never an empty contract)", () => {
  const pr = {
    title: "Fix the login redirect",
    body: "just a fix",
    changedFiles: ["core/auth/login.mjs"],
  };

  const result = synthesizeContract(pr);

  assert.ok(Array.isArray(result.criterion_refs), "criterion_refs must be an array");
  assert.ok(
    result.criterion_refs.length > 0,
    "criterion_refs must never be empty — an empty contract would let compliance pass vacuously"
  );
  assert.deepEqual(
    result.criterion_refs,
    ["#ac-title:fix-the-login-redirect"],
    "fallback must be the pinned #ac-title:<kebab-case-title> shape derived from pr.title"
  );
  assert.deepEqual(result.scope_paths, ["core/auth/login.mjs"]);
});
