#!/usr/bin/env node
/**
 * @description Tests for spawn-hand.mjs — validates that buildSpawnArgs builds the correct
 * argv array (with token excluded) and that dispatchHand correctly wires the child env,
 * sets up the ephemeral CLAUDE_CONFIG_DIR with the Stop hook, tears it down, and scrubs
 * the token from the brief/system-prompt file before writing.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The module under test — will fail to import until implemented (red).
import {
  buildSpawnArgs,
  dispatchHand,
} from "./spawn-hand.mjs";

// ---------------------------------------------------------------------------
// Locked test 1 — argv shape + token exclusion
// ---------------------------------------------------------------------------
describe("buildSpawnArgs", () => {
  it("contains -p, --allowedTools Read,Write,Edit, --output-format json, resolved model, and does NOT contain the token", () => {
    const token = "secret-ollama-token-abc123";
    const model = "qwen3-coder:480b";
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
    const argv = buildSpawnArgs({ model: "glm-5.1", briefFile: "/tmp/brief.txt" });
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
      model: "glm-5.1",
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
// Locked test 4 — brief/system-prompt file has ZERO occurrences of the token
// ---------------------------------------------------------------------------
describe("dispatchHand Claude-alias guard", () => {
  it("rejects a bare Claude alias as the hand model (would 404 against Ollama)", async () => {
    const dispatch = {
      model: "sonnet",
      brief: "x",
      scope_paths: ["core/"],
      allowed_writes: ["core/"],
      locked_test: "core/skills/orchestrating-delivery/references/spawn-hand.test.mjs",
    };
    await assert.rejects(
      () => dispatchHand(dispatch, {
        spawn: () => ({ status: 0, stdout: "", stderr: "", output: [] }),
        gitStatus: () => "",
        devVarsContent: "",
        env: { ANTHROPIC_AUTH_TOKEN: "t" },
      }),
      /Claude alias dispatched to Ollama/
    );
  });
});

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
      model: "glm-5.1",
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
      model: "glm-5.1",
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
      model: "glm-5.1",
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
      model: "glm-5.1",
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
      model: "glm-5.1",
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
      model: "glm-5.1",
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
      model: "glm-5.1",
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
      model: "glm-5.1",
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
      model: "glm-5.1",
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
    model: "glm-5.1",
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
  it("throws /no ANTHROPIC_AUTH_TOKEN/ and does NOT spawn when no token resolves", async () => {
    let spawnCalled = false;
    const fakeSpawn = (cmd, args) => {
      if (args?.includes("--test")) {
        return { status: 0, stdout: "# tests 3\n", stderr: "", output: [] };
      }
      spawnCalled = true;
      return { status: 0, stdout: "", stderr: "", output: [] };
    };

    const dispatch = {
      model: "glm-5.1",
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
      /no ANTHROPIC_AUTH_TOKEN/,
      "dispatchHand must throw when no auth token resolves"
    );

    assert.equal(spawnCalled, false, "spawn must NOT be called when no token resolves");
  });
});
