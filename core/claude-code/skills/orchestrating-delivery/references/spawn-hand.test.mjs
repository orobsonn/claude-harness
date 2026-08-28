#!/usr/bin/env node
/**
 * @description Tests for spawn-hand.mjs — validates that buildSpawnArgs builds the correct
 * argv array (with token excluded) and that dispatchHand correctly wires the child env,
 * sets up the ephemeral CLAUDE_CONFIG_DIR with the Stop hook, tears it down, and scrubs
 * the token from the brief/system-prompt file before writing.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The module under test — will fail to import until implemented (red).
import {
  buildSpawnArgs,
  dispatchHand,
  runLiveDispatch,
  DEFAULT_HAND_TIMEOUT_MS,
  HAND_TIMEOUT_CEILING_MS,
  HAND_BASH_TIMEOUT_MS,
} from "./spawn-hand.mjs";
import { OUTCOME } from "./dispatch-hand.mjs";

// ---------------------------------------------------------------------------
// #ac-2.1 — the hand's own wall-clock timeout must sit BELOW the Bash tool's 600000ms max,
// so the hand self-terminates cleanly before the orchestrator's foreground Bash call is
// SIGKILLed. 540000ms (9 min) leaves 60s headroom. The ceiling is kept == default so a
// per-task override can lower but never raise the wall-clock. HAND_BASH_TIMEOUT_MS is the
// explicit Bash-tool timeout (== 600000, the tool max) and must exceed the hand self-timeout.
// ---------------------------------------------------------------------------
describe("hand timeout ceiling constants (#ac-2.1)", () => {
  it("DEFAULT_HAND_TIMEOUT_MS is below the Bash tool's 600000ms max", () => {
    assert.equal(typeof DEFAULT_HAND_TIMEOUT_MS, "number", "DEFAULT_HAND_TIMEOUT_MS must be a number");
    assert.ok(
      DEFAULT_HAND_TIMEOUT_MS < 600000,
      `DEFAULT_HAND_TIMEOUT_MS must be < 600000ms (Bash tool max) — got ${DEFAULT_HAND_TIMEOUT_MS}`,
    );
    assert.equal(DEFAULT_HAND_TIMEOUT_MS, 540000, "DEFAULT_HAND_TIMEOUT_MS must be 540000ms (9 min, 60s headroom)");
  });

  it("HAND_TIMEOUT_CEILING_MS equals DEFAULT_HAND_TIMEOUT_MS (a plan cannot raise the wall-clock)", () => {
    assert.equal(HAND_TIMEOUT_CEILING_MS, DEFAULT_HAND_TIMEOUT_MS);
  });

  it("HAND_BASH_TIMEOUT_MS is 600000 (Bash tool max) and above the hand self-timeout", () => {
    assert.equal(HAND_BASH_TIMEOUT_MS, 600000, "HAND_BASH_TIMEOUT_MS must be the Bash tool max (600000)");
    assert.ok(
      HAND_BASH_TIMEOUT_MS > DEFAULT_HAND_TIMEOUT_MS,
      "the Bash-tool timeout must exceed the hand's own self-timeout so the hand self-terminates first",
    );
  });
});

// ---------------------------------------------------------------------------
// Locked test 1 — argv shape + token exclusion
// ---------------------------------------------------------------------------
describe("buildSpawnArgs", () => {
  it("contains -p, --allowedTools Read,Write,Edit, --output-format json, resolved model, and does NOT contain the token", () => {
    const token = "secret-ollama-token-abc123";
    const model = "glm-5.2";
    const briefFile = "/tmp/brief.txt";

    const argv = buildSpawnArgs({ model, briefFile });
    const fullString = argv.join(" ");

    // Must contain -p flag
    assert.ok(argv.includes("-p"), "argv must contain '-p'");

    // Must have --allowedTools pair
    const atIndex = argv.indexOf("--allowedTools");
    assert.ok(atIndex !== -1, "argv must contain --allowedTools");
    assert.equal(argv[atIndex + 1], "Read,Write,Edit", "--allowedTools value must be 'Read,Write,Edit'");

    // Must have --output-format json
    const ofIndex = argv.indexOf("--output-format");
    assert.ok(ofIndex !== -1, "argv must contain --output-format");
    assert.equal(argv[ofIndex + 1], "json", "--output-format value must be 'json'");

    // Must have --model with resolved model
    const mIndex = argv.indexOf("--model");
    assert.ok(mIndex !== -1, "argv must contain --model");
    assert.equal(argv[mIndex + 1], model, "--model value must equal the resolved model");

    // Token must NOT appear in argv
    assert.ok(
      !fullString.includes(token),
      "The auth token must NOT appear anywhere in the argv string"
    );
  });
});

// ---------------------------------------------------------------------------
// Locked test 2 — no --bare, no Bash in allowedTools
// ---------------------------------------------------------------------------
describe("buildSpawnArgs no-bare no-bash", () => {
  it("argv contains NO --bare AND allowedTools value contains no 'Bash'", () => {
    const argv = buildSpawnArgs({ model: "glm-5.2", briefFile: "/tmp/brief.txt" });
    const fullString = argv.join(" ");

    // No --bare flag
    assert.ok(!argv.includes("--bare"), "argv must NOT contain '--bare'");
    assert.ok(!fullString.includes("--bare"), "argv joined string must NOT contain '--bare'");

    // allowedTools value must not include Bash
    const atIndex = argv.indexOf("--allowedTools");
    assert.ok(atIndex !== -1, "--allowedTools must be present");
    const allowedToolsValue = argv[atIndex + 1];
    assert.ok(
      !allowedToolsValue.includes("Bash"),
      `allowedTools value '${allowedToolsValue}' must NOT contain 'Bash'`
    );
  });
});

// ---------------------------------------------------------------------------
// Locked test 3a — this spawn layer serves the OLLAMA family only
// ---------------------------------------------------------------------------
describe("dispatchHand hand-family routing", () => {
  const dispatchFor = (model) => ({
    model,
    brief: "do the thing",
    scope_paths: ["core/"],
    allowed_writes: ["core/"],
    locked_test: "core/skills/orchestrating-delivery/references/spawn-hand.test.mjs",
  });
  const run = (model, env) =>
    dispatchHand(dispatchFor(model), {
      spawn: (cmd, args) =>
        args?.includes("--test")
          ? { status: 0, stdout: "# tests 3\n", stderr: "", output: [] }
          : { status: 0, stdout: "", stderr: "", output: [] },
      gitStatus: () => "",
      devVarsContent: "",
      env,
    });

  it("refuses a claude-family rung and names the path that DOES serve it", async () => {
    // haiku/sonnet are legitimate hand rungs — of the family that dispatches with the Agent tool.
    // Spawning them here would need a token and an endpoint that deliberately do not exist.
    for (const model of ["haiku", "sonnet"]) {
      await assert.rejects(
        () => run(model, { OLLAMA_HAND_TOKEN: "t" }),
        /dispatches as an ordinary Agent subagent/,
        `expected ${model} to be routed away from spawn-hand`,
      );
    }
  });

  it("refuses `opus` — not a rung at all (the legacy Claude `tiers` shape)", async () => {
    await assert.rejects(() => run("opus", { OLLAMA_HAND_TOKEN: "t" }), /Claude alias/);
  });

  it("still refuses any id outside BOTH ladders, naming both", async () => {
    await assert.rejects(
      () => run("gpt-oss:120b", { OLLAMA_HAND_TOKEN: "t" }),
      /gemma4(.|\n)*haiku|haiku(.|\n)*gemma4/,
    );
  });
});

// ---------------------------------------------------------------------------
// Locked test 3 — dispatchHand wires child env, creates ephemeral dir, tears it down
// ---------------------------------------------------------------------------
describe("dispatchHand ephemeral dir + child env", () => {
  it("child env has correct ANTHROPIC_BASE_URL and CLAUDE_CONFIG_DIR with Stop hook; dir torn down after run", async () => {
    // Capture what spawn was called with
    let capturedEnv = null;
    let capturedConfigDir = null;

    const fakeSpawn = (cmd, args, opts) => {
      // The dry-run (node --test) must report >=1 collected test so the vacuous-gate guard passes.
      if (args?.includes("--test")) {
        return { status: 0, stdout: "# tests 3\n", stderr: "", output: [] };
      }
      capturedEnv = opts?.env ?? {};
      capturedConfigDir = capturedEnv.CLAUDE_CONFIG_DIR;
      // Return a fake spawnSync-like result
      return { status: 0, stdout: "", stderr: "", output: [] };
    };

    const dispatch = {
      model: "glm-5.2",
      brief: "do the thing",
      shared_context: "no secrets here",
      scope_paths: ["core/"],
      frozen_paths: [],
      allowed_writes: ["core/"],
      locked_test: "core/skills/orchestrating-delivery/references/spawn-hand.test.mjs",
    };

    // Resolve the token via injectable env (never touch process.env)
    const fakeToken = "fake-dispatch-token-xyz";
    const fakeEnv = { ANTHROPIC_AUTH_TOKEN: fakeToken };

    await dispatchHand(dispatch, { spawn: fakeSpawn, gitStatus: () => "", devVarsContent: "", env: fakeEnv });

    // ANTHROPIC_BASE_URL must be https://ollama.com
    assert.equal(
      capturedEnv.ANTHROPIC_BASE_URL,
      "https://ollama.com",
      "child env must have ANTHROPIC_BASE_URL=https://ollama.com"
    );

    // CLAUDE_CONFIG_DIR must have been set
    assert.ok(
      capturedConfigDir,
      "child env must have CLAUDE_CONFIG_DIR set"
    );

    // Settings.json in the ephemeral dir must contain a Stop hook.
    // We capture the file content during spawn (while the dir still exists).
    let capturedSettingsContent = null;
    const fakeSpawnWithSettingsCheck = (cmd, args, opts) => {
      if (args?.includes("--test")) {
        return { status: 0, stdout: "# tests 3\n", stderr: "", output: [] };
      }
      capturedEnv = opts?.env ?? {};
      capturedConfigDir = capturedEnv.CLAUDE_CONFIG_DIR;
      if (capturedConfigDir && existsSync(join(capturedConfigDir, "settings.json"))) {
        capturedSettingsContent = readFileSync(join(capturedConfigDir, "settings.json"), "utf8");
      }
      return { status: 0, stdout: "", stderr: "", output: [] };
    };

    const fakeToken2 = "fake-dispatch-token-xyz2";
    const fakeEnv2 = { ANTHROPIC_AUTH_TOKEN: fakeToken2 };
    let configDirUsed = null;

    await dispatchHand(dispatch, { spawn: fakeSpawnWithSettingsCheck, gitStatus: () => "", devVarsContent: "", env: fakeEnv2 });
    configDirUsed = capturedConfigDir;

    // settings.json must have existed and contain a Stop hook
    assert.ok(capturedSettingsContent, "settings.json must exist in the ephemeral dir during spawn");
    const settings = JSON.parse(capturedSettingsContent);
    assert.ok(settings?.hooks?.Stop, "settings.json must contain a Stop hook entry");

    // After the run, the ephemeral dir must have been torn down
    if (configDirUsed) {
      assert.ok(
        !existsSync(configDirUsed),
        `ephemeral dir ${configDirUsed} must be torn down after the run`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Locked test 3b — .claude.json trust file keyed by the verbatim process.cwd()
// (not a canonicalized/realpath'd form, not the ephemeral tmp dir path) — pins
// that the ephemeral-dir trust dialog is pre-accepted against the real project
// cwd at dispatch time, read directly from disk while the ephemeral dir still
// exists (during the real, non-dry-run spawn call).
// ---------------------------------------------------------------------------
describe("dispatchHand ephemeral .claude.json trust keyed by process.cwd()", () => {
  it("the ephemeral dir's .claude.json exists and deep-equals { projects: { [process.cwd()]: { hasTrustDialogAccepted: true } } }", async () => {
    let capturedClaudeJsonContent = null;

    const fakeSpawn = (cmd, args, opts) => {
      if (args?.includes("--test")) {
        return { status: 0, stdout: "# tests 3\n", stderr: "", output: [] };
      }
      const configDir = opts?.env?.CLAUDE_CONFIG_DIR;
      const claudeJsonPath = join(configDir, ".claude.json");
      if (configDir && existsSync(claudeJsonPath)) {
        capturedClaudeJsonContent = readFileSync(claudeJsonPath, "utf8");
      }
      return { status: 0, stdout: "", stderr: "", output: [] };
    };

    const dispatch = {
      model: "glm-5.2",
      brief: "do the thing",
      shared_context: "no secrets here",
      scope_paths: ["core/"],
      frozen_paths: [],
      allowed_writes: ["core/"],
      locked_test: "core/skills/orchestrating-delivery/references/spawn-hand.test.mjs",
    };

    const fakeToken = "fake-dispatch-token-claudejson";
    const fakeEnv = { ANTHROPIC_AUTH_TOKEN: fakeToken };

    await dispatchHand(dispatch, { spawn: fakeSpawn, gitStatus: () => "", devVarsContent: "", env: fakeEnv });

    assert.ok(
      capturedClaudeJsonContent,
      ".claude.json must exist in the ephemeral dir during the real (non-dry-run) spawn call"
    );

    const parsed = JSON.parse(capturedClaudeJsonContent);
    assert.deepEqual(
      parsed,
      { projects: { [process.cwd()]: { hasTrustDialogAccepted: true } } },
      ".claude.json must deep-equal { projects: { [process.cwd()]: { hasTrustDialogAccepted: true } } }, keyed by the verbatim process.cwd() at dispatch time — NOT a canonicalized/realpath'd form, NOT the ephemeral tmp dir path"
    );
  });
});

// ---------------------------------------------------------------------------
// Locked test 3c — .claude.json trust is scoped to a SINGLE project key (the real
// project cwd) — proves trust can never leak to unrelated projects: not a
// wildcard, not the ephemeral tmp dir path, not a parent path.
// ---------------------------------------------------------------------------
describe("dispatchHand ephemeral .claude.json trust is scoped to a single project key", () => {
  it("Object.keys(parsed) equals ['projects'] and Object.keys(parsed.projects) equals [process.cwd()]", async () => {
    let capturedClaudeJsonContent = null;

    const fakeSpawn = (cmd, args, opts) => {
      if (args?.includes("--test")) {
        return { status: 0, stdout: "# tests 3\n", stderr: "", output: [] };
      }
      const configDir = opts?.env?.CLAUDE_CONFIG_DIR;
      const claudeJsonPath = join(configDir, ".claude.json");
      if (configDir && existsSync(claudeJsonPath)) {
        capturedClaudeJsonContent = readFileSync(claudeJsonPath, "utf8");
      }
      return { status: 0, stdout: "", stderr: "", output: [] };
    };

    const dispatch = {
      model: "glm-5.2",
      brief: "do the thing",
      shared_context: "no secrets here",
      scope_paths: ["core/"],
      frozen_paths: [],
      allowed_writes: ["core/"],
      locked_test: "core/skills/orchestrating-delivery/references/spawn-hand.test.mjs",
    };

    const fakeToken = "fake-dispatch-token-claudejson-shape";
    const fakeEnv = { ANTHROPIC_AUTH_TOKEN: fakeToken };

    await dispatchHand(dispatch, { spawn: fakeSpawn, gitStatus: () => "", devVarsContent: "", env: fakeEnv });

    assert.ok(
      capturedClaudeJsonContent,
      ".claude.json must exist in the ephemeral dir during the real (non-dry-run) spawn call"
    );

    const parsed = JSON.parse(capturedClaudeJsonContent);
    assert.deepEqual(
      Object.keys(parsed),
      ["projects"],
      "the top-level shape must be exactly { projects: ... } — a single key"
    );
    assert.deepEqual(
      Object.keys(parsed.projects),
      [process.cwd()],
      "projects must carry exactly one key — the verbatim process.cwd() — never a wildcard, the ephemeral tmp dir, or a parent path"
    );
  });
});

// ---------------------------------------------------------------------------
// Locked test 4 — brief/system-prompt file has ZERO occurrences of the token
// ---------------------------------------------------------------------------

describe("dispatchHand brief scrubbing", () => {
  it("the brief/system-prompt file written to disk contains ZERO occurrences of the token", async () => {
    const secretToken = "super-secret-token-SHOULD-NOT-APPEAR-9999";
    let capturedBriefPath = null;
    let briefContentOnDisk = null;

    const fakeSpawn = (cmd, args, opts) => {
      if (args?.includes("--test")) {
        return { status: 0, stdout: "# tests 3\n", stderr: "", output: [] };
      }
      // Find the --append-system-prompt-file argument to get the brief path
      const apfIndex = args.indexOf("--append-system-prompt-file");
      if (apfIndex !== -1) {
        capturedBriefPath = args[apfIndex + 1];
        if (capturedBriefPath && existsSync(capturedBriefPath)) {
          briefContentOnDisk = readFileSync(capturedBriefPath, "utf8");
        }
      }
      return { status: 0, stdout: "", stderr: "", output: [] };
    };

    const dispatch = {
      model: "glm-5.2",
      brief: `This is the brief. Token should not appear: ${secretToken}`,
      shared_context: `Shared context also contains: ${secretToken}`,
      scope_paths: ["core/"],
      frozen_paths: [],
      allowed_writes: ["core/"],
      locked_test: "core/skills/orchestrating-delivery/references/spawn-hand.test.mjs",
    };

    // Inject token via env (never touch process.env)
    const fakeEnv = { ANTHROPIC_AUTH_TOKEN: secretToken };

    await dispatchHand(dispatch, { spawn: fakeSpawn, gitStatus: () => "", devVarsContent: "", env: fakeEnv });

    assert.ok(
      capturedBriefPath !== null,
      "spawn must have received --append-system-prompt-file argument"
    );

    assert.ok(
      briefContentOnDisk !== null,
      "brief file must exist and be readable during spawn"
    );

    // Count occurrences of token in the written file
    const tokenOccurrences = briefContentOnDisk.split(secretToken).length - 1;
    assert.equal(
      tokenOccurrences,
      0,
      `brief file must contain ZERO occurrences of the token; found ${tokenOccurrences}`
    );
  });
});

// ---------------------------------------------------------------------------
// Locked test 4b — the scrubbed brief reaches the child STDIN (the USER prompt)
// and the auth token is NOT present in stdin (proven live: without a user turn
// `claude -p` exits 1 and the hand does nothing).
// ---------------------------------------------------------------------------
describe("dispatchHand delivers the brief via child stdin", () => {
  it("spawn opts.input carries the brief text (user prompt) and does NOT contain the token", async () => {
    const secretToken = "stdin-secret-token-MUST-NOT-LEAK-4242";
    const briefText = "Create out.txt with hello";
    let capturedInput = null;

    const fakeSpawn = (cmd, args, opts) => {
      if (args?.includes("--test")) {
        return { status: 0, stdout: "# tests 3\n", stderr: "", output: [] };
      }
      capturedInput = opts?.input ?? null;
      return { status: 0, stdout: "", stderr: "", output: [] };
    };

    const dispatch = {
      model: "glm-5.2",
      brief: briefText,
      shared_context: "no secrets here",
      scope_paths: ["core/"],
      frozen_paths: [],
      allowed_writes: ["core/"],
      locked_test: "core/skills/orchestrating-delivery/references/spawn-hand.test.mjs",
    };

    const fakeEnv = { ANTHROPIC_AUTH_TOKEN: secretToken };

    await dispatchHand(dispatch, { spawn: fakeSpawn, gitStatus: () => "", devVarsContent: "", env: fakeEnv });

    assert.ok(
      capturedInput !== null,
      "spawn must receive opts.input (the brief delivered to the child stdin as the user prompt)"
    );
    const capturedInputStr = capturedInput instanceof Buffer ? capturedInput.toString("utf8") : String(capturedInput);
    assert.ok(
      capturedInputStr.includes(briefText),
      "opts.input must contain the brief text so the hand has a user turn and acts"
    );
    assert.ok(
      !capturedInputStr.includes(secretToken),
      "opts.input (child stdin) must NOT contain the auth token — it is scrubbed before reaching stdin"
    );
  });
});

// ---------------------------------------------------------------------------
// Locked test 5 — FAIL CLOSED when locked_test is missing (no armed gate)
// ---------------------------------------------------------------------------
describe("dispatchHand fail-closed without locked_test", () => {
  it("throws and does NOT spawn when locked_test is empty/missing", async () => {
    let spawnCalled = false;
    const fakeSpawn = () => {
      spawnCalled = true;
      return { status: 0, stdout: "", stderr: "", output: [] };
    };

    const dispatch = {
      model: "glm-5.2",
      brief: "do the thing",
      shared_context: "no secrets",
      scope_paths: ["core/"],
      frozen_paths: [],
      allowed_writes: ["core/"],
      // locked_test intentionally absent
    };

    const fakeEnv = { ANTHROPIC_AUTH_TOKEN: "fake-token" };

    await assert.rejects(
      () => dispatchHand(dispatch, { spawn: fakeSpawn, devVarsContent: "", env: fakeEnv }),
      /locked_test is required/,
      "dispatchHand must throw when locked_test is missing"
    );

    assert.equal(spawnCalled, false, "spawn must NOT be called when the gate is unarmed");
  });
});

// ---------------------------------------------------------------------------
// Locked test 6 — armed gate: written settings.json carries the resolved test
// path, NOT the placeholder
// ---------------------------------------------------------------------------
describe("dispatchHand arms the Stop-hook gate", () => {
  it("written settings.json command contains the resolved test path and NOT the placeholder", async () => {
    let capturedCommand = null;

    const fakeSpawn = (cmd, args, opts) => {
      if (args?.includes("--test")) {
        return { status: 0, stdout: "# tests 3\n", stderr: "", output: [] };
      }
      const configDir = opts?.env?.CLAUDE_CONFIG_DIR;
      if (configDir && existsSync(join(configDir, "settings.json"))) {
        const settings = JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8"));
        capturedCommand = settings?.hooks?.Stop?.[0]?.hooks?.[0]?.command ?? null;
      }
      return { status: 0, stdout: "", stderr: "", output: [] };
    };

    const lockedTest = "core/skills/orchestrating-delivery/references/spawn-hand.test.mjs";
    const dispatch = {
      model: "glm-5.2",
      brief: "do the thing",
      shared_context: "no secrets",
      scope_paths: ["core/"],
      frozen_paths: [],
      allowed_writes: ["core/"],
      locked_test: lockedTest,
    };

    const fakeEnv = { ANTHROPIC_AUTH_TOKEN: "fake-token" };

    await dispatchHand(dispatch, { spawn: fakeSpawn, gitStatus: () => "", devVarsContent: "", env: fakeEnv });

    assert.ok(capturedCommand, "settings.json must carry a Stop-hook command during spawn");
    assert.ok(
      !capturedCommand.includes("PLACEHOLDER_FROZEN_TEST_PATH"),
      "Stop-hook command must NOT contain the placeholder substring"
    );
    assert.ok(
      capturedCommand.includes(lockedTest),
      "Stop-hook command must contain the resolved locked_test path"
    );
  });
});

// ---------------------------------------------------------------------------
// Locked test 7 — FAIL CLOSED when locked_test points at a NON-EXISTENT file
// (an "armed" gate over a missing test = `node --test <missing>` exits 0 = unarmed)
// ---------------------------------------------------------------------------
describe("dispatchHand fail-closed when locked_test file does not exist", () => {
  it("throws and does NOT spawn when locked_test resolves to a missing file", async () => {
    let spawnCalled = false;
    const fakeSpawn = () => {
      spawnCalled = true;
      return { status: 0, stdout: "", stderr: "", output: [] };
    };

    const dispatch = {
      model: "glm-5.2",
      brief: "do the thing",
      shared_context: "no secrets",
      scope_paths: ["core/"],
      frozen_paths: [],
      allowed_writes: ["core/"],
      locked_test: "core/does-not-exist.test.mjs",
    };

    const fakeEnv = { ANTHROPIC_AUTH_TOKEN: "fake-token" };

    await assert.rejects(
      () => dispatchHand(dispatch, { spawn: fakeSpawn, gitStatus: () => "", devVarsContent: "", env: fakeEnv }),
      /does not exist|gate cannot block/,
      "dispatchHand must throw when the locked_test file does not exist"
    );

    assert.equal(spawnCalled, false, "spawn must NOT be called when the gated test file is missing");
  });
});

// ---------------------------------------------------------------------------
// Locked test 8 — FAIL CLOSED when locked_test resolves to a DIRECTORY
// (`node --test <dir>` exits 0 = vacuous gate)
// ---------------------------------------------------------------------------
describe("dispatchHand fail-closed when locked_test is a directory", () => {
  it("throws /must be a file/ and does NOT spawn when locked_test is a directory", async () => {
    let spawnCalled = false;
    const fakeSpawn = (cmd, args) => {
      if (args?.includes("--test")) {
        return { status: 0, stdout: "# tests 3\n", stderr: "", output: [] };
      }
      spawnCalled = true;
      return { status: 0, stdout: "", stderr: "", output: [] };
    };

    const dispatch = {
      model: "glm-5.2",
      brief: "do the thing",
      shared_context: "no secrets",
      scope_paths: ["core/"],
      frozen_paths: [],
      allowed_writes: ["core/"],
      // An existing DIRECTORY, not a file — node --test would exit 0 vacuously.
      locked_test: "core/skills/orchestrating-delivery/references/hand-config",
    };

    const fakeEnv = { ANTHROPIC_AUTH_TOKEN: "fake-token" };

    await assert.rejects(
      () => dispatchHand(dispatch, { spawn: fakeSpawn, gitStatus: () => "", devVarsContent: "", env: fakeEnv }),
      /must be a file/,
      "dispatchHand must throw when locked_test is a directory"
    );

    assert.equal(spawnCalled, false, "spawn must NOT be called when the gated path is a directory");
  });
});

// ---------------------------------------------------------------------------
// Locked test 9 — FAIL CLOSED when the frozen test registers ZERO tests
// (dry-run reports `# tests 0` → vacuous gate)
// ---------------------------------------------------------------------------
describe("dispatchHand fail-closed when locked_test registers zero tests", () => {
  it("throws /zero tests|vacuous/ and does NOT dispatch when the dry-run reports # tests 0", async () => {
    let dispatchSpawnCalled = false;
    const fakeSpawn = (cmd, args) => {
      // Simulate a frozen test file that collects NO tests.
      if (args?.includes("--test")) {
        return { status: 0, stdout: "# tests 0\n", stderr: "", output: [] };
      }
      dispatchSpawnCalled = true;
      return { status: 0, stdout: "", stderr: "", output: [] };
    };

    const dispatch = {
      model: "glm-5.2",
      brief: "do the thing",
      shared_context: "no secrets",
      scope_paths: ["core/"],
      frozen_paths: [],
      allowed_writes: ["core/"],
      // An existing FILE (passes the isFile guard) whose dry-run reports zero tests.
      locked_test: "core/skills/orchestrating-delivery/references/spawn-hand.test.mjs",
    };

    const fakeEnv = { ANTHROPIC_AUTH_TOKEN: "fake-token" };

    await assert.rejects(
      () => dispatchHand(dispatch, { spawn: fakeSpawn, gitStatus: () => "", devVarsContent: "", env: fakeEnv }),
      /zero tests|vacuous/,
      "dispatchHand must throw when the frozen test registers zero tests"
    );

    assert.equal(
      dispatchSpawnCalled,
      false,
      "the real dispatch spawn must NOT be called when the gate is vacuous"
    );
  });

  // Fix A: the vacuous-gate reason must NAME the correct recovery (scaffold stub INSIDE the freeze
  // commit, exporting the test's import surface) so the orchestrator does not commit the stub AFTER
  // the freeze and diverge HEAD (the M5 retry-storm root cause).
  it("names the scaffold-in-freeze recovery in the vacuous-gate reason", async () => {
    const fakeSpawn = (cmd, args) => {
      if (args?.includes("--test")) return { status: 0, stdout: "# tests 0\n", stderr: "", output: [] };
      return { status: 0, stdout: "", stderr: "", output: [] };
    };
    const dispatch = {
      model: "glm-5.2",
      brief: "do the thing",
      shared_context: "no secrets",
      scope_paths: ["core/"],
      frozen_paths: [],
      allowed_writes: ["core/"],
      locked_test: "core/skills/orchestrating-delivery/references/spawn-hand.test.mjs",
    };
    const fakeEnv = { ANTHROPIC_AUTH_TOKEN: "fake-token" };

    let caught;
    try {
      await dispatchHand(dispatch, { spawn: fakeSpawn, gitStatus: () => "", devVarsContent: "", env: fakeEnv });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, "must throw on a vacuous gate");
    assert.match(caught.message, /stub/i, "reason must name the scaffold stub recovery");
    assert.match(caught.message, /freeze/i, "reason must say the stub goes inside the freeze commit");
    assert.match(caught.message, /diverge/i, "reason must warn that committing after the freeze diverges HEAD");
  });
});

// ---------------------------------------------------------------------------
// Locked test 9b — dispatch.test_runner selects the dry-run adapter (never hardcoded node --test)
// ---------------------------------------------------------------------------
describe("dispatchHand dry-run honors dispatch.test_runner", () => {
  it("dry-runs the vitest adapter's command (npx vitest run --reporter=json) instead of node --test", async () => {
    let dryRunCmd = null;
    let dryRunArgs = null;
    const fakeSpawn = (cmd, args) => {
      if (args?.includes("vitest")) {
        dryRunCmd = cmd;
        dryRunArgs = args;
        return { status: 0, stdout: JSON.stringify({ numTotalTests: 4 }), stderr: "", output: [] };
      }
      return { status: 0, stdout: "", stderr: "", output: [] };
    };

    const dispatch = {
      model: "glm-5.2",
      brief: "do the thing",
      shared_context: "no secrets",
      scope_paths: ["core/"],
      frozen_paths: [],
      allowed_writes: ["core/"],
      locked_test: "core/skills/orchestrating-delivery/references/spawn-hand.test.mjs",
      test_runner: "vitest",
    };
    const fakeEnv = { ANTHROPIC_AUTH_TOKEN: "fake-token" };

    await dispatchHand(dispatch, { spawn: fakeSpawn, gitStatus: () => "", devVarsContent: "", env: fakeEnv });

    assert.equal(dryRunCmd, "npx");
    assert.ok(dryRunArgs.includes("--reporter=json"));
    assert.ok(!dryRunArgs.includes("--test"));
  });

  it("still fails closed on a vitest dry-run reporting zero tests", async () => {
    const fakeSpawn = (cmd, args) => {
      if (args?.includes("vitest")) {
        return { status: 0, stdout: JSON.stringify({ numTotalTests: 0 }), stderr: "", output: [] };
      }
      return { status: 0, stdout: "", stderr: "", output: [] };
    };
    const dispatch = {
      model: "glm-5.2",
      brief: "do the thing",
      shared_context: "no secrets",
      scope_paths: ["core/"],
      frozen_paths: [],
      allowed_writes: ["core/"],
      locked_test: "core/skills/orchestrating-delivery/references/spawn-hand.test.mjs",
      test_runner: "vitest",
    };
    const fakeEnv = { ANTHROPIC_AUTH_TOKEN: "fake-token" };

    await assert.rejects(
      () => dispatchHand(dispatch, { spawn: fakeSpawn, gitStatus: () => "", devVarsContent: "", env: fakeEnv }),
      /zero tests|vacuous/
    );
  });
});

// ---------------------------------------------------------------------------
// Locked test 10 — CODE-enforced clean baseline before the hand spawns
// (a dirty tree would misattribute pre-existing edits to the hand)
// ---------------------------------------------------------------------------
describe("dispatchHand enforces a clean baseline before spawn", () => {
  const lockedTest = "core/skills/orchestrating-delivery/references/spawn-hand.test.mjs";
  const scopedPaths = ["core/x/foo.ts"];
  const baseDispatch = {
    model: "glm-5.2",
    brief: "do the thing",
    shared_context: "no secrets",
    scope_paths: scopedPaths,
    frozen_paths: [],
    allowed_writes: ["core/"],
    locked_test: lockedTest,
  };
  const fakeEnv = { ANTHROPIC_AUTH_TOKEN: "fake-token" };

  it("proceeds (spawn called) when gitStatus reports a CLEAN in-scope tree", async () => {
    let dispatchSpawnCalled = false;
    const fakeSpawn = (cmd, args) => {
      if (args?.includes("--test")) {
        return { status: 0, stdout: "# tests 3\n", stderr: "", output: [] };
      }
      dispatchSpawnCalled = true;
      return { status: 0, stdout: "", stderr: "", output: [] };
    };

    await dispatchHand(baseDispatch, {
      spawn: fakeSpawn,
      gitStatus: () => "",
      devVarsContent: "",
      env: fakeEnv,
    });

    assert.equal(dispatchSpawnCalled, true, "spawn must be called on a clean in-scope baseline");
  });

  it("proceeds (no-op) when scope_paths is omitted — the guard cannot meaningfully scope", async () => {
    let dispatchSpawnCalled = false;
    let gitStatusArg;
    const fakeSpawn = (cmd, args) => {
      if (args?.includes("--test")) {
        return { status: 0, stdout: "# tests 3\n", stderr: "", output: [] };
      }
      dispatchSpawnCalled = true;
      return { status: 0, stdout: "", stderr: "", output: [] };
    };

    // Real-ish fake: returns "" for an empty/omitted scope (no-op safety).
    const fakeGitStatus = (scopePaths = []) => {
      gitStatusArg = scopePaths;
      return scopePaths.length ? " M something\n" : "";
    };

    // dispatch WITHOUT scope_paths → the guard passes empty array → "" → proceed.
    const { scope_paths, ...noScopeDispatch } = baseDispatch;

    await dispatchHand(noScopeDispatch, {
      spawn: fakeSpawn,
      gitStatus: fakeGitStatus,
      devVarsContent: "",
      env: fakeEnv,
    });

    assert.deepEqual(gitStatusArg, [], "the guard must receive an empty array when scope_paths is omitted");
    assert.equal(dispatchSpawnCalled, true, "spawn must be called when there is no scope to check");
  });

  it("throws /dirty baseline|already dirty/ and does NOT spawn when an IN-SCOPE path is DIRTY", async () => {
    let spawnCalled = false;
    let gitStatusArg;
    const fakeSpawn = (cmd, args) => {
      if (args?.includes("--test")) {
        return { status: 0, stdout: "# tests 3\n", stderr: "", output: [] };
      }
      spawnCalled = true;
      return { status: 0, stdout: "", stderr: "", output: [] };
    };

    // The guard must be scoped: it returns dirt only because the in-scope path is dirty.
    const fakeGitStatus = (scopePaths = []) => {
      gitStatusArg = scopePaths;
      return " M core/x/foo.ts\n";
    };

    await assert.rejects(
      () => dispatchHand(baseDispatch, {
        spawn: fakeSpawn,
        gitStatus: fakeGitStatus,
        devVarsContent: "",
        env: fakeEnv,
      }),
      /dirty baseline|already dirty/,
      "dispatchHand must throw when an in-scope path is dirty"
    );

    assert.deepEqual(gitStatusArg, scopedPaths, "the guard must be called with the dispatch's scope_paths");
    assert.equal(spawnCalled, false, "spawn must NOT be called when the in-scope baseline is dirty");
  });
});

// ---------------------------------------------------------------------------
// Locked test 11 — FAIL CLOSED on an undefined token (parity with captureResult)
// ---------------------------------------------------------------------------
describe("dispatchHand fail-closed on undefined auth token", () => {
  it("throws naming the family's token key and does NOT spawn when no token resolves", async () => {
    let spawnCalled = false;
    const fakeSpawn = (cmd, args) => {
      if (args?.includes("--test")) {
        return { status: 0, stdout: "# tests 3\n", stderr: "", output: [] };
      }
      spawnCalled = true;
      return { status: 0, stdout: "", stderr: "", output: [] };
    };

    const dispatch = {
      model: "glm-5.2",
      brief: "do the thing",
      shared_context: "no secrets",
      scope_paths: ["core/"],
      frozen_paths: [],
      allowed_writes: ["core/"],
      locked_test: "core/skills/orchestrating-delivery/references/spawn-hand.test.mjs",
    };

    // env WITHOUT ANTHROPIC_AUTH_TOKEN + empty devVarsContent → no token resolves.
    const fakeEnv = {};

    await assert.rejects(
      () => dispatchHand(dispatch, {
        spawn: fakeSpawn,
        gitStatus: () => "",
        devVarsContent: "",
        env: fakeEnv,
      }),
      /no OLLAMA_HAND_TOKEN resolved/,
      "dispatchHand must throw when no auth token resolves"
    );

    assert.equal(spawnCalled, false, "spawn must NOT be called when no token resolves");
  });
});

// ---------------------------------------------------------------------------
// Locked test 12 — #ac-1.1 wall-clock timeout: dispatchHand RETURNS a timeout
// descriptor instead of throwing when the injected spawn reports a timeout-shaped
// result (status: null, signal: SIGKILL, error.code: ETIMEDOUT).
// ---------------------------------------------------------------------------
describe("dispatchHand wall-clock timeout — returns not throws (#ac-1.1)", () => {
  it("returns { timedOut: true, timeoutMs > 0, exitCode !== 0 } and does not throw when spawn returns a timeout-shaped result", async () => {
    const fakeSpawn = (cmd, args) => {
      if (args?.includes("--test")) {
        return { status: 0, stdout: "# tests 3\n", stderr: "", output: [] };
      }
      return { status: null, signal: "SIGKILL", error: { code: "ETIMEDOUT" }, stdout: "", stderr: "" };
    };

    const dispatch = {
      model: "glm-5.2",
      brief: "do the thing",
      shared_context: "no secrets",
      scope_paths: ["core/"],
      frozen_paths: [],
      allowed_writes: ["core/"],
      locked_test: "core/skills/orchestrating-delivery/references/spawn-hand.test.mjs",
    };
    const fakeEnv = { ANTHROPIC_AUTH_TOKEN: "fake-token" };

    const result = await dispatchHand(dispatch, {
      spawn: fakeSpawn,
      gitStatus: () => "",
      devVarsContent: "",
      env: fakeEnv,
    });

    assert.equal(result.timedOut, true, "result.timedOut must be true on a timeout-shaped spawn result");
    assert.ok(
      typeof result.timeoutMs === "number" && result.timeoutMs > 0,
      "result.timeoutMs must be a positive number"
    );
    assert.notEqual(result.exitCode, 0, "result.exitCode must be non-zero on a timeout");
  });
});

// ---------------------------------------------------------------------------
// Locked test 13 — #ac-1.1 the LIVE hand spawn call carries the timeout + killSignal.
// ---------------------------------------------------------------------------
describe("dispatchHand wall-clock timeout — live spawn opts carry timeout+killSignal (#ac-1.1)", () => {
  it("the LIVE hand spawn call's opts.timeout is a positive number and opts.killSignal === 'SIGKILL'", async () => {
    let liveOpts = null;
    const fakeSpawn = (cmd, args, opts) => {
      if (args?.includes("--test")) {
        return { status: 0, stdout: "# tests 3\n", stderr: "", output: [] };
      }
      liveOpts = opts;
      return { status: 0, stdout: "", stderr: "", output: [] };
    };

    const dispatch = {
      model: "glm-5.2",
      brief: "do the thing",
      shared_context: "no secrets",
      scope_paths: ["core/"],
      frozen_paths: [],
      allowed_writes: ["core/"],
      locked_test: "core/skills/orchestrating-delivery/references/spawn-hand.test.mjs",
    };
    const fakeEnv = { ANTHROPIC_AUTH_TOKEN: "fake-token" };

    await dispatchHand(dispatch, { spawn: fakeSpawn, gitStatus: () => "", devVarsContent: "", env: fakeEnv });

    assert.ok(liveOpts, "the live (non-dry-run) spawn call must have been captured");
    assert.ok(
      typeof liveOpts.timeout === "number" && liveOpts.timeout > 0,
      "the live spawn call's opts.timeout must be a positive number"
    );
    assert.equal(liveOpts.killSignal, "SIGKILL", "the live spawn call's opts.killSignal must be 'SIGKILL'");
  });
});

// ---------------------------------------------------------------------------
// Locked test 14 — #ac-1.1 / C5 the --test dry-run probe carries NO timeout — the
// timeout is scoped to the live hand spawn only.
// ---------------------------------------------------------------------------
describe("dispatchHand wall-clock timeout — dry-run probe has NO timeout (#ac-1.1, C5)", () => {
  it("the --test dry-run probe call's opts.timeout is undefined (no timeout/killSignal on the dry-run)", async () => {
    let dryRunOpts = null;
    const fakeSpawn = (cmd, args, opts) => {
      if (args?.includes("--test")) {
        dryRunOpts = opts;
        return { status: 0, stdout: "# tests 3\n", stderr: "", output: [] };
      }
      return { status: 0, stdout: "", stderr: "", output: [] };
    };

    const dispatch = {
      model: "glm-5.2",
      brief: "do the thing",
      shared_context: "no secrets",
      scope_paths: ["core/"],
      frozen_paths: [],
      allowed_writes: ["core/"],
      locked_test: "core/skills/orchestrating-delivery/references/spawn-hand.test.mjs",
    };
    const fakeEnv = { ANTHROPIC_AUTH_TOKEN: "fake-token" };

    await dispatchHand(dispatch, { spawn: fakeSpawn, gitStatus: () => "", devVarsContent: "", env: fakeEnv });

    assert.ok(dryRunOpts, "the --test dry-run probe call must have been captured");
    assert.equal(
      dryRunOpts.timeout,
      undefined,
      "the --test dry-run probe call must NOT carry an opts.timeout — the timeout is scoped to the live hand spawn only"
    );
    assert.equal(
      dryRunOpts.killSignal,
      undefined,
      "the --test dry-run probe call must NOT carry an opts.killSignal"
    );
  });
});

// ---------------------------------------------------------------------------
// Locked test 15 — #ac-1.1 / C4 / C7 dispatch.timeout_ms overrides the live-spawn
// timeout, and the DEFAULT_HAND_TIMEOUT_MS (540000ms) is used when omitted.
// ---------------------------------------------------------------------------
describe("dispatchHand wall-clock timeout — timeout_ms override + default (#ac-1.1, C4/C7)", () => {
  it("honors dispatch.timeout_ms when present, and defaults to 540000ms otherwise", async () => {
    let liveOptsOverride = null;
    const fakeSpawnOverride = (cmd, args, opts) => {
      if (args?.includes("--test")) {
        return { status: 0, stdout: "# tests 3\n", stderr: "", output: [] };
      }
      liveOptsOverride = opts;
      return { status: 0, stdout: "", stderr: "", output: [] };
    };

    const dispatchWithOverride = {
      model: "glm-5.2",
      brief: "do the thing",
      shared_context: "no secrets",
      scope_paths: ["core/"],
      frozen_paths: [],
      allowed_writes: ["core/"],
      locked_test: "core/skills/orchestrating-delivery/references/spawn-hand.test.mjs",
      timeout_ms: 12345,
    };
    const fakeEnv = { ANTHROPIC_AUTH_TOKEN: "fake-token" };

    await dispatchHand(dispatchWithOverride, {
      spawn: fakeSpawnOverride,
      gitStatus: () => "",
      devVarsContent: "",
      env: fakeEnv,
    });

    assert.ok(liveOptsOverride, "the live spawn call must have been captured for the override case");
    assert.equal(
      liveOptsOverride.timeout,
      12345,
      "opts.timeout must equal the dispatch's timeout_ms override"
    );

    let liveOptsDefault = null;
    const fakeSpawnDefault = (cmd, args, opts) => {
      if (args?.includes("--test")) {
        return { status: 0, stdout: "# tests 3\n", stderr: "", output: [] };
      }
      liveOptsDefault = opts;
      return { status: 0, stdout: "", stderr: "", output: [] };
    };

    const dispatchNoOverride = {
      model: "glm-5.2",
      brief: "do the thing",
      shared_context: "no secrets",
      scope_paths: ["core/"],
      frozen_paths: [],
      allowed_writes: ["core/"],
      locked_test: "core/skills/orchestrating-delivery/references/spawn-hand.test.mjs",
      // timeout_ms intentionally omitted
    };

    await dispatchHand(dispatchNoOverride, {
      spawn: fakeSpawnDefault,
      gitStatus: () => "",
      devVarsContent: "",
      env: fakeEnv,
    });

    assert.ok(liveOptsDefault, "the live spawn call must have been captured for the default case");
    assert.equal(
      liveOptsDefault.timeout,
      540000,
      "opts.timeout must default to DEFAULT_HAND_TIMEOUT_MS (540000ms) when timeout_ms is omitted"
    );
  });
});

// ---------------------------------------------------------------------------
// Locked test — #ac-1.1 the per-task timeout_ms override is clamped to the 540000ms
// ceiling — a plan cannot smuggle an unbounded wait past the hand's timeout envelope.
// ---------------------------------------------------------------------------
describe("dispatchHand wall-clock timeout — timeout_ms is clamped to the 540000ms ceiling (#ac-1.1)", () => {
  it("clamps an over-ceiling dispatch.timeout_ms down to 540000ms", async () => {
    let liveOpts = null;
    const fakeSpawn = (cmd, args, opts) => {
      if (args?.includes("--test")) {
        return { status: 0, stdout: "# tests 3\n", stderr: "", output: [] };
      }
      liveOpts = opts;
      return { status: 0, stdout: "", stderr: "", output: [] };
    };

    const dispatch = {
      model: "glm-5.2",
      brief: "do the thing",
      shared_context: "no secrets",
      scope_paths: ["core/"],
      frozen_paths: [],
      allowed_writes: ["core/"],
      locked_test: "core/skills/orchestrating-delivery/references/spawn-hand.test.mjs",
      timeout_ms: 1_800_000, // over the 540000ms ceiling
    };
    const fakeEnv = { ANTHROPIC_AUTH_TOKEN: "fake-token" };

    await dispatchHand(dispatch, { spawn: fakeSpawn, gitStatus: () => "", devVarsContent: "", env: fakeEnv });

    assert.ok(liveOpts, "the live spawn call must have been captured");
    assert.equal(
      liveOpts.timeout,
      540000,
      "an over-ceiling dispatch.timeout_ms must be clamped down to the 540000ms ceiling"
    );
  });
});

// ---------------------------------------------------------------------------
// Locked test 16 — #ac-1.2 salvage-hang two-pronged DONE→FAILED. The IDENTICAL
// DONE-scoring capture fixture must reach DONE under a normal spawn (CONTROL) and
// flip to FAILED with timedOut:true under a timeout-shaped spawn (TIMEOUT) — proving
// the timeout override actually flips a genuine DONE, not a mere relabel of a
// non-DONE run.
// ---------------------------------------------------------------------------
describe("runLiveDispatch wall-clock timeout — salvage-hang capture-then-classify (#ac-1.2/#ac-1.4)", () => {
  const featureId = "hand-wallclock-timeout";
  const taskId = "task-1";
  const lockedTest = "core/skills/orchestrating-delivery/references/spawn-hand.test.mjs";

  function makeDoneFixtureCapture() {
    return () => ({
      child: {
        captured: true,
        touchedPaths: ["core/x/foo.ts"],
        exitCode: 1,
        lockedTestExitCode: 0,
        stdout: "",
        stderr: "count_tokens endpoint 404 not found",
      },
      captured: true,
      criticalException: false,
    });
  }

  function makeRedFixtureCapture() {
    return () => ({
      child: {
        captured: true,
        touchedPaths: ["core/x/foo.ts"],
        exitCode: 1,
        lockedTestExitCode: 1,
        stdout: "",
        stderr: "locked_test failed",
      },
      captured: true,
      criticalException: false,
    });
  }

  it("CONTROL — a non-timeout spawn reaches outcome.status === OUTCOME.DONE and does not throw", async () => {
    const briefDir = mkdtempSync(join(tmpdir(), "hand-brief-"));
    const briefFile = join(briefDir, "brief.txt");
    writeFileSync(briefFile, "Create out.txt with hello", "utf8");
    const stateDir = mkdtempSync(join(tmpdir(), "hand-state-"));

    const freezeCommitSha = "fake0000000000000000000000000000000abc";
    const descriptor = {
      feature_id: featureId,
      task_id: taskId,
      role: "executor",
      model: "glm-5.2",
      brief_file: briefFile,
      locked_test: lockedTest,
      freeze_commit_sha: freezeCommitSha,
      scope_paths: ["core/"],
      allowed_writes: ["core/"],
    };

    const fakeSpawn = (cmd, args) => {
      if (args?.includes("--test")) {
        return { status: 0, stdout: "# tests 3\n", stderr: "", output: [] };
      }
      return { status: 0, stdout: "", stderr: "", output: [] };
    };

    let capturedRecord = null;
    const fakeWriteRecord = (path, content) => {
      capturedRecord = JSON.parse(content);
    };
    const fakeEnv = { ANTHROPIC_AUTH_TOKEN: "fake-token" };

    const result = await runLiveDispatch(descriptor, {
      spawn: fakeSpawn,
      env: fakeEnv,
      gitStatus: () => "",
      headSha: () => freezeCommitSha,
      snapshotUntracked: () => new Map(),
      capture: makeDoneFixtureCapture(),
      writeRecord: fakeWriteRecord,
      stateDir,
    });

    assert.ok(capturedRecord, "writeRecord must have been called with a record");
    assert.equal(
      capturedRecord.outcome.status,
      OUTCOME.DONE,
      "CONTROL prong: the DONE-scoring fixture must genuinely reach DONE"
    );
    assert.equal(result.outcome.status, OUTCOME.DONE);
  });

  it("TIMEOUT-GREEN — a DONE-scoring fixture that times out STAYS DONE (capture is source of truth) with timedOut === true, and does not throw", async () => {
    const briefDir = mkdtempSync(join(tmpdir(), "hand-brief-"));
    const briefFile = join(briefDir, "brief.txt");
    writeFileSync(briefFile, "Create out.txt with hello", "utf8");
    const stateDir = mkdtempSync(join(tmpdir(), "hand-state-"));

    const freezeCommitSha = "fake0000000000000000000000000000000abc";
    const descriptor = {
      feature_id: featureId,
      task_id: taskId,
      role: "executor",
      model: "glm-5.2",
      brief_file: briefFile,
      locked_test: lockedTest,
      freeze_commit_sha: freezeCommitSha,
      scope_paths: ["core/"],
      allowed_writes: ["core/"],
    };

    const fakeSpawn = (cmd, args) => {
      if (args?.includes("--test")) {
        return { status: 0, stdout: "# tests 3\n", stderr: "", output: [] };
      }
      return { status: null, signal: "SIGKILL", error: { code: "ETIMEDOUT" }, stdout: "", stderr: "" };
    };

    let capturedRecord = null;
    const fakeWriteRecord = (path, content) => {
      capturedRecord = JSON.parse(content);
    };
    const fakeEnv = { ANTHROPIC_AUTH_TOKEN: "fake-token" };

    const result = await runLiveDispatch(descriptor, {
      spawn: fakeSpawn,
      env: fakeEnv,
      gitStatus: () => "",
      headSha: () => freezeCommitSha,
      snapshotUntracked: () => new Map(),
      capture: makeDoneFixtureCapture(),
      writeRecord: fakeWriteRecord,
      stateDir,
    });

    assert.ok(capturedRecord, "writeRecord must have been called with a record");
    assert.equal(
      capturedRecord.outcome.status,
      OUTCOME.DONE,
      "TIMEOUT-GREEN prong (#ac-1.2): a wall-clock kill AFTER the frozen locked_test landed green must NOT flip the outcome — the tree is the source of truth, so it stays DONE"
    );
    assert.equal(capturedRecord.timedOut, true, "the persisted record must still carry timedOut === true");
    assert.equal(result.outcome.status, OUTCOME.DONE);
  });

  it("TIMEOUT-RED — a genuinely non-green fixture (locked_test red) that times out is FAILED with timedOut === true, and does not throw", async () => {
    const briefDir = mkdtempSync(join(tmpdir(), "hand-brief-"));
    const briefFile = join(briefDir, "brief.txt");
    writeFileSync(briefFile, "Create out.txt with hello", "utf8");
    const stateDir = mkdtempSync(join(tmpdir(), "hand-state-"));

    const freezeCommitSha = "fake0000000000000000000000000000000abc";
    const descriptor = {
      feature_id: featureId,
      task_id: taskId,
      role: "executor",
      model: "glm-5.2",
      brief_file: briefFile,
      locked_test: lockedTest,
      freeze_commit_sha: freezeCommitSha,
      scope_paths: ["core/"],
      allowed_writes: ["core/"],
    };

    const fakeSpawn = (cmd, args) => {
      if (args?.includes("--test")) {
        return { status: 0, stdout: "# tests 3\n", stderr: "", output: [] };
      }
      return { status: null, signal: "SIGKILL", error: { code: "ETIMEDOUT" }, stdout: "", stderr: "" };
    };

    let capturedRecord = null;
    const fakeWriteRecord = (path, content) => {
      capturedRecord = JSON.parse(content);
    };
    const fakeEnv = { ANTHROPIC_AUTH_TOKEN: "fake-token" };

    const result = await runLiveDispatch(descriptor, {
      spawn: fakeSpawn,
      env: fakeEnv,
      gitStatus: () => "",
      headSha: () => freezeCommitSha,
      snapshotUntracked: () => new Map(),
      capture: makeRedFixtureCapture(),
      writeRecord: fakeWriteRecord,
      stateDir,
    });

    assert.ok(capturedRecord, "writeRecord must have been called with a record");
    assert.equal(
      capturedRecord.outcome.status,
      OUTCOME.FAILED,
      "TIMEOUT-RED prong (#ac-1.4): a timeout with a red frozen locked_test is a genuine failure — must be FAILED, so the change never masks real failure"
    );
    assert.equal(capturedRecord.timedOut, true, "the persisted record must carry timedOut === true");
    assert.equal(result.outcome.status, OUTCOME.FAILED);
  });
});

// ---------------------------------------------------------------------------
// Locked test — #89 inline capture-verified stamp: runLiveDispatch itself writes
// `capturedVerifiedAt` onto the run-record when (and ONLY when) its internal capture
// reaches a green DONE outcome. This is the structural audit-close the orchestrator can
// never omit — the entry-gate real-file capture rail blocks delivery/HEAD advancement on
// a DONE record with no `capturedVerifiedAt`. Green-only by construction: a FAILED/NOT_DONE
// or timed-out run must NOT carry the stamp (never certify a capture that was not green).
// ---------------------------------------------------------------------------
describe("runLiveDispatch inline capture-verified stamp (#89)", () => {
  const featureId = "inline-capture-stamping";
  const taskId = "task-1";
  const lockedTest = "core/skills/orchestrating-delivery/references/spawn-hand.test.mjs";
  const freezeCommitSha = "fake0000000000000000000000000000000abc";

  function makeDescriptor(briefFile) {
    return {
      feature_id: featureId,
      task_id: taskId,
      role: "executor",
      model: "glm-5.2",
      brief_file: briefFile,
      locked_test: lockedTest,
      freeze_commit_sha: freezeCommitSha,
      scope_paths: ["core/"],
      allowed_writes: ["core/"],
    };
  }

  function makeGreenSpawn() {
    return (cmd, args) => {
      if (args?.includes("--test")) {
        return { status: 0, stdout: "# tests 3\n", stderr: "", output: [] };
      }
      return { status: 0, stdout: "", stderr: "", output: [] };
    };
  }

  function makeCapture({ childExitCode, lockedTestExitCode, touchedPaths }) {
    return () => ({
      child: {
        captured: true,
        touchedPaths,
        exitCode: childExitCode,
        lockedTestExitCode,
        stdout: "",
        stderr: "",
      },
      captured: true,
      criticalException: false,
    });
  }

  it("GREEN — a DONE run stamps `capturedVerifiedAt` as an ISO-8601 string on the persisted record", async () => {
    const briefDir = mkdtempSync(join(tmpdir(), "hand-brief-"));
    const briefFile = join(briefDir, "brief.txt");
    writeFileSync(briefFile, "implement feature", "utf8");
    const stateDir = mkdtempSync(join(tmpdir(), "hand-state-"));

    let capturedRecord = null;
    const fakeWriteRecord = (path, content) => {
      capturedRecord = JSON.parse(content);
    };

    const result = await runLiveDispatch(makeDescriptor(briefFile), {
      spawn: makeGreenSpawn(),
      env: { ANTHROPIC_AUTH_TOKEN: "fake-token" },
      gitStatus: () => "",
      headSha: () => freezeCommitSha,
      snapshotUntracked: () => new Map(),
      capture: makeCapture({ childExitCode: 0, lockedTestExitCode: 0, touchedPaths: ["core/x/foo.ts"] }),
      writeRecord: fakeWriteRecord,
      stateDir,
    });

    assert.ok(capturedRecord, "writeRecord must have been called with a record");
    assert.equal(capturedRecord.outcome.status, OUTCOME.DONE, "precondition: the fixture must reach DONE");
    assert.equal(
      typeof capturedRecord.capturedVerifiedAt,
      "string",
      "a green DONE run must stamp capturedVerifiedAt on the persisted record"
    );
    assert.ok(
      capturedRecord.capturedVerifiedAt.length > 0 &&
        !Number.isNaN(Date.parse(capturedRecord.capturedVerifiedAt)),
      "capturedVerifiedAt must be a non-empty, parseable ISO-8601 timestamp"
    );
    assert.equal(
      typeof result.record.capturedVerifiedAt,
      "string",
      "the returned record must carry the same stamp"
    );
  });

  it("FAILED — a genuine non-green capture (lockedTestExitCode != 0) does NOT stamp capturedVerifiedAt", async () => {
    const briefDir = mkdtempSync(join(tmpdir(), "hand-brief-"));
    const briefFile = join(briefDir, "brief.txt");
    writeFileSync(briefFile, "implement feature", "utf8");
    const stateDir = mkdtempSync(join(tmpdir(), "hand-state-"));

    let capturedRecord = null;
    const fakeWriteRecord = (path, content) => {
      capturedRecord = JSON.parse(content);
    };

    await runLiveDispatch(makeDescriptor(briefFile), {
      spawn: makeGreenSpawn(),
      env: { ANTHROPIC_AUTH_TOKEN: "fake-token" },
      gitStatus: () => "",
      headSha: () => freezeCommitSha,
      snapshotUntracked: () => new Map(),
      capture: makeCapture({ childExitCode: 0, lockedTestExitCode: 1, touchedPaths: ["core/x/foo.ts"] }),
      writeRecord: fakeWriteRecord,
      stateDir,
    });

    assert.ok(capturedRecord, "writeRecord must have been called with a record");
    assert.notEqual(capturedRecord.outcome.status, OUTCOME.DONE, "precondition: the fixture must NOT reach DONE");
    assert.equal(
      capturedRecord.capturedVerifiedAt,
      undefined,
      "a non-green run must never carry capturedVerifiedAt"
    );
  });

  it("TIMEOUT-GREEN — a DONE-scoring fixture that times out STAYS DONE and DOES stamp capturedVerifiedAt (#ac-1.2/#ac-1.3)", async () => {
    const briefDir = mkdtempSync(join(tmpdir(), "hand-brief-"));
    const briefFile = join(briefDir, "brief.txt");
    writeFileSync(briefFile, "implement feature", "utf8");
    const stateDir = mkdtempSync(join(tmpdir(), "hand-state-"));

    const timeoutSpawn = (cmd, args) => {
      if (args?.includes("--test")) {
        return { status: 0, stdout: "# tests 3\n", stderr: "", output: [] };
      }
      return { status: null, signal: "SIGKILL", error: { code: "ETIMEDOUT" }, stdout: "", stderr: "" };
    };

    let capturedRecord = null;
    const fakeWriteRecord = (path, content) => {
      capturedRecord = JSON.parse(content);
    };

    await runLiveDispatch(makeDescriptor(briefFile), {
      spawn: timeoutSpawn,
      env: { ANTHROPIC_AUTH_TOKEN: "fake-token" },
      gitStatus: () => "",
      headSha: () => freezeCommitSha,
      snapshotUntracked: () => new Map(),
      capture: makeCapture({ childExitCode: 0, lockedTestExitCode: 0, touchedPaths: ["core/x/foo.ts"] }),
      writeRecord: fakeWriteRecord,
      stateDir,
    });

    assert.ok(capturedRecord, "writeRecord must have been called with a record");
    assert.equal(capturedRecord.outcome.status, OUTCOME.DONE, "precondition: a timeout with a green locked_test stays DONE (capture is the source of truth)");
    assert.equal(
      typeof capturedRecord.capturedVerifiedAt,
      "string",
      "a survive-timeout DONE run MUST stamp capturedVerifiedAt so the entry-gate real-file rail does not block the next commit (#ac-1.3)"
    );
    assert.ok(
      capturedRecord.capturedVerifiedAt.length > 0 && !Number.isNaN(Date.parse(capturedRecord.capturedVerifiedAt)),
      "capturedVerifiedAt must be a non-empty, parseable ISO-8601 timestamp"
    );
  });

  it("TIMEOUT-RED — a genuinely red fixture that times out is FAILED and carries NO capturedVerifiedAt (#ac-1.4)", async () => {
    const briefDir = mkdtempSync(join(tmpdir(), "hand-brief-"));
    const briefFile = join(briefDir, "brief.txt");
    writeFileSync(briefFile, "implement feature", "utf8");
    const stateDir = mkdtempSync(join(tmpdir(), "hand-state-"));

    const timeoutSpawn = (cmd, args) => {
      if (args?.includes("--test")) {
        return { status: 0, stdout: "# tests 3\n", stderr: "", output: [] };
      }
      return { status: null, signal: "SIGKILL", error: { code: "ETIMEDOUT" }, stdout: "", stderr: "" };
    };

    let capturedRecord = null;
    const fakeWriteRecord = (path, content) => {
      capturedRecord = JSON.parse(content);
    };

    await runLiveDispatch(makeDescriptor(briefFile), {
      spawn: timeoutSpawn,
      env: { ANTHROPIC_AUTH_TOKEN: "fake-token" },
      gitStatus: () => "",
      headSha: () => freezeCommitSha,
      snapshotUntracked: () => new Map(),
      capture: makeCapture({ childExitCode: 0, lockedTestExitCode: 1, touchedPaths: ["core/x/foo.ts"] }),
      writeRecord: fakeWriteRecord,
      stateDir,
    });

    assert.ok(capturedRecord, "writeRecord must have been called with a record");
    assert.equal(capturedRecord.outcome.status, OUTCOME.FAILED, "precondition: a timeout with a red locked_test is a genuine FAILED");
    assert.equal(
      capturedRecord.capturedVerifiedAt,
      undefined,
      "a genuinely failed (red) run must never carry capturedVerifiedAt"
    );
  });

  it("NOT_DONE — an empty-diff run does NOT stamp capturedVerifiedAt (pins the exact `=== DONE` boundary)", async () => {
    const briefDir = mkdtempSync(join(tmpdir(), "hand-brief-"));
    const briefFile = join(briefDir, "brief.txt");
    writeFileSync(briefFile, "implement feature", "utf8");
    const stateDir = mkdtempSync(join(tmpdir(), "hand-state-"));

    let capturedRecord = null;
    const fakeWriteRecord = (path, content) => {
      capturedRecord = JSON.parse(content);
    };

    await runLiveDispatch(makeDescriptor(briefFile), {
      spawn: makeGreenSpawn(),
      env: { ANTHROPIC_AUTH_TOKEN: "fake-token" },
      gitStatus: () => "",
      headSha: () => freezeCommitSha,
      snapshotUntracked: () => new Map(),
      // Empty diff → evaluateRun scores NOT_DONE (prose ignored, no work captured).
      capture: makeCapture({ childExitCode: 0, lockedTestExitCode: 0, touchedPaths: [] }),
      writeRecord: fakeWriteRecord,
      stateDir,
    });

    assert.ok(capturedRecord, "writeRecord must have been called with a record");
    assert.equal(
      capturedRecord.outcome.status,
      OUTCOME.NOT_DONE,
      "precondition: an empty-diff run must score NOT_DONE, not DONE"
    );
    assert.equal(
      capturedRecord.capturedVerifiedAt,
      undefined,
      "a NOT_DONE run must never carry capturedVerifiedAt — the stamp is green-DONE-only, not merely non-FAILED"
    );
  });
});

// ---------------------------------------------------------------------------
// Locked test 17 — #ac-1.2 / C6 the token never leaks into the timeout record,
// and the timeout reason string is exact.
// ---------------------------------------------------------------------------
describe("runLiveDispatch wall-clock timeout — token never leaks + exact reason string (#ac-1.2, C6)", () => {
  it("the timeout record contains ZERO occurrences of the token, and carries the exact reason 'hand exceeded wall-clock timeout of <timeoutMs>ms'", async () => {
    const secretToken = "runlive-secret-token-MUST-NOT-LEAK-7777";

    const briefDir = mkdtempSync(join(tmpdir(), "hand-brief-"));
    const briefFile = join(briefDir, "brief.txt");
    writeFileSync(briefFile, "Create out.txt with hello", "utf8");
    const stateDir = mkdtempSync(join(tmpdir(), "hand-state-"));

    const freezeCommitSha = "fake1111111111111111111111111111111abc";
    const descriptor = {
      feature_id: "hand-wallclock-timeout",
      task_id: "task-1",
      role: "executor",
      model: "glm-5.2",
      brief_file: briefFile,
      locked_test: "core/skills/orchestrating-delivery/references/spawn-hand.test.mjs",
      freeze_commit_sha: freezeCommitSha,
      scope_paths: ["core/"],
      allowed_writes: ["core/"],
    };

    const fakeSpawn = (cmd, args) => {
      if (args?.includes("--test")) {
        return { status: 0, stdout: "# tests 3\n", stderr: "", output: [] };
      }
      return { status: null, signal: "SIGKILL", error: { code: "ETIMEDOUT" }, stdout: "", stderr: "" };
    };

    // The injected capture returns a child whose stdout/stderr contain the resolved token —
    // the record must scrub it regardless.
    const fakeCapture = () => ({
      child: {
        captured: true,
        touchedPaths: ["core/x/foo.ts"],
        exitCode: 1,
        lockedTestExitCode: 0,
        stdout: `some output containing the token ${secretToken}`,
        stderr: `count_tokens endpoint 404 not found — leak attempt ${secretToken}`,
      },
      captured: true,
      criticalException: false,
    });

    let capturedRecord = null;
    const fakeWriteRecord = (path, content) => {
      capturedRecord = JSON.parse(content);
    };
    const fakeEnv = { ANTHROPIC_AUTH_TOKEN: secretToken };

    await runLiveDispatch(descriptor, {
      spawn: fakeSpawn,
      env: fakeEnv,
      gitStatus: () => "",
      headSha: () => freezeCommitSha,
      snapshotUntracked: () => new Map(),
      capture: fakeCapture,
      writeRecord: fakeWriteRecord,
      stateDir,
    });

    assert.ok(capturedRecord, "writeRecord must have been called with a record");
    const serialized = JSON.stringify(capturedRecord);
    const tokenOccurrences = serialized.split(secretToken).length - 1;
    assert.equal(
      tokenOccurrences,
      0,
      `the persisted record must contain ZERO occurrences of the token; found ${tokenOccurrences}`
    );

    const timeoutMs = capturedRecord.timeoutMs;
    assert.ok(
      typeof timeoutMs === "number" && timeoutMs > 0,
      "the record must carry a numeric, positive timeoutMs"
    );
    const expectedReason = `hand exceeded wall-clock timeout of ${timeoutMs}ms`;
    assert.ok(
      serialized.includes(expectedReason),
      `the record must contain the exact reason string '${expectedReason}'; record was: ${serialized}`
    );
  });
});

// ---------------------------------------------------------------------------
// Locked test 18 — #ac-1.2 / C1 normal-exit regression guard: a normally-exiting
// child must NOT carry timedOut:true, and outcome.status must be byte-unchanged
// from evaluateRun's verdict for the captured child.
// ---------------------------------------------------------------------------
describe("runLiveDispatch wall-clock timeout — normal-exit regression guard (#ac-1.2, C1)", () => {
  it("a normally-exiting child carries NO timedOut:true, and outcome.status is exactly evaluateRun's unchanged verdict", async () => {
    const briefDir = mkdtempSync(join(tmpdir(), "hand-brief-"));
    const briefFile = join(briefDir, "brief.txt");
    writeFileSync(briefFile, "Create out.txt with hello", "utf8");
    const stateDir = mkdtempSync(join(tmpdir(), "hand-state-"));

    const freezeCommitSha = "fake2222222222222222222222222222222abc";
    const descriptor = {
      feature_id: "hand-wallclock-timeout",
      task_id: "task-1",
      role: "executor",
      model: "glm-5.2",
      brief_file: briefFile,
      locked_test: "core/skills/orchestrating-delivery/references/spawn-hand.test.mjs",
      freeze_commit_sha: freezeCommitSha,
      scope_paths: ["core/"],
      allowed_writes: ["core/"],
    };

    const fakeSpawn = (cmd, args) => {
      if (args?.includes("--test")) {
        return { status: 0, stdout: "# tests 3\n", stderr: "", output: [] };
      }
      return { status: 0, stdout: "", stderr: "", output: [] };
    };

    // An empty-diff (NOT_DONE) fixture — an ordinary, non-timeout outcome that evaluateRun
    // decides purely from the captured child, independent of the timeout override.
    const fakeCapture = () => ({
      child: {
        captured: true,
        touchedPaths: [],
        exitCode: 0,
        lockedTestExitCode: 0,
        stdout: "",
        stderr: "",
      },
      captured: true,
      criticalException: false,
    });

    let capturedRecord = null;
    const fakeWriteRecord = (path, content) => {
      capturedRecord = JSON.parse(content);
    };
    const fakeEnv = { ANTHROPIC_AUTH_TOKEN: "fake-token" };

    const result = await runLiveDispatch(descriptor, {
      spawn: fakeSpawn,
      env: fakeEnv,
      gitStatus: () => "",
      headSha: () => freezeCommitSha,
      snapshotUntracked: () => new Map(),
      capture: fakeCapture,
      writeRecord: fakeWriteRecord,
      stateDir,
    });

    assert.ok(capturedRecord, "writeRecord must have been called with a record");
    assert.notEqual(
      capturedRecord.timedOut,
      true,
      "a normal-exit record must NOT carry timedOut === true"
    );
    assert.equal(
      capturedRecord.outcome.status,
      OUTCOME.NOT_DONE,
      "the normal-exit path must be byte-unchanged: outcome.status must equal evaluateRun's verdict for the captured child (empty diff → NOT_DONE)"
    );
    assert.equal(result.outcome.status, OUTCOME.NOT_DONE);
  });
});

// ---------------------------------------------------------------------------
// Locked test 19 — #ac-2.1 consecutive-429 streak tracking. runLiveDispatch gains two
// injectable seams (readStreak/writeStreak) and the run-record gains two boolean fields
// (record.rateLimited / record.rateLimitExhausted). rateLimited is attributed over the
// `child` object dispatchHand RETURNS (i.e. the raw fakeSpawn stream for the LIVE `claude`
// invocation), completely independent of the OUTCOME, which is controlled by the injected
// `capture` fixture. The dry-run (`--test`) probe always reports >=1 collected test so the
// vacuous-gate guard passes and the genuine run proceeds.
// ---------------------------------------------------------------------------
describe("runLiveDispatch consecutive-429 streak tracking (#ac-2.1)", () => {
  const lockedTest = "core/skills/orchestrating-delivery/references/spawn-hand.test.mjs";

  function makeDispatchTestHarness() {
    const briefDir = mkdtempSync(join(tmpdir(), "hand-brief-"));
    const briefFile = join(briefDir, "brief.txt");
    writeFileSync(briefFile, "Create out.txt with hello", "utf8");
    const stateDir = mkdtempSync(join(tmpdir(), "hand-state-"));
    return { briefFile, stateDir };
  }

  function makeDescriptor({ freezeCommitSha, briefFile }) {
    return {
      feature_id: "hand-rate-limit-streak",
      task_id: "task-1",
      role: "executor",
      model: "glm-5.2",
      brief_file: briefFile,
      locked_test: lockedTest,
      freeze_commit_sha: freezeCommitSha,
      scope_paths: ["core/"],
      allowed_writes: ["core/"],
    };
  }

  // OUTCOME fixtures — entirely independent of the 429 stream (they ignore the args passed in).
  function makeFailedNonScopeCapture() {
    return () => ({
      child: {
        captured: true,
        touchedPaths: ["core/x/foo.ts"],
        exitCode: 1,
        lockedTestExitCode: 1,
        stdout: "",
        stderr: "",
      },
      captured: true,
      criticalException: false,
    });
  }

  function makeNotDoneEmptyDiffCapture() {
    return () => ({
      child: {
        captured: true,
        touchedPaths: [],
        exitCode: 0,
        lockedTestExitCode: 0,
        stdout: "",
        stderr: "",
      },
      captured: true,
      criticalException: false,
    });
  }

  function makeDoneCapture() {
    return () => ({
      child: {
        captured: true,
        touchedPaths: ["core/x/foo.ts"],
        exitCode: 0,
        lockedTestExitCode: 0,
        stdout: "",
        stderr: "",
      },
      captured: true,
      criticalException: false,
    });
  }

  // Stream fixtures — control ONLY the rateLimited attribution over dispatchHand's returned child.
  function fakeSpawn429Attributed(cmd, args) {
    if (args?.includes("--test")) {
      return { status: 0, stdout: "# tests 3\n", stderr: "", output: [] };
    }
    return { status: 1, stdout: "", stderr: "Error: 429 Too Many Requests from ollama api", output: [] };
  }

  function fakeSpawnBenignNo429(cmd, args) {
    if (args?.includes("--test")) {
      return { status: 0, stdout: "# tests 3\n", stderr: "", output: [] };
    }
    return { status: 0, stdout: "", stderr: "", output: [] };
  }

  function fakeSpawnBenign429InDiffLine(cmd, args) {
    if (args?.includes("--test")) {
      return { status: 0, stdout: "# tests 3\n", stderr: "", output: [] };
    }
    return { status: 0, stdout: "+ const MAX = 429;\n", stderr: "", output: [] };
  }

  function fakeSpawnTimeout(cmd, args) {
    if (args?.includes("--test")) {
      return { status: 0, stdout: "# tests 3\n", stderr: "", output: [] };
    }
    return { status: null, signal: "SIGKILL", error: { code: "ETIMEDOUT" }, stdout: "", stderr: "" };
  }

  it("1) persisted count 1 anchored to the current freeze + a 2nd 429-attributed FAILED dispatch reaches rateLimited && rateLimitExhausted", async () => {
    const { briefFile, stateDir } = makeDispatchTestHarness();
    const freezeCommitSha = "streak0000000000000000000000000000001a";
    const descriptor = makeDescriptor({ freezeCommitSha, briefFile });

    let capturedRecord = null;
    const fakeWriteRecord = (path, content) => { capturedRecord = JSON.parse(content); };
    const writeStreakCalls = [];
    const fakeEnv = { ANTHROPIC_AUTH_TOKEN: "fake-token" };

    await runLiveDispatch(descriptor, {
      spawn: fakeSpawn429Attributed,
      env: fakeEnv,
      gitStatus: () => "",
      headSha: () => freezeCommitSha,
      snapshotUntracked: () => new Map(),
      capture: makeFailedNonScopeCapture(),
      writeRecord: fakeWriteRecord,
      readStreak: () => ({ count: 1, freezeCommitSha }),
      writeStreak: (streak) => { writeStreakCalls.push(streak); },
      stateDir,
    });

    assert.ok(capturedRecord, "writeRecord must have been called with a record");
    assert.equal(capturedRecord.rateLimited, true, "the 429-attributed FAILED run must carry rateLimited === true");
    assert.equal(
      capturedRecord.rateLimitExhausted,
      true,
      "count reaches the threshold (2) on this FAILED 429 shape"
    );
  });

  it("2) no prior streak + a single 429-attributed empty-diff NOT_DONE dispatch increments to 1, below threshold", async () => {
    const { briefFile, stateDir } = makeDispatchTestHarness();
    const freezeCommitSha = "streak0000000000000000000000000000002a";
    const descriptor = makeDescriptor({ freezeCommitSha, briefFile });

    let capturedRecord = null;
    const fakeWriteRecord = (path, content) => { capturedRecord = JSON.parse(content); };
    const fakeEnv = { ANTHROPIC_AUTH_TOKEN: "fake-token" };

    await runLiveDispatch(descriptor, {
      spawn: fakeSpawn429Attributed,
      env: fakeEnv,
      gitStatus: () => "",
      headSha: () => freezeCommitSha,
      snapshotUntracked: () => new Map(),
      capture: makeNotDoneEmptyDiffCapture(),
      writeRecord: fakeWriteRecord,
      readStreak: () => null,
      writeStreak: () => {},
      stateDir,
    });

    assert.ok(capturedRecord, "writeRecord must have been called with a record");
    assert.equal(capturedRecord.rateLimited, true, "a 429-attributed run must carry rateLimited === true");
    assert.equal(
      capturedRecord.rateLimitExhausted,
      false,
      "count 1 is below the threshold (2) — increment fired on NOT_DONE, not FAILED"
    );
  });

  it("3) persisted count 1 + a 2nd 429-attributed empty-diff NOT_DONE increments the counter to 2 and exhausts", async () => {
    const { briefFile, stateDir } = makeDispatchTestHarness();
    const freezeCommitSha = "streak0000000000000000000000000000003a";
    const descriptor = makeDescriptor({ freezeCommitSha, briefFile });

    let capturedRecord = null;
    const fakeWriteRecord = (path, content) => { capturedRecord = JSON.parse(content); };
    const writeStreakCalls = [];
    const fakeEnv = { ANTHROPIC_AUTH_TOKEN: "fake-token" };

    await runLiveDispatch(descriptor, {
      spawn: fakeSpawn429Attributed,
      env: fakeEnv,
      gitStatus: () => "",
      headSha: () => freezeCommitSha,
      snapshotUntracked: () => new Map(),
      capture: makeNotDoneEmptyDiffCapture(),
      writeRecord: fakeWriteRecord,
      readStreak: () => ({ count: 1, freezeCommitSha }),
      writeStreak: (streak) => { writeStreakCalls.push(streak); },
      stateDir,
    });

    assert.ok(writeStreakCalls.length > 0, "writeStreak must have been called");
    assert.equal(
      writeStreakCalls[writeStreakCalls.length - 1].count,
      2,
      "the counter must increment from 1 to 2 on the m6 two-empty-diff-429 scenario"
    );
    assert.equal(capturedRecord.rateLimitExhausted, true, "count 2 reaches the threshold");
  });

  it("4) persisted count 1 + a non-429 FAILED dispatch (scope violation) resets the streak to 0", async () => {
    const { briefFile, stateDir } = makeDispatchTestHarness();
    const freezeCommitSha = "streak0000000000000000000000000000004a";
    const descriptor = makeDescriptor({ freezeCommitSha, briefFile });

    // A scope-violation FAILED fixture — touches a path OUTSIDE scope_paths.
    const scopeViolationCapture = () => ({
      child: {
        captured: true,
        touchedPaths: ["outside-scope/evil.ts"],
        exitCode: 0,
        lockedTestExitCode: 0,
        stdout: "",
        stderr: "",
      },
      captured: true,
      criticalException: false,
    });

    let capturedRecord = null;
    const fakeWriteRecord = (path, content) => { capturedRecord = JSON.parse(content); };
    const writeStreakCalls = [];
    const fakeEnv = { ANTHROPIC_AUTH_TOKEN: "fake-token" };

    await runLiveDispatch(descriptor, {
      spawn: fakeSpawnBenignNo429,
      env: fakeEnv,
      gitStatus: () => "",
      headSha: () => freezeCommitSha,
      snapshotUntracked: () => new Map(),
      capture: scopeViolationCapture,
      writeRecord: fakeWriteRecord,
      readStreak: () => ({ count: 1, freezeCommitSha }),
      writeStreak: (streak) => { writeStreakCalls.push(streak); },
      stateDir,
    });

    assert.ok(writeStreakCalls.length > 0, "writeStreak must have been called");
    assert.equal(writeStreakCalls[writeStreakCalls.length - 1].count, 0, "a non-429 FAILED run resets the streak to 0");
    assert.equal(capturedRecord.rateLimitExhausted, false);
  });

  it("5) persisted count 1 + a DONE dispatch (no 429 in stream) resets the streak to 0", async () => {
    const { briefFile, stateDir } = makeDispatchTestHarness();
    const freezeCommitSha = "streak0000000000000000000000000000005a";
    const descriptor = makeDescriptor({ freezeCommitSha, briefFile });

    const writeStreakCalls = [];
    const fakeEnv = { ANTHROPIC_AUTH_TOKEN: "fake-token" };

    await runLiveDispatch(descriptor, {
      spawn: fakeSpawnBenignNo429,
      env: fakeEnv,
      gitStatus: () => "",
      headSha: () => freezeCommitSha,
      snapshotUntracked: () => new Map(),
      capture: makeDoneCapture(),
      writeRecord: () => {},
      readStreak: () => ({ count: 1, freezeCommitSha }),
      writeStreak: (streak) => { writeStreakCalls.push(streak); },
      stateDir,
    });

    assert.ok(writeStreakCalls.length > 0, "writeStreak must have been called");
    assert.equal(writeStreakCalls[writeStreakCalls.length - 1].count, 0, "a DONE run resets the streak to 0");
  });

  it("6) persisted count 1 + a BENIGN empty-diff NOT_DONE with NO 429 in the stream resets the streak to 0", async () => {
    const { briefFile, stateDir } = makeDispatchTestHarness();
    const freezeCommitSha = "streak0000000000000000000000000000006a";
    const descriptor = makeDescriptor({ freezeCommitSha, briefFile });

    const writeStreakCalls = [];
    const fakeEnv = { ANTHROPIC_AUTH_TOKEN: "fake-token" };

    await runLiveDispatch(descriptor, {
      spawn: fakeSpawnBenignNo429,
      env: fakeEnv,
      gitStatus: () => "",
      headSha: () => freezeCommitSha,
      snapshotUntracked: () => new Map(),
      capture: makeNotDoneEmptyDiffCapture(),
      writeRecord: () => {},
      readStreak: () => ({ count: 1, freezeCommitSha }),
      writeStreak: (streak) => { writeStreakCalls.push(streak); },
      stateDir,
    });

    assert.ok(writeStreakCalls.length > 0, "writeStreak must have been called");
    assert.equal(
      writeStreakCalls[writeStreakCalls.length - 1].count,
      0,
      "a benign empty-diff NOT_DONE with no 429 in the stream must reset the streak to 0"
    );
  });

  it("7) a persisted count 1 whose stored freeze_commit_sha DIFFERS from the current descriptor is treated as stale (never inherited)", async () => {
    const { briefFile, stateDir } = makeDispatchTestHarness();
    const freezeCommitSha = "streak0000000000000000000000000000007a";
    const staleFreezeCommitSha = "streak-STALE-DIFFERENT-0000000000000007z";
    const descriptor = makeDescriptor({ freezeCommitSha, briefFile });

    const writeStreakCalls = [];
    const fakeEnv = { ANTHROPIC_AUTH_TOKEN: "fake-token" };

    await runLiveDispatch(descriptor, {
      spawn: fakeSpawn429Attributed,
      env: fakeEnv,
      gitStatus: () => "",
      headSha: () => freezeCommitSha,
      snapshotUntracked: () => new Map(),
      capture: makeNotDoneEmptyDiffCapture(),
      writeRecord: () => {},
      readStreak: () => ({ count: 1, freezeCommitSha: staleFreezeCommitSha }),
      writeStreak: (streak) => { writeStreakCalls.push(streak); },
      stateDir,
    });

    assert.ok(writeStreakCalls.length > 0, "writeStreak must have been called");
    assert.equal(
      writeStreakCalls[writeStreakCalls.length - 1].count,
      1,
      "the stale count anchored to a different freeze_commit_sha must be treated as 0 — the new count is 1, not 2"
    );
  });

  it("8) '429' appearing only in a benign diff-line context (no error marker, no stderr channel) does NOT attribute rateLimited and resets the streak", async () => {
    const { briefFile, stateDir } = makeDispatchTestHarness();
    const freezeCommitSha = "streak0000000000000000000000000000008a";
    const descriptor = makeDescriptor({ freezeCommitSha, briefFile });

    let capturedRecord = null;
    const fakeWriteRecord = (path, content) => { capturedRecord = JSON.parse(content); };
    const writeStreakCalls = [];
    const fakeEnv = { ANTHROPIC_AUTH_TOKEN: "fake-token" };

    await runLiveDispatch(descriptor, {
      spawn: fakeSpawnBenign429InDiffLine,
      env: fakeEnv,
      gitStatus: () => "",
      headSha: () => freezeCommitSha,
      snapshotUntracked: () => new Map(),
      capture: makeNotDoneEmptyDiffCapture(),
      writeRecord: fakeWriteRecord,
      readStreak: () => ({ count: 1, freezeCommitSha }),
      writeStreak: (streak) => { writeStreakCalls.push(streak); },
      stateDir,
    });

    assert.ok(capturedRecord, "writeRecord must have been called with a record");
    assert.equal(
      capturedRecord.rateLimited,
      false,
      "a '429' inside a benign diff line with no error marker must NOT be attributed as rateLimited"
    );
    assert.ok(writeStreakCalls.length > 0, "writeStreak must have been called");
    assert.equal(
      writeStreakCalls[writeStreakCalls.length - 1].count,
      0,
      "the non-rate-limited run must reset the counter to 0"
    );
  });

  it("9) a persisted count 1 is left UNCHANGED when runLiveDispatch throws a pre-spawn config error (diverged HEAD) and writes no run-record", async () => {
    const { briefFile, stateDir } = makeDispatchTestHarness();
    const freezeCommitSha = "streak0000000000000000000000000000009a";
    const divergedHeadSha = "streak-DIVERGED-HEAD-0000000000000009z";
    const descriptor = makeDescriptor({ freezeCommitSha, briefFile });

    const writeStreakCalls = [];
    const fakeEnv = { ANTHROPIC_AUTH_TOKEN: "fake-token" };

    await assert.rejects(
      () => runLiveDispatch(descriptor, {
        spawn: fakeSpawn429Attributed,
        env: fakeEnv,
        gitStatus: () => "",
        // Deliberately diverge HEAD from the freeze baseline so runLiveDispatch throws
        // BEFORE the genuine run (a pre-spawn config error — no record is ever written).
        headSha: () => divergedHeadSha,
        snapshotUntracked: () => new Map(),
        capture: makeNotDoneEmptyDiffCapture(),
        writeRecord: () => { throw new Error("writeRecord must not be reached"); },
        readStreak: () => ({ count: 1, freezeCommitSha }),
        writeStreak: (streak) => { writeStreakCalls.push(streak); },
        stateDir,
      }),
      /diverged from the freeze baseline/,
      "runLiveDispatch must throw a pre-spawn config error on HEAD divergence"
    );

    assert.equal(
      writeStreakCalls.length,
      0,
      "the config-error/pre-spawn-throw path must NEVER mutate the persisted streak"
    );
  });

  it("10) an injected writeStreak that THROWS on write does not prevent runLiveDispatch from returning the genuine run-record", async () => {
    const { briefFile, stateDir } = makeDispatchTestHarness();
    const freezeCommitSha = "streak0000000000000000000000000000010a";
    const descriptor = makeDescriptor({ freezeCommitSha, briefFile });

    const fakeEnv = { ANTHROPIC_AUTH_TOKEN: "fake-token" };

    const result = await runLiveDispatch(descriptor, {
      spawn: fakeSpawn429Attributed,
      env: fakeEnv,
      gitStatus: () => "",
      headSha: () => freezeCommitSha,
      snapshotUntracked: () => new Map(),
      capture: makeDoneCapture(),
      writeRecord: () => {},
      readStreak: () => ({ count: 1, freezeCommitSha }),
      writeStreak: () => { throw new Error("streak write failed"); },
      stateDir,
    });

    assert.ok(result, "runLiveDispatch must resolve, not throw, when writeStreak throws");
    assert.ok(result.record, "the returned result must carry the genuine run-record");
    assert.equal(result.record.outcome.status, OUTCOME.DONE, "the genuine outcome must be preserved");
    assert.equal(result.record.rateLimited, true, "the genuine 429-attributed run must still carry rateLimited === true");
  });

  it("11) persisted count 1 + a timed-out (non-429) dispatch resets the streak to 0", async () => {
    const { briefFile, stateDir } = makeDispatchTestHarness();
    const freezeCommitSha = "streak0000000000000000000000000000011a";
    const descriptor = makeDescriptor({ freezeCommitSha, briefFile });

    let capturedRecord = null;
    const fakeWriteRecord = (path, content) => { capturedRecord = JSON.parse(content); };
    const writeStreakCalls = [];
    const fakeEnv = { ANTHROPIC_AUTH_TOKEN: "fake-token" };

    await runLiveDispatch(descriptor, {
      spawn: fakeSpawnTimeout,
      env: fakeEnv,
      gitStatus: () => "",
      headSha: () => freezeCommitSha,
      snapshotUntracked: () => new Map(),
      capture: makeDoneCapture(),
      writeRecord: fakeWriteRecord,
      readStreak: () => ({ count: 1, freezeCommitSha }),
      writeStreak: (streak) => { writeStreakCalls.push(streak); },
      stateDir,
    });

    assert.ok(writeStreakCalls.length > 0, "writeStreak must have been called");
    assert.equal(writeStreakCalls[writeStreakCalls.length - 1].count, 0, "a timed-out non-429 dispatch resets the streak to 0");
    assert.equal(capturedRecord.rateLimitExhausted, false, "a timed-out non-429 dispatch must not be exhausted");
  });
});

describe("runLiveDispatch role-isolated durable state (#370)", () => {
  it("keeps executor capture evidence and 429 streak separate from a sniper on the same task", async () => {
    const briefDir = mkdtempSync(join(tmpdir(), "hand-role-brief-"));
    const briefFile = join(briefDir, "brief.txt");
    writeFileSync(briefFile, "Implement the task", "utf8");
    const stateDir = mkdtempSync(join(tmpdir(), "hand-role-state-"));
    const freezeCommitSha = "role000000000000000000000000000000000001";
    const base = {
      feature_id: "role-isolation",
      task_id: "task-1",
      model: "glm-5.2",
      brief_file: briefFile,
      locked_test: "core/claude-code/skills/orchestrating-delivery/references/spawn-hand.test.mjs",
      freeze_commit_sha: freezeCommitSha,
      scope_paths: ["core/"],
      allowed_writes: ["core/"],
    };
    const spawn429 = (_cmd, args) =>
      args?.includes("--test")
        ? { status: 0, stdout: "# tests 1\n", stderr: "", output: [] }
        : { status: 1, stdout: "", stderr: "429 Too Many Requests", output: [] };
    const doneCapture = () => ({
      child: { captured: true, touchedPaths: ["core/x.js"], exitCode: 0, lockedTestExitCode: 0, stdout: "", stderr: "" },
      captured: true,
      criticalException: false,
    });
    const notDoneCapture = () => ({
      child: { captured: true, touchedPaths: [], exitCode: 0, lockedTestExitCode: 0, stdout: "", stderr: "" },
      captured: true,
      criticalException: false,
    });

    const executor = await runLiveDispatch({ ...base, role: "executor" }, {
      spawn: spawn429, env: { ANTHROPIC_AUTH_TOKEN: "test-token" }, gitStatus: () => "",
      headSha: () => freezeCommitSha, snapshotUntracked: () => new Map(), capture: doneCapture, stateDir,
    });
    const sniper = await runLiveDispatch({ ...base, role: "sniper" }, {
      spawn: spawn429, env: { ANTHROPIC_AUTH_TOKEN: "test-token" }, gitStatus: () => "",
      headSha: () => freezeCommitSha, snapshotUntracked: () => new Map(), capture: notDoneCapture, stateDir,
    });

    assert.equal(executor.record.outcome.status, "DONE");
    assert.ok(executor.record.capturedVerifiedAt, "executor green capture remains stamped");
    assert.equal(sniper.record.rateLimitExhausted, false, "sniper starts at its own 429 count, not executor's");
    const executorRecord = JSON.parse(readFileSync(join(stateDir, "role-isolation", "executor", "task-1.json"), "utf8"));
    assert.equal(executorRecord.outcome.status, "DONE");
    assert.ok(executorRecord.capturedVerifiedAt);
  });
});
