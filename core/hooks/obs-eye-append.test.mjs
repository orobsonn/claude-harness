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
