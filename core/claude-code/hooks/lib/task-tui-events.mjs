/**
 * @description Native evidence sink for a task lane rendered as an interactive Claude Code TUI in an
 * Orca terminal (port of Pi's harness-task-events.ts). A TUI has no stream-json stdout, so the lane
 * hooks copy Claude Code's own session transcript (`transcript_path` in every hook payload) into the
 * job's `events.jsonl`, in the stream-json shape the host inspection already reads (spike §15):
 * main-loop `assistant`/`user` entries with `tool_use`, `tool_result` and `tool_use_result`.
 *
 * - `CLAUDE_HARNESS_TUI_JOB_FILE` (set by the worker only for a `tui` job) names the host job
 *   descriptor; it must be a regular, non-symlink file whose `cwd` is this lane worktree and whose
 *   `events.jsonl` (pre-created 0600 by the worker) sits beside it.
 * - Each launch starts copying at the transcript size recorded on its SessionStart, so a resumed
 *   session (same transcript file) never duplicates an earlier launch's calls.
 * - At the end of the turn the Stop hook appends one `result` record (`written_by:
 *   "lane-stop-hook"`) and ends this job's launcher, which forwards the signal to `claude`; the host accepts the TUI's
 *   SIGTERM exit only together with that record.
 * Every failure throws: the caller fails closed (no record means the host blocks the task).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const TUI_JOB_ENV = "CLAUDE_HARNESS_TUI_JOB_FILE";
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const SAFE_SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function openRegular(file, flags) {
  if (!path.isAbsolute(file)) throw new Error(`TUI evidence path must be absolute: ${file}`);
  const before = fs.lstatSync(file);
  if (before.isSymbolicLink() || !before.isFile()) throw new Error(`TUI evidence path must be a regular non-symlink file: ${file}`);
  const fd = fs.openSync(file, flags | fs.constants.O_NOFOLLOW);
  const opened = fs.fstatSync(fd);
  if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
    fs.closeSync(fd);
    throw new Error(`TUI evidence path changed while opening: ${file}`);
  }
  return { fd, stat: opened };
}

/** The validated TUI job of this lane hook, or null outside a TUI job. */
export function readTuiJob({ env = process.env, cwd }) {
  const jobFile = env[TUI_JOB_ENV];
  if (jobFile === undefined) return null;
  const { fd } = openRegular(jobFile, fs.constants.O_RDONLY);
  let job;
  try { job = JSON.parse(fs.readFileSync(fd, "utf8")); } finally { fs.closeSync(fd); }
  if (!job || typeof job !== "object" || job.presentation !== "tui" || job.terminal_mode !== true) {
    throw new Error("TUI job descriptor presentation mismatch");
  }
  const root = fs.realpathSync(cwd);
  if (typeof job.cwd !== "string" || job.cwd !== root) throw new Error("TUI job descriptor cwd mismatch");
  const eventsPath = path.join(path.dirname(jobFile), "events.jsonl");
  if (job.events_path !== eventsPath) throw new Error("TUI job descriptor events path mismatch");
  return { jobFile, job, eventsPath, offsetPath: `${eventsPath}.offset` };
}

/** Claude Code's transcript for this session, validated against the payload identity. */
function transcriptOf(payload, env) {
  const file = payload?.transcript_path;
  const sessionId = payload?.session_id;
  if (typeof file !== "string" || !SAFE_SESSION.test(sessionId ?? "") || path.basename(file) !== `${sessionId}.jsonl`) {
    throw new Error("hook payload lacks this session's transcript path");
  }
  const config = env.CLAUDE_CONFIG_DIR && path.isAbsolute(env.CLAUDE_CONFIG_DIR) ? env.CLAUDE_CONFIG_DIR : path.join(env.HOME || os.homedir(), ".claude");
  // Claude Code creates the transcript (and its project folder) on the first entry, after
  // SessionStart already fired (LIVE 2026-10-11): resolve what exists, validate the rest lexically.
  const resolve = (target) => (fs.existsSync(target) ? fs.realpathSync(target) : path.join(resolve(path.dirname(target)), path.basename(target)));
  const projects = resolve(path.join(config, "projects"));
  const folder = resolve(path.dirname(path.resolve(file)));
  if (path.dirname(folder) !== projects) throw new Error("transcript must live in the Claude Code projects directory");
  const transcript = path.join(folder, path.basename(file));
  if (fs.existsSync(transcript) && fs.lstatSync(transcript).isSymbolicLink()) throw new Error("transcript must not be a symlink");
  return transcript;
}

const readOffset = (offsetPath) => {
  try { return JSON.parse(fs.readFileSync(offsetPath, "utf8")); } catch { return null; }
};
const writeOffset = (offsetPath, value) => {
  const temporary = `${offsetPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: "w" });
  fs.renameSync(temporary, offsetPath);
};

function appendEvents(eventsPath, lines) {
  if (!lines.length) return;
  const { fd, stat } = openRegular(eventsPath, fs.constants.O_WRONLY | fs.constants.O_APPEND);
  try {
    if ((stat.mode & 0o777) !== 0o600) throw new Error("TUI events file must have mode 0600");
    fs.writeSync(fd, lines.map((line) => `${JSON.stringify(line)}\n`).join(""), null, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** One transcript entry → the stream-json event the inspection reads, or null. */
export function transcriptEvent(entry, sessionId) {
  if (!entry || typeof entry !== "object" || entry.sessionId !== sessionId || entry.isSidechain === true) return null;
  if (entry.type !== "assistant" && entry.type !== "user") return null;
  if (!entry.message || !Array.isArray(entry.message.content)) return null;
  return {
    type: entry.type,
    session_id: sessionId,
    parent_tool_use_id: null,
    uuid: typeof entry.uuid === "string" ? entry.uuid : undefined,
    message: { role: entry.message.role, content: entry.message.content },
    ...(entry.toolUseResult !== undefined ? { tool_use_result: entry.toolUseResult } : {}),
  };
}

/**
 * Copy the transcript entries this launch has not copied yet. On SessionStart (`start: true`) it
 * records where this launch begins and emits the `system/init` event with the hook's cwd.
 */
export function syncTuiEvents(payload, { env = process.env, cwd, start = false } = {}) {
  const tui = readTuiJob({ env, cwd });
  if (!tui) return null;
  const transcript = transcriptOf(payload, env);
  const size = fs.existsSync(transcript) ? fs.statSync(transcript).size : 0;
  let offset = readOffset(tui.offsetPath);
  if (start) {
    if (offset && offset.session_id !== payload.session_id) throw new Error("TUI job already belongs to another session");
    if (!offset) {
      offset = { session_id: payload.session_id, transcript, offset: size };
      appendEvents(tui.eventsPath, [{ type: "system", subtype: "init", session_id: payload.session_id, cwd: fs.realpathSync(cwd), presentation: "tui" }]);
      writeOffset(tui.offsetPath, offset);
    }
    return { copied: 0 };
  }
  if (!offset || offset.session_id !== payload.session_id || offset.transcript !== transcript) {
    throw new Error("TUI evidence was not started by this session's SessionStart");
  }
  if (size > MAX_TRANSCRIPT_BYTES) throw new Error("transcript exceeds the TUI evidence bound");
  if (size <= offset.offset) return { copied: 0 };
  const { fd } = openRegular(transcript, fs.constants.O_RDONLY);
  let chunk;
  try {
    const buffer = Buffer.alloc(size - offset.offset);
    fs.readSync(fd, buffer, 0, buffer.length, offset.offset);
    chunk = buffer.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
  const complete = chunk.lastIndexOf("\n");
  if (complete < 0) return { copied: 0 };
  const events = [];
  for (const line of chunk.slice(0, complete).split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const event = transcriptEvent(entry, payload.session_id);
    if (event) events.push(event);
  }
  appendEvents(tui.eventsPath, events);
  writeOffset(tui.offsetPath, { ...offset, offset: offset.offset + Buffer.byteLength(chunk.slice(0, complete + 1), "utf8") });
  return { copied: events.length };
}

/** The end-of-turn record the host requires before it accepts a TUI's SIGTERM exit. */
export function finalizeTuiEvents(payload, { env = process.env, cwd } = {}) {
  const tui = readTuiJob({ env, cwd });
  if (!tui) return null;
  syncTuiEvents(payload, { env, cwd });
  appendEvents(tui.eventsPath, [{
    type: "result", subtype: "success", is_error: false, session_id: payload.session_id,
    result: typeof payload.last_assistant_message === "string" ? payload.last_assistant_message : "",
    written_by: "lane-stop-hook", presentation: "tui",
  }]);
  return tui;
}

const cmdline = (pid) => fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
const parentOf = (pid) => Number(fs.readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\)\s+\S+\s+/, "").split(/\s+/)[0]);

/**
 * The lane launcher of this job: the ancestor of this hook whose parent is the supervisor's
 * `--child` wrapper for exactly this job descriptor (tree: worker → --child → launcher → claude →
 * hook). The launcher forwards SIGTERM to `claude`. Null when not found (never a guess).
 */
export function tuiLaunchPid(jobFile, { from = process.pid } = {}) {
  let pid = from;
  for (let depth = 0; depth < 16 && pid > 1; depth += 1) {
    const parent = parentOf(pid);
    if (parent <= 1) return null;
    try {
      const args = cmdline(parent);
      if (args.includes("--child") && args.at(-1) === jobFile) return pid;
    } catch {
      return null;
    }
    pid = parent;
  }
  return null;
}
