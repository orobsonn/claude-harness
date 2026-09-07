/** Orca owns workspace/terminal placement; the harness owns task execution and evidence. */
import fs from "node:fs";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { taskAdmissionPath } from "./task-contract.mjs";

const execute = promisify(execFile);
const git = (cwd, ...args) => execFileSync("git", args, {
  cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
}).trim();

export function quoteOrcaCommand(command, args) {
  return "exec " + [command, ...args].map((value) => {
    if (typeof value !== "string" || value.includes("\0"))
      throw new Error("Orca terminal requires string arguments without NUL");
    return "'" + value.replaceAll("'", "'\\''") + "'";
  }).join(" ");
}

async function runOrca({ cli, args, cwd }) {
  const { stdout } = await execute(cli, [...args, "--json"], {
    cwd, encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
  });
  const response = JSON.parse(stdout);
  if (response?.ok !== true || !response.result)
    throw new Error("Orca did not return a successful structured result");
  return response.result;
}

/** Called only for a parent launched inside Orca; a stale inherited pane cannot select another repo. */
export async function resolveOrcaTaskBackend({ projectRoot, worktreeId, cli = process.env.PI_HARNESS_ORCA_CLI || process.env.ORCA_CLI_COMMAND || "orca" }, injected = {}) {
  if (typeof worktreeId !== "string" || !worktreeId)
    throw new Error("Orca parent worktree identity required");
  const root = fs.realpathSync(projectRoot);
  const run = (args) => (injected.run ?? runOrca)({ cli, args, cwd: root });
  const parent = (await run(["worktree", "show", "--worktree", `path:${root}`])).worktree;
  if (!parent || parent.id !== worktreeId || !parent.repoId ||
      fs.realpathSync(parent.path) !== root)
    throw new Error("Orca pane does not belong to this global worktree; resume it in the matching Orca workspace");

  const backend = {
    parent: { worktree_id: parent.id, instance_id: parent.instanceId, repo_id: parent.repoId, path: root },
    async prepareWorktree(entry, persist) {
      entry.orca ??= {
        name: `harness-task-${entry.task_id}-${entry.attempt_id}`,
        comment: `Harness task ${entry.task_id}; attempt ${entry.attempt_id}`,
        parent_worktree_id: parent.id,
        repo_id: parent.repoId,
      };
      const reservation = entry.orca;
      if (reservation.parent_worktree_id !== parent.id || reservation.repo_id !== parent.repoId)
        throw new Error("Orca task parent identity changed");
      let worktree;
      if (reservation.worktree_id) {
        worktree = (await run(["worktree", "show", "--worktree", `id:${reservation.worktree_id}`])).worktree;
      } else {
        // A request can commit before its CLI response is lost. Recover by our persisted,
        // unique attempt marker; never issue a second create while the first is uncertain.
        const listed = await run(["worktree", "list", "--repo", `id:${parent.repoId}`]);
        if (!Array.isArray(listed.worktrees) || listed.truncated)
          throw new Error("Orca worktree inventory is incomplete");
        const matches = listed.worktrees.filter((item) => item.comment === reservation.comment);
        if (matches.length > 1) throw new Error("multiple Orca worktrees claim this task attempt");
        worktree = matches[0];
        if (!worktree) {
          if (reservation.create_requested)
            throw new Error("Orca worktree creation is unresolved; inspect this attempt before retrying creation");
          reservation.create_requested = true;
          persist();
          const created = await run([
            "worktree", "create", "--repo", `id:${parent.repoId}`,
            "--name", reservation.name, "--base-branch", entry.base_sha,
            "--parent-worktree", `id:${parent.id}`, "--setup", "skip", "--activate",
            "--comment", reservation.comment,
          ]);
          worktree = created.worktree;
          if (created.startupTerminal?.handle)
            reservation.startup_terminal_handle = created.startupTerminal.handle;
        }
      }
      if (!worktree || !worktree.id || !worktree.instanceId ||
          worktree.repoId !== parent.repoId || worktree.parentWorktreeId !== parent.id ||
          (!reservation.worktree_id && worktree.comment !== reservation.comment) || !path.isAbsolute(worktree.path) ||
          fs.realpathSync(worktree.path) === root)
        throw new Error("Orca task worktree identity mismatch");
      const cwd = fs.realpathSync(worktree.path);
      if (git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir") !==
          git(root, "rev-parse", "--path-format=absolute", "--git-common-dir"))
        throw new Error("Orca task worktree belongs to another Git repository");
      const branch = git(cwd, "branch", "--show-current");
      if (!branch) throw new Error("Orca task worktree must have its own branch");
      if (reservation.worktree_id) {
        if (reservation.worktree_id !== worktree.id || reservation.instance_id !== worktree.instanceId ||
            entry.worktree !== cwd || entry.branch !== branch)
          throw new Error("reserved Orca worktree was replaced or moved");
      } else {
        if (git(cwd, "rev-parse", "HEAD") !== entry.base_sha)
          throw new Error("new Orca task worktree does not start at the exact approved base");
        entry.worktree = cwd;
        entry.branch = branch;
        entry.grant_path = taskAdmissionPath(cwd, entry.attempt_id);
        entry.grant.cwd = cwd;
        entry.grant.branch = branch;
        reservation.worktree_id = worktree.id;
        reservation.instance_id = worktree.instanceId;
        persist();
      }
    },
    async launchTerminal({ command, args, cwd, title, worktreeId, instanceId }) {
      const target = (await run(["worktree", "show", "--worktree", `path:${cwd}`])).worktree;
      if (!target || target.id !== worktreeId || target.instanceId !== instanceId ||
          target.repoId !== parent.repoId || target.parentWorktreeId !== parent.id ||
          fs.realpathSync(target.path) !== fs.realpathSync(cwd))
        throw new Error("Orca terminal target does not belong to this task parent");
      const { terminal } = await run([
        "terminal", "create", "--worktree", `id:${target.id}`,
        "--title", title || `Harness task · ${path.basename(cwd)}`,
        "--command", quoteOrcaCommand(command, args),
      ]);
      if (!terminal?.handle || terminal.worktreeId !== target.id)
        throw new Error("Orca terminal creation returned an unexpected identity; inspect the attempt before retrying");
      let surface = terminal.surface;
      let focus;
      if (surface !== "visible") {
        // A newly created workspace can outpace UI adoption. Follow Orca's documented
        // reveal action on this same handle; never create a replacement process.
        try {
          const revealed = (await run(["terminal", "focus", "--terminal", terminal.handle])).focus;
          if (revealed?.handle === terminal.handle && revealed.worktreeId === target.id &&
              revealed.tabId === terminal.tabId && revealed.navigated === true) {
            surface = "visible";
            focus = revealed;
          }
        } catch { /* The process may already exist; preserve its handle and report visibility. */ }
      }
      return {
        terminal_handle: terminal.handle, worktree_id: target.id,
        surface, tab_id: terminal.tabId,
        ...(focus ? { focus } : {}),
        ...(surface !== "visible" ? { warning: terminal.warning || "Orca did not confirm this terminal is visible; reveal the existing handle." } : {}),
      };
    },
  };
  return backend;
}
