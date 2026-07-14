/** @description Focused planner result classification tests for provider failures and full-plan validity. */
import test from "node:test";
import assert from "node:assert/strict";
import { classifyPlannerBoundaryError, classifyPlannerResult } from "./planner-result.mjs";

const FULL_PLAN = {
  feature_id: "planner-recovery",
  kind: "full",
  mode: "full",
  tasks: [{
    id: "task-1",
    severity: "medium",
    complexity: "medium",
    scope_paths: ["src/planner.ts"],
    criterion_refs: ["#ac-1"],
    depends_on: [],
    locked_tests: [{ id: "lt-1", path: "src/planner.test.ts" }],
  }],
};

for (const [failureClass, response] of [
  ["auth", { name: "ProviderAuthError", data: { message: "401 unauthorized" } }],
  ["credit", { name: "APIError", data: { message: "insufficient credits", statusCode: 402 } }],
  ["timeout", { name: "MessageAbortedError", data: { message: "deadline exceeded" } }],
  ["provider", { name: "APIError", data: { message: "service unavailable", statusCode: 503 } }],
]) {
  test(`classifies structured ${failureClass} boundary as provider failure`, () => {
    assert.deepEqual(classifyPlannerBoundaryError(response), { kind: "provider_failure", failureClass });
  });
}

test("status taxonomy keeps retryable provider failures narrow", () => {
  assert.equal(classifyPlannerBoundaryError({ name: "APIError", data: { statusCode: 403, message: "forbidden" } }).failureClass, "auth");
  assert.equal(classifyPlannerBoundaryError({ name: "APIError", data: { statusCode: 429, message: "too many requests" } }).failureClass, "credit");
  assert.equal(classifyPlannerBoundaryError({ name: "APIError", data: { statusCode: 408, message: "request timeout" } }).failureClass, "timeout");
  assert.equal(classifyPlannerBoundaryError({ name: "APIError", data: { statusCode: 502, message: "bad gateway" } }).failureClass, "provider");
  for (const statusCode of [400, 404]) {
    assert.deepEqual(
      classifyPlannerBoundaryError({ name: "APIError", data: { statusCode, message: "validation/arguments error" } }),
      { kind: "execution_failure", failureClass: "execution" },
    );
  }
  for (const [statusCode, message] of [[400, "service unavailable"], [404, "invalid api key"], [409, "timeout"], [422, "rate limit"]]) {
    assert.deepEqual(
      classifyPlannerBoundaryError({ name: "APIError", data: { statusCode, message } }),
      { kind: "execution_failure", failureClass: "execution" },
      `explicit ${statusCode} must override ambiguous keywords`,
    );
  }
});

test("accepts a fenced structurally valid full plan with summary", () => {
  const result = classifyPlannerResult(`\`\`\`json\n${JSON.stringify(FULL_PLAN)}\n\`\`\`\nPlano pronto.`);
  assert.equal(result.kind, "usable_plan");
  assert.equal(result.plan.tasks.length, 1);
});

test("unknown structured task rejection is execution failure, not provider unavailability", () => {
  assert.deepEqual(classifyPlannerBoundaryError("invalid subagent type"), {
    kind: "execution_failure",
    failureClass: "execution",
  });
});

for (const [name, response] of [
  ["empty", ""],
  ["stub", JSON.stringify({ feature_id: "planner-recovery", kind: "stub", mode: "FULL", tasks: [] })],
  ["malformed", JSON.stringify({ feature_id: "planner-recovery", kind: "full", mode: "full", tasks: [{}] })],
  ["malformed with provider prose", `${JSON.stringify({ feature_id: "planner-recovery", kind: "stub", mode: "FULL", tasks: [] })}\n429 provider error`],
  ["provider-looking prose", "429 provider unavailable"],
]) {
  test(`rejects ${name} planner output as invalid, not provider failure`, () => {
    const result = classifyPlannerResult(response);
    assert.equal(result.kind, "invalid_plan");
    assert.ok(result.errors.length >= 1);
  });
}
