/**
 * @description Test suite for obs-eye-append.mjs — PostToolUse[Agent] hook.
 * Modeled on codex-eye-nudge.mjs/codex-eye-nudge.test.mjs.
 *
 * ## Assumed API (the hand must match this exactly)
 *
 * ### `decide(payload, env, deps)`
 *   Pure. No I/O. Never throws. Returns `{action:'append', role, metaPath}` | `{action:'none'}`.
 *   - `env`: object read for HARNESS_OBSERVABILITY_RUN_PATH (production: `process.env`).
 *   - `deps.existsSync`: `(path: string) => boolean` — FS probe (injectable). Default at the
 *     decide() seam: `() => false` (inert — never fires without injection or a real path).
 *   Skip conditions (all yield `action:'none'`):
 *     - `payload.agent_id` present                                     (main-loop only)
 *     - `payload.tool_name !== 'Agent'`
 *     - `bareRole(payload.tool_input.subagent_type)` not in the eye set
 *       {compliance, adversary, security, plan-reviewer}
 *     - `env.HARNESS_OBSERVABILITY_RUN_PATH` falsy/absent
 *     - `deps.existsSync(env.HARNESS_OBSERVABILITY_RUN_PATH)` false
 *   On append: `role` is the bare (namespace-stripped) role name; `metaPath` is
 *   `env.HARNESS_OBSERVABILITY_RUN_PATH`.
 *
 * ### `processInput(rawStr, deps)`
 *   Parses `rawStr`, calls `decide` with the real FS probe (existsSync) injected at this layer.
 *   On `{action:'append', role, metaPath}`, appends `{type:'eye', role}` to the outbox via
 *   `deps.appendEvent` (production default: obs-outbox's `appendEvent`) — NO fetch, ever.
 *   Returns `{ exitCode: 0 }` always. Any thrown error is swallowed — fail-open.
 *   `deps` supports: `{ existsSync?: fn, appendEvent?: fn, env?: object }` to override
 *   production defaults.
 *
 * ## Testing strategy
 *   - Tests use **dynamic import** (`await import(...)`) so each test fails individually (RED)
 *     when the module does not yet exist, rather than failing the entire file at load time.
 *
 * Run with: node --test core/hooks/obs-eye-append.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MODULE_URL = new URL("./obs-eye-append.mjs", import.meta.url).href;

/** Builds a minimal eligible PostToolUse[Agent] payload. */
function agentPayload(subagentType, extra = {}) {
  return {
    tool_name: "Agent",
    tool_input: { subagent_type: subagentType },
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Assertion 1 — happy path: compliance role, existing outbox meta => append once
// ---------------------------------------------------------------------------

test(
  "processInput: tool_name 'Agent', subagent_type 'compliance', no agent_id, " +
    "HARNESS_OBSERVABILITY_RUN_PATH at an existing obs meta => a single " +
    "{type:'eye', role:'compliance'} event is appended to the outbox",
  async () => {
    const { processInput } = await import(MODULE_URL);

    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-eye-append-fixture-"));
    try {
      const metaPath = path.join(fixtureDir, "obs-141.json");
      fs.writeFileSync(
        metaPath,
        JSON.stringify({
          issueNumber: 141,
          project: "p",
          worktreePath: "/w",
          threadId: 707,
          cursor: 0,
          status: "active",
        }),
        "utf8",
      );

      const appendCalls = [];
      const spyAppendEvent = (calledMetaPath, event) => {
        appendCalls.push({ metaPath: calledMetaPath, event });
      };

      const originalFetch = globalThis.fetch;
      globalThis.fetch = () => {
        throw new Error("fetch must never be called by this hook");
      };

      try {
        const payload = agentPayload("compliance");
        const result = processInput(JSON.stringify(payload), {
          env: { HARNESS_OBSERVABILITY_RUN_PATH: metaPath },
          appendEvent: spyAppendEvent,
        });

        assert.equal(result.exitCode, 0, "exitCode must always be 0");
      } finally {
        globalThis.fetch = originalFetch;
      }

      assert.equal(appendCalls.length, 1, "appendEvent must be called exactly once");
      assert.equal(appendCalls[0].metaPath, metaPath, "must append to the run's outbox meta path");
      assert.equal(appendCalls[0].event.type, "eye", "appended event must have type 'eye'");
      assert.equal(
        appendCalls[0].event.role,
        "compliance",
        "appended event must carry role 'compliance'",
      );
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  },
);

// ---------------------------------------------------------------------------
// Assertion 2 — non-eye role: planner => NO append
// ---------------------------------------------------------------------------

test(
  "processInput: same payload but subagent_type 'planner' (not an eye role) => NO event appended",
  async () => {
    const { processInput } = await import(MODULE_URL);

    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-eye-append-fixture-"));
    try {
      const metaPath = path.join(fixtureDir, "obs-141.json");
      fs.writeFileSync(metaPath, JSON.stringify({ issueNumber: 141, status: "active" }), "utf8");

      const appendCalls = [];
      const result = processInput(JSON.stringify(agentPayload("planner")), {
        env: { HARNESS_OBSERVABILITY_RUN_PATH: metaPath },
        appendEvent: (calledMetaPath, event) => appendCalls.push({ calledMetaPath, event }),
      });

      assert.equal(result.exitCode, 0);
      assert.equal(appendCalls.length, 0, "planner is not an eye role — no append expected");
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  },
);

// ---------------------------------------------------------------------------
// Assertion 3 — subagent context: agent_id present => NO append (main-loop only)
// ---------------------------------------------------------------------------

test(
  "processInput: compliance Agent payload but agent_id present (subagent context) => " +
    "NO event appended (main-loop only)",
  async () => {
    const { processInput } = await import(MODULE_URL);

    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "obs-eye-append-fixture-"));
    try {
      const metaPath = path.join(fixtureDir, "obs-141.json");
      fs.writeFileSync(metaPath, JSON.stringify({ issueNumber: 141, status: "active" }), "utf8");

      const appendCalls = [];
      const payload = agentPayload("compliance", { agent_id: "ag_abc123" });
      const result = processInput(JSON.stringify(payload), {
        env: { HARNESS_OBSERVABILITY_RUN_PATH: metaPath },
        appendEvent: (calledMetaPath, event) => appendCalls.push({ calledMetaPath, event }),
      });

      assert.equal(result.exitCode, 0);
      assert.equal(
        appendCalls.length,
        0,
        "agent_id present means this is a subagent context — no append expected",
      );
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  },
);

// ---------------------------------------------------------------------------
// Assertion 4 — HARNESS_OBSERVABILITY_RUN_PATH unset => no file written, no fetch, exit 0
// ---------------------------------------------------------------------------

test(
  "processInput: compliance Agent payload with HARNESS_OBSERVABILITY_RUN_PATH unset => " +
    "NO file is written, no fetch is attempted, and the process result is exit 0 (fail-open no-op)",
  async () => {
    const { processInput } = await import(MODULE_URL);

    const appendCalls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => {
      throw new Error("fetch must never be called by this hook");
    };

    let result;
    try {
      result = processInput(JSON.stringify(agentPayload("compliance")), {
        env: {}, // HARNESS_OBSERVABILITY_RUN_PATH unset
        appendEvent: (calledMetaPath, event) => appendCalls.push({ calledMetaPath, event }),
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.equal(result.exitCode, 0, "exitCode must be 0 (fail-open no-op)");
    assert.equal(
      appendCalls.length,
      0,
      "HARNESS_OBSERVABILITY_RUN_PATH unset must never trigger an append",
    );
  },
);

// ---------------------------------------------------------------------------
// Curated-event decision layer — decide() now returns {action, role, metaPath, event}
// ---------------------------------------------------------------------------

const META_PATH = "/state/obs-1.json";
const ENV = { HARNESS_OBSERVABILITY_RUN_PATH: META_PATH };

/** Decide-layer deps: meta exists, no plan yet, no prior spec-adversary — overridable per test. */
function eyeDeps(overrides = {}) {
  return {
    existsSync: () => true,
    planExists: () => false,
    hasEvent: () => false,
    ...overrides,
  };
}

test(
  "decide: plan-reviewer whose tool_response contains 'APPROVE' => " +
    "{action:'append'} carrying event {type:'plan-reviewed', verdict:'APPROVE'}",
  async () => {
    const { decide } = await import(MODULE_URL);

    const payload = agentPayload("plan-reviewer", {
      tool_response: "Verdict: APPROVE — the plan is sound.",
    });
    const decision = decide(payload, ENV, eyeDeps());

    assert.equal(decision.action, "append");
    assert.equal(decision.role, "plan-reviewer");
    assert.equal(decision.metaPath, META_PATH);
    assert.deepEqual(decision.event, { type: "plan-reviewed", verdict: "APPROVE", round: 1 });
  },
);

test(
  "decide: plan-reviewer stamps a 1-based round = countEvents('plan-reviewed') + 1 (REVISE→re-plan cycle)",
  async () => {
    const { decide } = await import(MODULE_URL);

    // Two plan-reviewed already in the outbox → this return is the 3rd review round.
    const decision = decide(
      agentPayload("plan-reviewer", { tool_response: "Verdict: APPROVE" }),
      ENV,
      eyeDeps({ countEvents: (mp, type) => (mp === META_PATH && type === "plan-reviewed" ? 2 : 0) }),
    );

    assert.deepEqual(decision.event, { type: "plan-reviewed", verdict: "APPROVE", round: 3 });
  },
);

test(
  "decide: plan-reviewer 'REVISE' => verdict 'REVISE'; when BOTH tokens appear, REVISE wins",
  async () => {
    const { decide } = await import(MODULE_URL);

    const revised = decide(
      agentPayload("plan-reviewer", { tool_response: "Verdict: REVISE — task-3 scope is wrong." }),
      ENV,
      eyeDeps(),
    );
    assert.deepEqual(revised.event, { type: "plan-reviewed", verdict: "REVISE", round: 1 });

    const both = decide(
      agentPayload("plan-reviewer", {
        tool_response: "I would APPROVE most of it, but the verdict is REVISE.",
      }),
      ENV,
      eyeDeps(),
    );
    assert.deepEqual(
      both.event,
      { type: "plan-reviewed", verdict: "REVISE", round: 1 },
      "REVISE must win when both tokens appear (conservative — surface 'needs work')",
    );
  },
);

test(
  "decide: plan-reviewer with NO verdict token => event {type:'plan-reviewed'} without a verdict key",
  async () => {
    const { decide } = await import(MODULE_URL);

    const decision = decide(
      agentPayload("plan-reviewer", { tool_response: "returned without a usable token" }),
      ENV,
      eyeDeps(),
    );

    assert.equal(decision.action, "append");
    assert.deepEqual(decision.event, { type: "plan-reviewed", round: 1 });
    assert.equal(
      Object.prototype.hasOwnProperty.call(decision.event, "verdict"),
      false,
      "the event must carry NO verdict key when neither token is present",
    );
  },
);

test(
  "decide: plan-reviewer verdict parsing tolerates an OBJECT-shaped tool_response " +
    "(parseVerdict is module-private — exercised via decide)",
  async () => {
    const { decide } = await import(MODULE_URL);

    const decision = decide(
      agentPayload("plan-reviewer", {
        tool_response: { content: [{ type: "text", text: "APPROVE" }] },
      }),
      ENV,
      eyeDeps(),
    );

    assert.deepEqual(decision.event, { type: "plan-reviewed", verdict: "APPROVE", round: 1 });
  },
);

test(
  "decide: adversary with planExists=false AND no prior spec-adversary => event {type:'spec-adversary'}",
  async () => {
    const { decide } = await import(MODULE_URL);

    const hasEventCalls = [];
    const decision = decide(
      agentPayload("adversary"),
      ENV,
      eyeDeps({
        planExists: (mp) => {
          assert.equal(mp, META_PATH, "planExists must be probed with the run's metaPath");
          return false;
        },
        hasEvent: (mp, type) => {
          hasEventCalls.push({ mp, type });
          return false;
        },
      }),
    );

    assert.equal(decision.action, "append");
    assert.equal(decision.role, "adversary");
    assert.deepEqual(decision.event, { type: "spec-adversary" });
    assert.ok(
      hasEventCalls.some((c) => c.mp === META_PATH && c.type === "spec-adversary"),
      "the dedupe guard must probe hasEvent(metaPath, 'spec-adversary')",
    );
  },
);

test(
  "decide: adversary with planExists=true => raw {type:'eye', role:'adversary'} " +
    "(per-task / final-review adversary is NOT a spec-adversary)",
  async () => {
    const { decide } = await import(MODULE_URL);

    const decision = decide(
      agentPayload("adversary"),
      ENV,
      eyeDeps({ planExists: () => true }),
    );

    assert.equal(decision.action, "append");
    assert.deepEqual(decision.event, { type: "eye", role: "adversary" });
  },
);

test(
  "decide: adversary with a spec-adversary ALREADY in the outbox => raw {type:'eye', role:'adversary'} " +
    "(dedupe: never a second spec-adversary)",
  async () => {
    const { decide } = await import(MODULE_URL);

    const decision = decide(
      agentPayload("adversary"),
      ENV,
      eyeDeps({ hasEvent: (mp, type) => type === "spec-adversary" }),
    );

    assert.equal(decision.action, "append");
    assert.deepEqual(decision.event, { type: "eye", role: "adversary" });
  },
);

test(
  "decide: compliance and security stay raw {type:'eye', role} events (unchanged)",
  async () => {
    const { decide } = await import(MODULE_URL);

    for (const role of ["compliance", "security"]) {
      const decision = decide(agentPayload(role), ENV, eyeDeps());
      assert.equal(decision.action, "append", `${role} must still append`);
      assert.deepEqual(decision.event, { type: "eye", role });
    }
  },
);

test(
  "decide: agent_id present => {action:'none'} (subagent skip, unchanged by the event field)",
  async () => {
    const { decide } = await import(MODULE_URL);

    const decision = decide(
      agentPayload("plan-reviewer", { agent_id: "ag_xyz", tool_response: "APPROVE" }),
      ENV,
      eyeDeps(),
    );

    assert.deepEqual(decision, { action: "none" });
  },
);

test(
  "processInput fail-open: throwing readMeta/readEvents/existsSync/appendEvent deps " +
    "still yield {exitCode:0} and never throw",
  async () => {
    const { processInput } = await import(MODULE_URL);

    const boom = () => {
      throw new Error("boom");
    };
    const raw = JSON.stringify(agentPayload("adversary"));

    // Throwing readMeta + readEvents: swallowed inside the planExists/hasEvent probes.
    let result;
    assert.doesNotThrow(() => {
      result = processInput(raw, {
        env: ENV,
        existsSync: () => true,
        readMeta: boom,
        readEvents: boom,
        appendEvent: () => {},
      });
    });
    assert.deepEqual(result, { exitCode: 0 });

    // Throwing existsSync: swallowed by the processInput try/catch.
    assert.doesNotThrow(() => {
      result = processInput(raw, { env: ENV, existsSync: boom, appendEvent: () => {} });
    });
    assert.deepEqual(result, { exitCode: 0 });

    // Throwing appendEvent: swallowed by the processInput try/catch.
    assert.doesNotThrow(() => {
      result = processInput(raw, { env: ENV, existsSync: () => true, appendEvent: boom });
    });
    assert.deepEqual(result, { exitCode: 0 });
  },
);
