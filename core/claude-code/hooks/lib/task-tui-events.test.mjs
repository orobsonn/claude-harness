import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { finalizeTuiEvents, readTuiJob, syncTuiEvents, transcriptEvent } from "./task-tui-events.mjs";

const SESSION = "44444444-4444-4444-8444-444444444444";

function tuiJob(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cc-tui-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const worktree = path.join(dir, "worktree");
  const jobDir = path.join(dir, "job");
  const config = path.join(dir, "config");
  fs.mkdirSync(worktree);
  fs.mkdirSync(jobDir);
  fs.mkdirSync(path.join(config, "projects", "-w"), { recursive: true });
  const jobFile = path.join(jobDir, "job.json");
  const eventsPath = path.join(jobDir, "events.jsonl");
  fs.writeFileSync(jobFile, JSON.stringify({ presentation: "tui", terminal_mode: true, cwd: worktree, events_path: eventsPath }));
  fs.writeFileSync(eventsPath, "", { mode: 0o600 });
  const transcript = path.join(config, "projects", "-w", `${SESSION}.jsonl`);
  const env = { CLAUDE_HARNESS_TUI_JOB_FILE: jobFile, CLAUDE_CONFIG_DIR: config };
  const append = (...entries) => fs.appendFileSync(transcript, entries.map((entry) => `${JSON.stringify({ sessionId: SESSION, isSidechain: false, ...entry })}\n`).join(""));
  const payload = { session_id: SESSION, transcript_path: transcript };
  const events = () => fs.readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { dir, worktree, jobFile, eventsPath, env, append, payload, events, transcript };
}

const toolUse = (id) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: { command: "echo" } }] } });
const toolResult = (id) => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] }, toolUseResult: { stdout: "ok" } });

test("the transcript becomes stream-json events, from this launch's start only", (t) => {
  const job = tuiJob(t);
  job.append(toolUse("toolu_old"), toolResult("toolu_old"));
  syncTuiEvents(job.payload, { env: job.env, cwd: job.worktree, start: true });
  job.append(toolUse("toolu_1"), { type: "attachment" }, { ...toolUse("toolu_side"), isSidechain: true }, toolResult("toolu_1"));
  assert.equal(syncTuiEvents(job.payload, { env: job.env, cwd: job.worktree }).copied, 2);
  assert.equal(syncTuiEvents(job.payload, { env: job.env, cwd: job.worktree }).copied, 0, "idempotent");
  finalizeTuiEvents({ ...job.payload, last_assistant_message: "pronto" }, { env: job.env, cwd: job.worktree });
  const events = job.events();
  assert.deepEqual(events.map((event) => event.type), ["system", "assistant", "user", "result"]);
  assert.equal(events[0].cwd, job.worktree);
  assert.equal(events[2].tool_use_result.stdout, "ok");
  assert.ok(!JSON.stringify(events).includes("toolu_old"), "an earlier launch's calls are never copied again");
  assert.deepEqual({ written_by: events[3].written_by, result: events[3].result }, { written_by: "lane-stop-hook", result: "pronto" });
  assert.equal(transcriptEvent({ type: "assistant", sessionId: "other", message: { content: [] } }, SESSION), null);
});

test("a tampered job, events file or transcript location is refused", (t) => {
  const job = tuiJob(t);
  assert.throws(() => syncTuiEvents(job.payload, { env: job.env, cwd: job.worktree }), /not started by this session's SessionStart/);
  assert.throws(() => syncTuiEvents({ ...job.payload, transcript_path: path.join(job.dir, `${SESSION}.jsonl`) }, { env: job.env, cwd: job.worktree, start: true }), /projects directory/);
  assert.throws(() => readTuiJob({ env: job.env, cwd: job.dir }), /cwd mismatch/);
  fs.chmodSync(job.eventsPath, 0o644);
  assert.throws(() => syncTuiEvents(job.payload, { env: job.env, cwd: job.worktree, start: true }), /mode 0600/);
  const link = path.join(job.dir, "link.json");
  fs.symlinkSync(job.jobFile, link);
  assert.throws(() => readTuiJob({ env: { ...job.env, CLAUDE_HARNESS_TUI_JOB_FILE: link }, cwd: job.worktree }), /regular non-symlink/);
  assert.equal(readTuiJob({ env: {}, cwd: job.worktree }), null, "not a TUI job");
});
