#!/usr/bin/env node
/**
 * @description Scripted stand-in for the Orca CLI (v1.4 JSON envelope) used by the Orca-backend
 * e2e: `worktree show|list|create` over real `git worktree add`, and `terminal create`, which runs
 * its `--command` detached in the worktree with Orca's pane variables, as an Orca terminal would;
 * `terminal wait --for exit` blocks until that process ends (or answers Orca's timeout envelope).
 * State and a call log live in $FAKE_ORCA_STATE. The parent workspace is $FAKE_ORCA_PARENT with
 * repo id $FAKE_ORCA_REPO_ID; children go under $FAKE_ORCA_WORKSPACES. Shapes follow the live CLI
 * captured for the port (worktree.id = "<repoId>::<path>", hostId "local").
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const argv = process.argv.slice(2);
const statePath = process.env.FAKE_ORCA_STATE;
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : { worktrees: [], terminals: [], calls: [] };
const save = () => fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
const flag = (name) => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : undefined; };
const reply = (result) => { save(); process.stdout.write(`${JSON.stringify({ id: randomUUID(), ok: true, result, _meta: { runtimeId: "fake" } })}\n`); process.exit(0); };
const fail = (code, message) => { save(); process.stdout.write(`${JSON.stringify({ ok: false, error: { code, message } })}\n`); process.exit(1); };

state.calls.push(argv.filter((arg) => arg !== "--json"));
const repoId = process.env.FAKE_ORCA_REPO_ID;
const parentPath = fs.realpathSync(process.env.FAKE_ORCA_PARENT);
const parent = { id: `${repoId}::${parentPath}`, instanceId: "inst-parent", repoId, hostId: "local", path: parentPath, parentWorktreeId: null, comment: "" };
const find = (selector) => {
  if (selector.startsWith("path:")) {
    const target = fs.realpathSync(selector.slice(5));
    return target === parentPath ? parent : state.worktrees.find((item) => item.path === target);
  }
  if (selector.startsWith("id:")) {
    const id = selector.slice(3);
    return id === parent.id ? parent : state.worktrees.find((item) => item.id === id);
  }
  return undefined;
};

const [group, verb] = argv;
if (group === "worktree" && verb === "show") {
  const worktree = find(flag("--worktree"));
  if (!worktree) fail("not_found", "worktree not found");
  reply({ worktree });
}
if (group === "worktree" && verb === "list") reply({ worktrees: state.worktrees, totalCount: state.worktrees.length, truncated: false });
if (group === "worktree" && verb === "create") {
  if (process.env.FAKE_ORCA_FAIL_CREATE === "1") fail("internal", "create failed");
  const name = flag("--name");
  const target = path.join(process.env.FAKE_ORCA_WORKSPACES, name);
  fs.mkdirSync(process.env.FAKE_ORCA_WORKSPACES, { recursive: true });
  execFileSync("git", ["worktree", "add", "-q", "-b", `orca/${name}`, target, flag("--base-branch")], { cwd: parentPath, stdio: "ignore" });
  const real = fs.realpathSync(target);
  const worktree = { id: `${repoId}::${real}`, instanceId: `inst-${name}`, repoId, hostId: "local", path: real, displayName: name,
    comment: flag("--comment"), parentWorktreeId: flag("--parent-worktree").slice(3) };
  state.worktrees.push(worktree);
  reply({ worktree });
}
if (group === "terminal" && verb === "create") {
  const worktree = find(flag("--worktree"));
  if (!worktree) fail("not_found", "worktree not found");
  const handle = `term_${randomUUID().slice(0, 8)}`;
  const tabId = `tab_${randomUUID().slice(0, 8)}`;
  const log = fs.openSync(path.join(path.dirname(statePath), `${handle}.log`), "a");
  // FAKE_ORCA_PTY=1 gives the command a real pseudo-terminal, as an Orca terminal does (LIVE TUI smoke).
  const child = spawn(process.env.FAKE_ORCA_PTY === "1" ? "script" : "sh",
    process.env.FAKE_ORCA_PTY === "1" ? ["-qefc", flag("--command"), "/dev/null"] : ["-c", flag("--command")], {
    cwd: worktree.path, detached: true, stdio: ["ignore", log, log],
    env: { ...process.env, ORCA_PANE_KEY: `pane-${handle}`, ORCA_TAB_ID: tabId, ORCA_WORKTREE_ID: worktree.id, ORCA_TERMINAL_HANDLE: handle },
  });
  child.unref();
  state.terminals.push({ handle, tabId, worktreeId: worktree.id, title: flag("--title"), command: flag("--command"), log: `${handle}.log`, pid: child.pid });
  reply({ terminal: { handle, worktreeId: worktree.id, tabId, surface: "visible", title: flag("--title") } });
}
if (group === "terminal" && verb === "wait") {
  const terminal = state.terminals.find((item) => item.handle === flag("--terminal"));
  if (!terminal) fail("terminal_handle_stale", "unknown terminal");
  const alive = () => { try { process.kill(terminal.pid, 0); return true; } catch { return false; } };
  const until = Date.now() + Number(flag("--timeout-ms"));
  while (alive() && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  if (alive()) fail("timeout", "terminal still running");
  reply({ wait: { satisfied: true, condition: "exit", handle: terminal.handle } });
}
fail("unsupported", `fake orca does not implement ${argv.join(" ")}`);
