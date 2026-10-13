/** Resume a queued Pi conversation interrupted by an observed local Orca restart. */
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { recoverPiParentSession } from "../pi/lib/parent-session-recovery.mjs";

function records(text) {
  return text.split("\n").flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

/** Read-only selection. The native launcher still owns locks, workers and delivery gates. */
export function interruptedPiSession(worktree, {
  daemonLog = path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "orca/logs/daemon.log"),
} = {}) {
  if (worktree.hostId !== "local" || worktree.parentWorktreeId || worktree.isArchived ||
      worktree.workspaceStatus !== "in-progress" || worktree.status === "working") return null;
  try {
    const daemon = records(fs.readFileSync(daemonLog, "utf8"));
    // An ordinary stopped child, idle agent or terminal close does not authorize resume.
    const startup = daemon.findLastIndex((r) => r.event === "startup");
    const shutdown = daemon.findLastIndex((r, i) => i < startup && r.event === "shutdown");
    if (shutdown < 0 || daemon[shutdown].reason !== "SIGTERM") return null;
    const from = Date.parse(daemon[shutdown].ts), until = Date.parse(daemon[startup].ts);
    const active = new Set();
    for (const r of daemon.slice(0, shutdown)) {
      if (r.event === "session-created") active.add(r.sessionId);
      if (r.event === "session-exited" || r.event === "session-killed") active.delete(r.sessionId);
    }
    if (![...active].some((id) => typeof id === "string" && id.startsWith(`${worktree.worktreeId}@@`))) return null;
    const stateRoot = path.join(worktree.path, ".pi/harness/state");
    const candidates = [];
    for (const entry of fs.readdirSync(stateRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const recovered = recoverPiParentSession(worktree.path, entry.name);
      if (!recovered.ok || recovered.taskAdmission) continue;
      if (fs.existsSync(path.join(stateRoot, entry.name, "memory-finalized.json"))) continue;
      const tail = records(fs.readFileSync(recovered.sessionFile, "utf8"));
      const last = tail.at(-1), previous = tail.at(-2);
      const stoppedAt = Date.parse(last?.timestamp);
      if (last?.type !== "custom" || last.customType !== "subagents:record" ||
          last.data?.status !== "stopped" || !(from <= stoppedAt && stoppedAt < until)) continue;
      if (previous?.message?.role !== "assistant" || previous.message.stopReason !== "toolUse") continue;
      candidates.push(entry.name);
    }
    return candidates.length === 1 ? candidates[0] : null;
  } catch { return null; }
}
