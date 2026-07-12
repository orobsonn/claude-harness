/**
 * @description Test suite for codex-eye-nudge.mjs — PostToolUse[Agent] hook.
 *
 * ## Assumed API (the hand must match this exactly)
 *
 * ### `decide(payload, env, deps)`
 *   Pure. No I/O. Never throws. Returns `{action:'inject', role, context}` | `{action:'none'}`.
 *   - `env`: object read for feature flags (production: `process.env`).
 *   - `deps.moduleExists`: `(cwd: string) => boolean` — FS probe (injectável).
 *     Default at the decide() seam: `() => false` (inert — never fires without injection).
 *   Skip conditions (all yield `action:'none'`):
 *     - `payload.agent_id` present                                 (main-loop only)
 *     - `payload.tool_name !== 'Agent'`
 *     - `bareRole(payload.tool_input.subagent_type)` not in {adversary, security, plan-reviewer}
 *     - `env.HARNESS_CODEX_ADVERSARY` falsy                        (global switch off)
 *     - `deps.moduleExists(cwd)` false                             (fail-open, no hard dep)
 *     - `payload.cwd` non-string, relative, or absent              (guard fail-open)
 *   On inject: `context` contains 'cross-family.mjs', the role name, and an AFTER-the-eye-returns
 *   sequencing phrase.
 *
 * ### `processInput(rawStr, deps)`
 *   Parses `rawStr`, calls `decide` with the real FS probe injected at this layer.
 *   Returns `{ exitCode: 0, output: string|null }`.
 *   - `output`: JSON `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"..."}}` when inject.
 *   - `output`: `null` when none.
 *   - NEVER includes `permissionDecision`.
 *   - Any thrown error → `{ exitCode: 0, output: null }`.
 *   `deps` supports: `{ moduleExists?: fn, env?: object }` to override production defaults.
 *   Production defaults: `moduleExists` = `existsSync` check on `payload.cwd`; `env` = `process.env`.
 *
 * ## Testing strategy
 *   - Tests 1–9: drive `decide()` directly with injectable `env`/`deps`.
 *   - Test 10: drive `processInput()` with a fixture dir that actually contains the module file,
 *     proving the production probe reads `payload.cwd` (not `process.cwd()`).
 *   - Tests 11–12: drive `processInput()` for thrown-error fail-open and garbage-payload behaviour.
 *   - All tests use **dynamic import** (`await import(...)`) so that each test fails individually
 *     (RED) when the module does not yet exist, rather than failing the entire file at load time.
 *
 * Run with: node --test core/hooks/codex-eye-nudge.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Module URL used for dynamic import, resolved relative to this test file.
const MODULE_URL = new URL("./codex-eye-nudge.mjs", import.meta.url).href;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds a minimal eligible PostToolUse[Agent] payload. */
function agentPayload(subagentType, cwd = "/absolute/project/root", extra = {}) {
  return {
    tool_name: "Agent",
    tool_input: { subagent_type: subagentType },
    cwd,
    ...extra,
  };
}

/** Env with the feature switch on. */
const ENV_ON = Object.freeze({ HARNESS_CODEX_ADVERSARY: "1" });
/** Env with the feature switch off (unset). */
const ENV_OFF = Object.freeze({});

/** deps with moduleExists always returning true. */
const DEPS_PRESENT = Object.freeze({ moduleExists: () => true });
/** deps with moduleExists always returning false. */
const DEPS_ABSENT = Object.freeze({ moduleExists: () => false });

// ---------------------------------------------------------------------------
// Test 1 — happy path: adversary role, switch on, module present → inject
// ---------------------------------------------------------------------------

test(
  "decide: adversary, no agent_id, HARNESS_CODEX_ADVERSARY=1, module present => " +
    "{action:'inject', role:'adversary'}, context has cross-family.mjs + role + AFTER phrase",
  async () => {
    const { decide } = await import(MODULE_URL);

    const payload = agentPayload("adversary");
    const result = decide(payload, ENV_ON, DEPS_PRESENT);

    assert.equal(result.action, "inject");
    assert.equal(result.role, "adversary");
    assert.ok(
      typeof result.context === "string" && result.context.length > 0,
      "context must be a non-empty string",
    );
    assert.ok(
      result.context.includes("cross-family.mjs"),
      "context must mention cross-family.mjs",
    );
    assert.ok(
      result.context.toLowerCase().includes("adversary"),
      "context must name the role 'adversary'",
    );
    assert.ok(
      result.context.toLowerCase().includes("after"),
      "context must contain an AFTER-the-eye-returns sequencing phrase",
    );
  },
);

// ---------------------------------------------------------------------------
// Test 2 — non-eye role: planner → none
// ---------------------------------------------------------------------------

test(
  "decide: subagent_type='planner' (not an eye role), all else enabling => action 'none'",
  async () => {
    const { decide } = await import(MODULE_URL);

    assert.equal(
      decide(agentPayload("planner"), ENV_ON, DEPS_PRESENT).action,
      "none",
    );
  },
);

// ---------------------------------------------------------------------------
// Test 3 — switch off: HARNESS_CODEX_ADVERSARY unset → none
// ---------------------------------------------------------------------------

test(
  "decide: adversary role but HARNESS_CODEX_ADVERSARY unset => action 'none' (switch off, fail-open)",
  async () => {
    const { decide } = await import(MODULE_URL);

    assert.equal(
      decide(agentPayload("adversary"), ENV_OFF, DEPS_PRESENT).action,
      "none",
    );
  },
);

// ---------------------------------------------------------------------------
// Test 4 — module absent: moduleExists returns false → none (no hard dependency)
// ---------------------------------------------------------------------------

test(
  "decide: adversary, switch on, moduleExists returns false => action 'none' (no hard dependency)",
  async () => {
    const { decide } = await import(MODULE_URL);

    assert.equal(
      decide(agentPayload("adversary"), ENV_ON, DEPS_ABSENT).action,
      "none",
    );
  },
);

// ---------------------------------------------------------------------------
// Test 5 — subagent context: agent_id present → none (main-loop only)
// ---------------------------------------------------------------------------

test(
  "decide: payload carries agent_id => action 'none' (main-loop only, skip inside subagent)",
  async () => {
    const { decide } = await import(MODULE_URL);

    const payload = agentPayload("adversary", "/absolute/project/root", {
      agent_id: "ag_abc123",
    });

    assert.equal(decide(payload, ENV_ON, DEPS_PRESENT).action, "none");
  },
);

// ---------------------------------------------------------------------------
// Test 6 — wrong tool: tool_name !== 'Agent' → none
// ---------------------------------------------------------------------------

test(
  "decide: tool_name='Bash' (not Agent), all else enabling => action 'none'",
  async () => {
    const { decide } = await import(MODULE_URL);

    const payload = {
      tool_name: "Bash",
      tool_input: { subagent_type: "adversary" },
      cwd: "/absolute/project/root",
    };

    assert.equal(decide(payload, ENV_ON, DEPS_PRESENT).action, "none");
  },
);

// ---------------------------------------------------------------------------
// Test 7 — eligible eyes: security and plan-reviewer each inject naming their role
// ---------------------------------------------------------------------------

test(
  "decide: subagent_type='security' and 'plan-reviewer' both inject, each names its own role",
  async () => {
    const { decide } = await import(MODULE_URL);

    const rs = decide(agentPayload("security"), ENV_ON, DEPS_PRESENT);
    assert.equal(rs.action, "inject", "security should inject");
    assert.equal(rs.role, "security", "role must be 'security'");

    const rp = decide(agentPayload("plan-reviewer"), ENV_ON, DEPS_PRESENT);
    assert.equal(rp.action, "inject", "plan-reviewer should inject");
    assert.equal(rp.role, "plan-reviewer", "role must be 'plan-reviewer'");
  },
);

// ---------------------------------------------------------------------------
// Test 8 — namespaced role: 'harness:adversary' → bareRole normalizes → inject
// ---------------------------------------------------------------------------

test(
  "decide: subagent_type='harness:adversary' => bareRole normalizes, inject with role 'adversary'",
  async () => {
    const { decide } = await import(MODULE_URL);

    const result = decide(agentPayload("harness:adversary"), ENV_ON, DEPS_PRESENT);

    assert.equal(result.action, "inject");
    assert.equal(result.role, "adversary");
  },
);

// ---------------------------------------------------------------------------
// Test 9 — cwd guard: absent or relative → none, process.cwd() never consulted
// ---------------------------------------------------------------------------

test(
  "decide: payload.cwd absent or relative => action 'none' (cwd guard fail-open); " +
    "moduleExists never receives process.cwd()",
  async () => {
    const { decide } = await import(MODULE_URL);

    const receivedCwds = [];
    const spyDeps = {
      moduleExists: (cwd) => {
        receivedCwds.push(cwd);
        return true; // would inject if cwd guard passed — we verify it never reaches here
      },
    };

    // Case A: cwd absent
    const rAbsent = decide(
      { tool_name: "Agent", tool_input: { subagent_type: "adversary" } },
      ENV_ON,
      spyDeps,
    );
    assert.equal(rAbsent.action, "none", "absent cwd must yield 'none'");

    // Case B: cwd is a relative string
    const rRelative = decide(
      { tool_name: "Agent", tool_input: { subagent_type: "adversary" }, cwd: "relative/path" },
      ENV_ON,
      spyDeps,
    );
    assert.equal(rRelative.action, "none", "relative cwd must yield 'none'");

    // Ensure process.cwd() was never passed to moduleExists (cwd guard must short-circuit before probe)
    for (const cwd of receivedCwds) {
      assert.notEqual(
        cwd,
        process.cwd(),
        "moduleExists must never be called with process.cwd()",
      );
    }
  },
);

// ---------------------------------------------------------------------------
// Test 10 — production seam: processInput with fixture dir containing the module file → inject
// ---------------------------------------------------------------------------

test(
  "processInput (production seam): fixture cwd with cross-family.mjs present, " +
    "HARNESS_CODEX_ADVERSARY=1, eligible role => injects (proves probe reads payload.cwd)",
  async () => {
    const { processInput } = await import(MODULE_URL);

    // Create a fixture directory that mimics a project root with the module file present.
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-nudge-fixture-"));
    try {
      const moduleDir = path.join(
        fixtureDir,
        ".claude",
        "modules",
        "codex-adversary",
        "references",
      );
      fs.mkdirSync(moduleDir, { recursive: true });
      // Empty file is sufficient — the probe only checks existsSync, not the content.
      fs.writeFileSync(path.join(moduleDir, "cross-family.mjs"), "", "utf8");

      const payload = {
        tool_name: "Agent",
        tool_input: { subagent_type: "adversary" },
        cwd: fixtureDir, // absolute path pointing to the fixture
      };

      // Inject env so the test never depends on a real env var.
      const result = processInput(JSON.stringify(payload), {
        env: { HARNESS_CODEX_ADVERSARY: "1" },
      });

      assert.equal(result.exitCode, 0, "exitCode must always be 0");
      assert.ok(result.output !== null, "output must not be null when injection fires");

      const parsed = JSON.parse(result.output);
      assert.ok(parsed.hookSpecificOutput, "hookSpecificOutput must be present");
      assert.equal(
        parsed.hookSpecificOutput.hookEventName,
        "PostToolUse",
        "hookEventName must be 'PostToolUse'",
      );
      assert.ok(
        typeof parsed.hookSpecificOutput.additionalContext === "string" &&
          parsed.hookSpecificOutput.additionalContext.length > 0,
        "additionalContext must be a non-empty string",
      );
      assert.equal(
        parsed.hookSpecificOutput.permissionDecision,
        undefined,
        "permissionDecision must NEVER be emitted",
      );
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  },
);

// ---------------------------------------------------------------------------
// Test 11 — thrown dep: moduleExists throws → exit 0, no output, no permissionDecision
// ---------------------------------------------------------------------------

test(
  "processInput: injected moduleExists throws => exit 0, output null, no permissionDecision " +
    "(thrown-error fail-open, not just the graceful-none branch)",
  async () => {
    const { processInput } = await import(MODULE_URL);

    const payload = agentPayload("adversary");

    const result = processInput(JSON.stringify(payload), {
      env: { HARNESS_CODEX_ADVERSARY: "1" },
      moduleExists: () => {
        throw new Error("simulated moduleExists failure");
      },
    });

    assert.equal(result.exitCode, 0, "exitCode must be 0 even when dep throws");
    assert.equal(
      result.output,
      null,
      "output must be null (no stdout) when dep throws — fail-open",
    );
    // Redundant but explicit: a null output cannot contain permissionDecision.
    // If the implementation mistakenly returned a string, this guards it.
    if (result.output !== null) {
      const parsed = JSON.parse(result.output);
      assert.equal(
        parsed?.hookSpecificOutput?.permissionDecision,
        undefined,
        "permissionDecision must never appear in output",
      );
    }
  },
);

// ---------------------------------------------------------------------------
// Test 13 — tool_input present but null → action 'none', never throws (contract)
// ---------------------------------------------------------------------------

test(
  "decide: tool_input present but null => action 'none' (never throws — contract)",
  async () => {
    const { decide } = await import(MODULE_URL);

    let result;
    assert.doesNotThrow(
      () => {
        result = decide(
          { tool_name: "Agent", tool_input: null, cwd: "/abs" },
          { HARNESS_CODEX_ADVERSARY: "1" },
          { moduleExists: () => true },
        );
      },
      "decide() must never throw when tool_input is present but null",
    );

    assert.deepEqual(result, { action: "none" });
  },
);

// ---------------------------------------------------------------------------
// Test 12 — garbage payload: null / missing tool_input → exit 0, no permissionDecision
// ---------------------------------------------------------------------------

test(
  "processInput: null payload and payload missing tool_input => " +
    "exit 0, output null or output without permissionDecision",
  async () => {
    const { processInput } = await import(MODULE_URL);

    // Subcase A: JSON null
    const r1 = processInput("null");
    assert.equal(r1.exitCode, 0, "exitCode must be 0 for null payload");
    if (r1.output !== null) {
      const p1 = JSON.parse(r1.output);
      assert.equal(
        p1?.hookSpecificOutput?.permissionDecision,
        undefined,
        "permissionDecision must never appear even for null payload",
      );
    }

    // Subcase B: object payload without tool_input (garbage)
    const r2 = processInput(JSON.stringify({ tool_name: "Agent", cwd: "/x" }));
    assert.equal(r2.exitCode, 0, "exitCode must be 0 for garbage payload");
    if (r2.output !== null) {
      const p2 = JSON.parse(r2.output);
      assert.equal(
        p2?.hookSpecificOutput?.permissionDecision,
        undefined,
        "permissionDecision must never appear even for garbage payload",
      );
    }

    // Subcase C: completely malformed JSON
    const r3 = processInput("not-json-at-all");
    assert.equal(r3.exitCode, 0, "exitCode must be 0 for malformed JSON");
    assert.equal(r3.output, null, "output must be null for unparseable stdin");
  },
);
