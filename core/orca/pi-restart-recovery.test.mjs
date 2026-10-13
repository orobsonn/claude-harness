import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { interruptedPiSession } from "./pi-restart-recovery.mjs";
import { runTick, normalizeConfig } from "./select-and-dispatch.mjs";

// Captured boundary: #398 was stopped 85 ms after daemon SIGTERM; startup followed.
const STOP = "2026-10-13T06:50:57.841Z";
const SESSION = "5cf048da-ab69-462b-80d6-b1c675756b09";
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-queue-restart-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = path.join(root, ".pi/harness/state", SESSION);
  const sessions = path.join(root, ".pi/harness/sessions");
  const plans = path.join(root, ".pi/harness/plans/status-stop");
  for (const dir of [state, sessions, plans]) fs.mkdirSync(dir, { recursive: true });
  const spec = "# Approved status/stop spec\n";
  const hash = createHash("sha256").update(spec).digest("hex");
  fs.writeFileSync(path.join(plans, "spec.md"), spec);
  fs.writeFileSync(path.join(state, "gate-state.json"), JSON.stringify({ session_id: SESSION,
    feature_id: "status-stop", mode: "FULL", classified: true, brainstormed: true,
    adversary_fired: true, spec_status: "adversary-reviewed", spec_sha256: hash,
    reviewed_spec_sha256: hash, adversary_spec_sha256: hash }));
  const transcript = path.join(sessions, `2026-10-13T06-30-25-306Z_${SESSION}.jsonl`);
  const lines = [{ type: "session", id: SESSION, cwd: root },
    { type: "message", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "subagent" }] } },
    { type: "custom", customType: "subagents:record", timestamp: STOP, data: { status: "stopped" } }];
  fs.writeFileSync(transcript, lines.map(JSON.stringify).join("\n") + "\n");
  const worktree = { worktreeId: `repo::${root}`, repoId: "repo", path: root, hostId: "local",
    linkedIssue: 398, parentWorktreeId: null, isArchived: false, workspaceStatus: "in-progress", status: "idle" };
  const daemonLog = path.join(root, "daemon.log");
  const daemon = [{ event: "session-created", sessionId: `${worktree.worktreeId}@@3ad360c5` },
    { event: "shutdown", reason: "SIGTERM", ts: "2026-10-13T06:50:57.756Z" },
    { event: "startup", ts: "2026-10-13T06:51:06.354Z" }];
  fs.writeFileSync(daemonLog, daemon.map(JSON.stringify).join("\n") + "\n");
  return { root, state, worktree, daemonLog, daemon, transcript, lines, options: { daemonLog } };
}

test("Orca restart selects the exact unfinished conversation with native pre-plan recovery, read-only", (t) => {
  const f = fixture(t), before = fs.readFileSync(path.join(f.state, "gate-state.json"));
  assert.equal(interruptedPiSession(f.worktree, f.options), SESSION);
  assert.deepEqual(fs.readFileSync(path.join(f.state, "gate-state.json")), before);
  assert.equal(fs.existsSync(path.join(f.root, ".pi/harness/plans/status-stop/execution-plan.json")), false);
});

test("idle, manual pause, terminal close, finalized, resumed, remote and inconsistent artifacts stay untouched", (t) => {
  const changes = [
    f => { f.worktree.status = "working"; },
    f => { f.worktree.workspaceStatus = "review"; },
    f => { f.worktree.hostId = "remote"; },
    f => { f.worktree.parentWorktreeId = "parent"; },
    f => { f.worktree.isArchived = true; },
    f => { f.lines.at(-1).timestamp = "2026-10-13T06:50:56.000Z"; },
    f => { f.lines.at(-1).timestamp = "2026-10-13T07:00:00.000Z"; },
    f => { f.lines.at(-1).data.status = "completed"; },
    f => { f.lines.push({ type: "message", message: { role: "user", content: "resume" } }); },
    f => { f.daemon.splice(1, 0, { event: "session-killed", sessionId: `${f.worktree.worktreeId}@@3ad360c5` }); },
    f => { f.daemon.splice(1, 1); },
    f => { f.daemon[1].reason = "operator-quit"; },
    f => { fs.writeFileSync(path.join(f.state, "memory-finalized.json"), "{}"); },
    f => { fs.writeFileSync(path.join(f.root, ".pi/harness/plans/status-stop/spec.md"), "changed"); },
  ];
  for (const change of changes) {
    const f = fixture(t); change(f);
    fs.writeFileSync(f.transcript, f.lines.map(JSON.stringify).join("\n"));
    fs.writeFileSync(f.daemonLog, f.daemon.map(JSON.stringify).join("\n"));
    assert.equal(interruptedPiSession(f.worktree, f.options), null, change.toString());
  }
});

test("queue resumes before fresh work without relabelling, fetching or creating another worktree", (t) => {
  const f = fixture(t), calls = [];
  const config = normalizeConfig({ project: "victor", ghRepo: "owner/victor", orcaRepoId: "repo",
    clonePath: f.root, agent: "pi", globalMaxWorking: 4, prompt: "Entregue #{{ISSUE_NUMBER}}; sem deploy." });
  const deps = { config, interruptedPiSession: wt => interruptedPiSession(wt, f.options),
    orca(args) {
      calls.push(args);
      if (args[1] === "ps") return { worktrees: [f.worktree] };
      assert.deepEqual(args.slice(0, 2), ["terminal", "create"]);
      return { ok: true, result: { terminal: { handle: "term-resume", worktreeId: f.worktree.worktreeId } } };
    },
    gh(args) { calls.push(args); assert.equal(args[1], "list"); return args.includes("harness:in-progress") ? [{ number: 398, labels: [] }] : []; },
    git() { assert.fail("resume must not fetch or replace its base"); },
  };
  assert.deepEqual(runTick(deps), { ok: true, dispatched: true, resumed: true, issue: 398 });
  const command = calls.find(a => a[0] === "terminal");
  assert.match(command.at(-2), /--harness-resume/);
  assert.ok(command.at(-2).includes(SESSION));
  assert.ok(command.at(-2).includes("Entregue #398; sem deploy."));
  assert.ok(!calls.some(a => a[1] === "edit"));
  deps.orca = args => args[1] === "ps" ? { worktrees: [f.worktree] } : (() => { throw Error("transport lost"); })();
  assert.equal(runTick(deps).reason, "pi-resume-unresolved");
});

test("blocked labels, active children, ambiguous worktrees and full capacity never request resume", (t) => {
  for (const variant of ["harness:blocked", "needs-human", "child", "ambiguous", "ceiling"]) {
    const f = fixture(t);
    const config = normalizeConfig({ project: "victor", ghRepo: "owner/victor", orcaRepoId: "repo",
      clonePath: f.root, agent: "pi", globalMaxWorking: variant === "ceiling" ? 1 : 4 });
    const entries = [f.worktree];
    if (variant === "ambiguous") entries.push({ ...f.worktree, worktreeId: "other" });
    if (variant === "child") entries.push({ worktreeId: "child", parentWorktreeId: f.worktree.worktreeId, status: "working" });
    if (variant === "ceiling") f.worktree.status = "working";
    const result = runTick({ config, interruptedPiSession: () => assert.fail("must not select a session"),
      orca(args) { assert.equal(args[1], "ps"); return { worktrees: entries }; },
      gh(args) { return args.includes("harness:in-progress") ? [{ number: 398, labels: [{ name: variant }] }] : []; },
      git() { assert.fail("must not fetch"); },
    });
    assert.equal(result.dispatched, false, variant);
  }
});

test("multiple recoverable conversations are ambiguous; state symlinks do not authorize a selection", (t) => {
  const f = fixture(t), other = "another-session";
  const copy = path.join(path.dirname(f.state), other);
  fs.mkdirSync(copy);
  const state = JSON.parse(fs.readFileSync(path.join(f.state, "gate-state.json")));
  fs.writeFileSync(path.join(copy, "gate-state.json"), JSON.stringify({ ...state, session_id: other }));
  const transcript = path.join(path.dirname(f.transcript), `2026-10-13T06-30-25-306Z_${other}.jsonl`);
  fs.writeFileSync(transcript, f.lines.map((r, i) => JSON.stringify(i ? r : { ...r, id: other })).join("\n"));
  assert.equal(interruptedPiSession(f.worktree, f.options), null);
  fs.rmSync(copy, { recursive: true }); fs.unlinkSync(transcript);
  fs.renameSync(f.state, `${f.state}-target`);
  fs.symlinkSync(`${f.state}-target`, f.state);
  assert.equal(interruptedPiSession(f.worktree, f.options), null);
});
