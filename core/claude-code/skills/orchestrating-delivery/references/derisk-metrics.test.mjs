/**
 * @description Tests for parseDeriskMetrics — pure NDJSON cost-stream parser.
 * Run with: node --test core/skills/orchestrating-delivery/references/derisk-metrics.test.mjs
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { parseDeriskMetrics } from "./derisk-metrics.mjs";

// Fixture: 3 tool-call errors + a usage/summary record
const FIXTURE_NDJSON = [
  JSON.stringify({ type: "tool_result", is_error: true, tool_use_id: "t1" }),
  JSON.stringify({ type: "tool_result", is_error: true, tool_use_id: "t2" }),
  JSON.stringify({ type: "tool_result", is_error: true, tool_use_id: "t3" }),
  JSON.stringify({ type: "usage", gpu_time_ms: 1234, context_tokens: 4567 }),
].join("\n");

describe("parseDeriskMetrics", () => {
  it("counts 3 tool-call errors and reads gpuTimeMs / contextTokens from fixture", () => {
    const result = parseDeriskMetrics(FIXTURE_NDJSON);
    assert.strictEqual(result.toolCallErrorCount, 3, "expected 3 tool-call error records");
    assert.strictEqual(result.gpuTimeMs, 1234, "expected gpuTimeMs === 1234");
    assert.strictEqual(result.contextTokens, 4567, "expected contextTokens === 4567");
  });

  it("returns zero counts for an empty string", () => {
    const result = parseDeriskMetrics("");
    assert.strictEqual(result.toolCallErrorCount, 0);
    assert.strictEqual(result.gpuTimeMs, 0);
    assert.strictEqual(result.contextTokens, 0);
  });

  it("tolerates blank lines and malformed JSON without throwing", () => {
    const ndjson = [
      "",
      "   ",
      "not-json{{",
      JSON.stringify({ type: "tool_result", is_error: true }),
      JSON.stringify({ type: "usage", gpu_time_ms: 99, context_tokens: 8 }),
    ].join("\n");
    const result = parseDeriskMetrics(ndjson);
    assert.strictEqual(result.toolCallErrorCount, 1);
    assert.strictEqual(result.gpuTimeMs, 99);
    assert.strictEqual(result.contextTokens, 8);
  });

  it("ignores tool_result records where is_error is not true", () => {
    const ndjson = [
      JSON.stringify({ type: "tool_result", is_error: false }),
      JSON.stringify({ type: "tool_result" }),
    ].join("\n");
    const result = parseDeriskMetrics(ndjson);
    assert.strictEqual(result.toolCallErrorCount, 0);
  });
});
