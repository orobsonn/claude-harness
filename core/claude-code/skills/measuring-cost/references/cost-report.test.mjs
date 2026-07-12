import { test } from "node:test";
import assert from "node:assert/strict";
import { formatCostReport, pickSession } from "./cost-report.mjs";

test("formatCostReport: session present → reports cost, model breakdown, and weekly trend", () => {
  const out = formatCostReport({
    session: {
      totalCost: 1.2345,
      totalTokens: 50000,
      modelBreakdowns: [
        { modelName: "claude-sonnet-4-6", cost: 1.0 },
        { modelName: "claude-opus-4-8", cost: 0.2345 },
      ],
    },
    weekly: { weekly: [{ period: "w1", totalCost: 10 }, { period: "w2", totalCost: 14.5 }] },
  });
  assert.match(out, /\*\*Sessão\*\*: \$1\.23 \(50\.000 tokens\)/);
  assert.match(out, /claude-sonnet-4-6: \$1\.00/);
  assert.match(out, /claude-opus-4-8: \$0\.23/);
  assert.match(out, /\*\*Semana atual\*\*.*\$14\.50/);
  assert.match(out, /▲ \$4\.50/);
});

test("formatCostReport: weekly drop → shows downward arrow with absolute delta", () => {
  const out = formatCostReport({
    session: { totalCost: 0.5, totalTokens: 1000, modelBreakdowns: [] },
    weekly: { weekly: [{ period: "w1", totalCost: 20 }, { period: "w2", totalCost: 12 }] },
  });
  assert.match(out, /▼ \$8\.00/);
});

test("formatCostReport: session null (ccusage unreachable) → graceful unavailable, never throws", () => {
  const out = formatCostReport({ session: null, weekly: null });
  assert.match(out, /\*\*Sessão\*\*: custo indisponível/);
  assert.match(out, /\*\*Semana\*\*: indisponível/);
});

test("pickSession: matches by session id (period) when provided", () => {
  const json = {
    session: [
      { period: "a", metadata: { lastActivity: "2026-06-01T00:00:00Z" } },
      { period: "b", metadata: { lastActivity: "2026-06-10T00:00:00Z" } },
    ],
  };
  assert.equal(pickSession(json, "a").period, "a");
});

test("pickSession: no id → picks the most-recently-active session", () => {
  const json = {
    session: [
      { period: "a", metadata: { lastActivity: "2026-06-01T00:00:00Z" } },
      { period: "b", metadata: { lastActivity: "2026-06-10T00:00:00Z" } },
    ],
  };
  assert.equal(pickSession(json, null).period, "b");
});

test("pickSession: empty session list → null", () => {
  assert.equal(pickSession({ session: [] }, null), null);
});
