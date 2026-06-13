/**
 * @description Pure NDJSON cost-stream parser for de-risk metering (AC v2.7).
 *
 * After a LIVE Ollama hand runs, the harness captures a cost NDJSON stream
 * (one JSON object per line). This module parses that stream and returns the
 * three metrics the orchestrator uses to decide whether to retire or keep a
 * model tier:
 *
 *   - toolCallErrorCount  — how often the cheap hand failed on tool calls
 *   - gpuTimeMs           — total GPU wall-time billed by the model provider
 *   - contextTokens       — input context tokens consumed (cost proxy)
 *
 * RECORD SCHEMA (lines in the NDJSON stream):
 *
 * Tool-call error record (counted toward toolCallErrorCount):
 *   { "type": "tool_result", "is_error": true, [any other fields] }
 *
 * Usage / summary record (provides gpuTimeMs and contextTokens; last one wins):
 *   { "type": "usage", "gpu_time_ms": <number>, "context_tokens": <number> }
 *
 * Any other line shape is ignored. Blank/whitespace lines and malformed JSON
 * are skipped silently — the parser never throws.
 *
 * DESIGN: pure function, dependency-free (Node builtins only). No filesystem
 * reads — the caller passes the NDJSON string directly. No side effects.
 */

/**
 * @description Aggregate metrics returned by parseDeriskMetrics.
 * @typedef {Object} DeriskMetrics
 * @property {number} toolCallErrorCount - Count of tool-call error records.
 * @property {number} gpuTimeMs - GPU wall-time in milliseconds (from last usage record).
 * @property {number} contextTokens - Context token count (from last usage record).
 */

/**
 * @description Parse a cost NDJSON stream string and return de-risk metrics.
 *
 * Tolerates blank lines and malformed JSON without throwing. Each non-empty
 * line is parsed independently; a bad line is skipped.
 *
 * @param {string} costNdjson - Raw NDJSON string (one JSON object per line).
 * @returns {DeriskMetrics} Aggregated metrics from the stream.
 */
export function parseDeriskMetrics(costNdjson) {
  /** @type {DeriskMetrics} */
  const metrics = {
    toolCallErrorCount: 0,
    gpuTimeMs: 0,
    contextTokens: 0,
  };

  const lines = costNdjson.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    let record;
    try {
      record = JSON.parse(trimmed);
    } catch {
      // Malformed JSON — skip silently per design contract.
      continue;
    }

    if (typeof record !== "object" || record === null) continue;

    if (record.type === "tool_result" && record.is_error === true) {
      metrics.toolCallErrorCount += 1;
      continue;
    }

    if (record.type === "usage") {
      if (typeof record.gpu_time_ms === "number") {
        metrics.gpuTimeMs = record.gpu_time_ms;
      }
      if (typeof record.context_tokens === "number") {
        metrics.contextTokens = record.context_tokens;
      }
    }
  }

  return metrics;
}
