#!/usr/bin/env node
/**
 * @description Headless probe for OC gates post-fix (entry-gate/plan-gate).
 * Creates temp project via vendor-core --runtime opencode, runs DENY scenario via real opencode,
 * validates oracle on tool_use error (NOT exit code), runs hermetic in-process ALLOW oracle.
 * Documents that exit code of opencode alone is not the oracle.
 */

import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createPlanGateHooks } from "../core/opencode/plugin/plan-gate.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const OPENCODE_BIN = process.env.OPENCODE_BIN || "opencode";

function log(msg) {
  console.log(msg);
}

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function pass(msg) {
  console.log(`PASS: ${msg}`);
}

async function main() {
  const tempRoot = mkdtempSync(join(tmpdir(), "oc-gates-probe-"));
  log(`temp project: ${tempRoot}`);

  try {
    // 1. Vendor core with opencode runtime
    const vendorCmd = [
      "node",
      join(REPO_ROOT, "core/claude-code/skills/initializing-projects/references/vendor-core.mjs"),
      "--source",
      REPO_ROOT,
      "--target",
      tempRoot,
      "--runtime",
      "opencode",
    ];
    log(`running: ${vendorCmd.join(" ")}`);
    execFileSync(vendorCmd[0], vendorCmd.slice(1), { stdio: "inherit", cwd: REPO_ROOT });

    // 2. Ensure opencode.json has plugin list (vendor writes it)
    const ocJsonPath = join(tempRoot, "opencode.json");
    if (!existsSync(ocJsonPath)) {
      fail("opencode.json not created by vendor");
    }
    const ocJson = JSON.parse(readFileSync(ocJsonPath, "utf8"));
    const pluginList = ocJson.plugin || ocJson.plugins;
    if (!Array.isArray(pluginList)) {
      fail("opencode.json missing plugin list after vendor");
    }
    if (pluginList.some((entry) => String(entry).includes(".opencode/plugin/"))) {
      fail("opencode.json must not list auto-globbed harness plugins");
    }
    const retiredMarker = join(tempRoot, ".opencode", "plugin", "lib", "mark-gate.mjs");
    if (existsSync(retiredMarker)) {
      fail("retired mark-gate helper survived fresh vendoring");
    }
    const bashPermissions = ocJson?.permission?.bash;
    if (
      bashPermissions &&
      (Object.hasOwn(bashPermissions, "node .opencode/plugin/lib/mark-gate.mjs *") ||
        Object.hasOwn(bashPermissions, "node core/opencode/plugin/lib/mark-gate.mjs *"))
    ) {
      fail("opencode.json retained a shell marker permission");
    }
    pass("opencode.json leaves harness plugins to auto-glob");

    // 3. DENY scenario: prompt that forces task→executor-low once
    const denyPrompt = `You MUST call the task tool exactly once with:
subagent_type: executor-low
description: probe gate deny
prompt: Reply only HAND_OK
After the task returns (success or error), reply GATE_PROBE_DONE.`;
    log(`DENY scenario: opencode run --dir ${tempRoot} ...`);
    const denyRes = spawnSync(
      OPENCODE_BIN,
      ["run", "--dir", tempRoot, "--format", "json", "--auto", "--agent", "build", denyPrompt],
      { cwd: tempRoot, encoding: "utf8", timeout: 120000 }
    );
    const denyStdout = denyRes.stdout || "";
    const denyStderr = denyRes.stderr || "";

    // 4. Oracle DENY (NOT exit code) — parse NDJSON tool_use.state
    let hasGateError = false;
    let pluginLoadFail = false;
    const combined = denyStderr + "\n" + denyStdout;
    if (/failed to load plugin/i.test(combined)) {
      // only fail if critical gates
      if (/entry-gate|plan-gate/i.test(combined)) {
        pluginLoadFail = true;
      }
    }
    if (pluginLoadFail) {
      fail("plugin load error for entry-gate|plan-gate: " + combined.slice(0, 500));
    }
    for (const line of denyStdout.split("\n")) {
      if (!line.trim().startsWith("{")) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type !== "tool_use") continue;
      const part = ev.part || {};
      const st = part.state || {};
      const msg = String(st.error || part.error || ev.message || "");
      if (st.status === "error" && /\[(entry-gate|plan-gate)\]/.test(msg)) {
        hasGateError = true;
        break;
      }
    }
    // also accept stderr throw text if model never emitted tool_use
    if (!hasGateError && /\[(entry-gate|plan-gate)\]/.test(combined)) {
      hasGateError = true;
    }
    if (!hasGateError) {
      fail(
        "DENY oracle: no tool_use status=error with [entry-gate|plan-gate]. stderr_tail=" +
          denyStderr.slice(-800) +
          " stdout_tail=" +
          denyStdout.slice(-800)
      );
    }
    pass("DENY oracle: tool_use error with gate prefix (exit code alone is NOT oracle)");

    // 5. AC-1 plugin load check (second run, simple prompt, no task)
    const loadPrompt = "list files";
    const loadRes = spawnSync(
      OPENCODE_BIN,
      ["run", "--dir", tempRoot, "--format", "json", "--auto", "--agent", "build", loadPrompt],
      { cwd: tempRoot, encoding: "utf8", timeout: 90000 }
    );
    const loadOut = (loadRes.stdout || "") + (loadRes.stderr || "");
    if (/failed to load plugin/i.test(loadOut)) {
      fail("plugin load failed on simple prompt");
    }
    pass("AC-1: plugins load cleanly (no task)");

    // 6. Hermetic ALLOW oracle (in-process, pre-seeded gate-state)
    const allowStateDir = join(tempRoot, ".opencode", "plans", ".state", "ses_probe_allow");
    mkdirSync(allowStateDir, { recursive: true });
    const allowState = { session_id: "ses_probe_allow", feature_id: "probe-allow" };
    writeFileSync(join(allowStateDir, "gate-state.json"), JSON.stringify(allowState, null, 2));

    const allowHooks = await createPlanGateHooks(tempRoot);
    await allowHooks["tool.execute.before"](
      { tool: "task", sessionID: "ses_probe_allow", callID: "probe-allow" },
      { args: { subagent_type: "executor-low", prompt: '[HARNESS_TASK_CONTEXT]{"task_id":"probe"}[/HARNESS_TASK_CONTEXT]' } },
    );
    pass("AC-3 ALLOW: hermetic plan-gate permits a session with no planner binding");

    log("All checks passed.");
    process.exit(0);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  } finally {
    // cleanup temp (comment out for debug)
    // rmSync(tempRoot, { recursive: true, force: true });
  }
}

main();
