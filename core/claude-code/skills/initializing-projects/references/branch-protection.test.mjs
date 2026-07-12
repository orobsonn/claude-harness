#!/usr/bin/env node
/**
 * @description Locked tests for branch-protection.mjs — verifies GET-then-merge
 * protection logic: context union (no clobber), enforce_admins invariant,
 * required_pull_request_reviews nulled, and no-admin-token guard.
 *
 * Usage:
 *   node --test branch-protection.test.mjs
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  buildProtectionPayload,
  applyProtection,
} from "./branch-protection.mjs";

// --- locked tests (must not be weakened) ---

test("locked-1: merge contexts — existing ['lint'] + requiredContext 'test' → contains both", () => {
  const existingProtection = {
    required_status_checks: {
      strict: true,
      contexts: ["lint"],
    },
    enforce_admins: { enabled: true },
    required_pull_request_reviews: { required_approving_review_count: 1 },
  };

  const payload = buildProtectionPayload(existingProtection, {
    requiredContext: "test",
  });

  assert.ok(
    Array.isArray(payload.required_status_checks.contexts),
    "contexts must be an array"
  );
  assert.ok(
    payload.required_status_checks.contexts.includes("lint"),
    `Expected contexts to include "lint", got: ${JSON.stringify(payload.required_status_checks.contexts)}`
  );
  assert.ok(
    payload.required_status_checks.contexts.includes("test"),
    `Expected contexts to include "test", got: ${JSON.stringify(payload.required_status_checks.contexts)}`
  );
});

test("locked-2: enforce_admins is always false and required_pull_request_reviews is always null", () => {
  const existingProtection = {
    required_status_checks: {
      strict: false,
      contexts: [],
    },
    enforce_admins: { enabled: true },
    required_pull_request_reviews: { required_approving_review_count: 2 },
  };

  const payload = buildProtectionPayload(existingProtection, {
    requiredContext: "ci",
  });

  assert.strictEqual(
    payload.enforce_admins,
    false,
    `enforce_admins must be false, got: ${payload.enforce_admins}`
  );
  assert.strictEqual(
    payload.required_pull_request_reviews,
    null,
    `required_pull_request_reviews must be null, got: ${JSON.stringify(payload.required_pull_request_reviews)}`
  );
});

test("locked-3: requiredContext 'test' (from job id) → contexts includes exactly 'test'", () => {
  const existingProtection = {
    required_status_checks: {
      strict: true,
      contexts: [],
    },
    enforce_admins: { enabled: false },
    required_pull_request_reviews: null,
  };

  const payload = buildProtectionPayload(existingProtection, {
    requiredContext: "test",
  });

  assert.ok(
    payload.required_status_checks.contexts.includes("test"),
    `Expected contexts to include "test", got: ${JSON.stringify(payload.required_status_checks.contexts)}`
  );
});

test("locked-4: hasAdminToken false → putProtection never called and returns { applied: false, reason }", async () => {
  let putCallCount = 0;
  const mockGetProtection = async () => ({
    required_status_checks: { strict: true, contexts: [] },
    enforce_admins: { enabled: false },
    required_pull_request_reviews: null,
  });
  const mockPutProtection = async () => {
    putCallCount++;
  };

  const result = await applyProtection({
    getProtection: mockGetProtection,
    putProtection: mockPutProtection,
    hasAdminToken: false,
    requiredContext: "test",
  });

  assert.strictEqual(
    putCallCount,
    0,
    `putProtection must never be called when hasAdminToken is false; called ${putCallCount} times`
  );
  assert.strictEqual(
    result.applied,
    false,
    `result.applied must be false, got: ${result.applied}`
  );
  assert.ok(
    typeof result.reason === "string" && result.reason.length > 0,
    `result.reason must be a non-empty string, got: ${JSON.stringify(result.reason)}`
  );
  assert.ok(
    result.reason.toLowerCase().includes("admin") ||
      result.reason.toLowerCase().includes("token"),
    `result.reason must mention the missing admin token, got: ${result.reason}`
  );
});

test("locked-5: dedupe — existing contexts already include 'test' → no duplicate", () => {
  const existingProtection = {
    required_status_checks: {
      strict: true,
      contexts: ["test", "lint"],
    },
    enforce_admins: { enabled: false },
    required_pull_request_reviews: null,
  };

  const payload = buildProtectionPayload(existingProtection, {
    requiredContext: "test",
  });

  const countTest = payload.required_status_checks.contexts.filter(
    (c) => c === "test"
  ).length;
  assert.strictEqual(
    countTest,
    1,
    `"test" must appear exactly once in contexts, found ${countTest}: ${JSON.stringify(payload.required_status_checks.contexts)}`
  );
});

// --- additional behavioral tests ---

test("apply: hasAdminToken true → getProtection and putProtection called, returns { applied: true }", async () => {
  let getCalled = false;
  let putCalledWith = null;

  const mockGetProtection = async () => {
    getCalled = true;
    return {
      required_status_checks: { strict: true, contexts: ["lint"] },
      enforce_admins: { enabled: true },
      required_pull_request_reviews: { required_approving_review_count: 1 },
    };
  };
  const mockPutProtection = async (payload) => {
    putCalledWith = payload;
  };

  const result = await applyProtection({
    getProtection: mockGetProtection,
    putProtection: mockPutProtection,
    hasAdminToken: true,
    requiredContext: "test",
  });

  assert.ok(getCalled, "getProtection must be called when hasAdminToken is true");
  assert.ok(
    putCalledWith !== null,
    "putProtection must be called when hasAdminToken is true"
  );
  assert.strictEqual(
    result.applied,
    true,
    `result.applied must be true, got: ${result.applied}`
  );
  assert.ok(
    putCalledWith.required_status_checks.contexts.includes("test"),
    `putProtection payload must include 'test' context`
  );
  assert.ok(
    putCalledWith.required_status_checks.contexts.includes("lint"),
    `putProtection payload must preserve existing 'lint' context`
  );
  assert.strictEqual(
    putCalledWith.enforce_admins,
    false,
    "putProtection payload must have enforce_admins === false"
  );
  assert.strictEqual(
    putCalledWith.required_pull_request_reviews,
    null,
    "putProtection payload must have required_pull_request_reviews === null"
  );
});

test("preserve: existing fields not managed are kept in payload", () => {
  const existingProtection = {
    required_status_checks: {
      strict: true,
      contexts: ["lint"],
    },
    enforce_admins: { enabled: false },
    required_pull_request_reviews: null,
    restrictions: { users: [], teams: [] },
  };

  const payload = buildProtectionPayload(existingProtection, {
    requiredContext: "test",
  });

  assert.deepStrictEqual(
    payload.restrictions,
    { users: [], teams: [], apps: [] },
    "restrictions must be normalized to the PUT array-shape (users/teams/apps)"
  );
});
