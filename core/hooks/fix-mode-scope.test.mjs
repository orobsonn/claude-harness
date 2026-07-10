/**
 * @description Grupo C #ac-1.3 — the fix-mode sniper's write scope is enforced by CONSUMING the
 * Grupo A scope rail (active-scope marker → plan-write-gate), never a new/reimplemented rail. This
 * test drives the exact consumption the SKILL documents: take the TRUSTED `changedFiles` from the
 * persisted fix-findings file, stamp `active-scope --role sniper` with them (via the real
 * mark.mjs → stamp-triage path), then assert plan-write-gate DENIES a sniper subagent write outside
 * that scope and ALLOWS one inside it. The scope comes ONLY from changedFiles — never from the
 * untrusted findings (NEW-1).
 *
 * Run with: node --test core/hooks/fix-mode-scope.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { decide as planDecide } from "./plan-write-gate.mjs";
import { parseArgs, run } from "./mark.mjs";
import { handle as stampHandle } from "./stamp-triage.mjs";
import { readGateState } from "./lib/gate-lib.mjs";

function withTempDir(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fix-mode-scope-"));
  const savedCwd = process.cwd();
  try {
    process.chdir(tmpDir);
    fn(tmpDir);
  } finally {
    process.chdir(savedCwd);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

function makeSniperWrite(filePath, sessionId) {
  return {
    session_id: sessionId,
    tool_name: "Write",
    agent_id: "ag_sniper",
    agent_type: "sniper",
    tool_input: { file_path: filePath, content: "x" },
  };
}

test("#ac-1.3 fix-mode consumes the A rail: active-scope stamped from the trusted changedFiles denies out-of-scope sniper writes and allows in-scope ones", () => {
  withTempDir(() => {
    const sid = "ses_fixmode";
    // The persisted fix-findings file — changedFiles is the TRUSTED scope source (NEW-1).
    const fixFindings = {
      root: 42, pr: 501, sha: "abc123abc123",
      changedFiles: ["core/vps/cron-a-dispatch.mjs", "core/vps/review-routing.mjs"],
      findings: [{ severity: "high", summary: "the untrusted finding text — must NOT widen scope" }],
    };

    // The fix-mode session stamps active-scope for the sniper from changedFiles (the SKILL contract).
    const argv = [
      "node", "mark.mjs", "active-scope",
      "--feature-id", "harness-42", "--task-id", "fix-mode", "--role", "sniper",
      "--scope-paths", fixFindings.changedFiles.join(","),
    ];
    const parsed = parseArgs(argv);
    assert.ok(parsed, "the active-scope marker must parse");
    const marked = run(parsed);
    assert.equal(marked.success, true);

    stampHandle({
      session_id: sid,
      tool_name: "Bash",
      tool_input: { command: `node .claude/hooks/mark.mjs active-scope --feature-id harness-42 --task-id fix-mode --role sniper --scope-paths ${fixFindings.changedFiles.join(",")}` },
      tool_response: JSON.stringify(marked.output),
    });
    const state = readGateState(sid);
    assert.deepEqual(state.active_dispatch.scope_paths, fixFindings.changedFiles, "active_dispatch scope = the trusted changedFiles");
    assert.equal(state.active_dispatch.role, "sniper");

    // In-scope sniper write → allowed.
    const inScope = planDecide(makeSniperWrite("core/vps/cron-a-dispatch.mjs", sid), { readGateStateFn: () => state });
    assert.equal(inScope.allow, true, "a sniper write INSIDE changedFiles is allowed");

    // Out-of-scope sniper write → DENIED by the consumed A rail (not a new rail).
    const outScope = planDecide(makeSniperWrite("core/auth/session.mjs", sid), { readGateStateFn: () => state });
    assert.equal(outScope.allow, false, "a sniper write OUTSIDE changedFiles is denied");
    assert.equal(outScope.hookSpecificOutput.permissionDecision, "deny");
    assert.ok(outScope.hookSpecificOutput.permissionDecisionReason.includes("core/auth/session.mjs"), "the deny names the out-of-scope path");
  });
});
