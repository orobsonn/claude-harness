import fs from "node:fs";
import path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  isChildSession,
  piSessionId,
} from "../lib/pi-adapter-map.mjs";

const TUI_JOB_ENV = "PI_HARNESS_TUI_JOB_FILE";

type Recorder = {
  fd: number;
  cwd: string;
  sessionId: string;
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Record the native Pi event stream for a host-owned TUI job. */
export default function harnessTaskEvents(pi: ExtensionAPI) {
  const jobFile = process.env[TUI_JOB_ENV];
  if (!jobFile) return;

  let recorder: Recorder | null = null;
  let disabled = false;
  let failureReported = false;

  const closeRecorder = () => {
    if (!recorder) return;
    const { fd } = recorder;
    recorder = null;
    try {
      fs.closeSync(fd);
    } catch {
      /* The original evidence error remains authoritative. */
    }
  };

  const reportFailure = (ctx: any, error: unknown) => {
    closeRecorder();
    disabled = true;
    const message = `[harness-task-events] ${errorText(error)}`;
    if (!failureReported) {
      failureReported = true;
      try {
        if (ctx?.ui?.notify) ctx.ui.notify(message, "error");
        else console.error(message);
      } catch {
        console.error(message);
      }
    }
    try {
      ctx?.shutdown?.();
    } catch (shutdownError) {
      console.error(
        `[harness-task-events] shutdown failed: ${errorText(shutdownError)}`,
      );
    }
  };

  const assertOwner = (ctx: any) => {
    if (!recorder) throw new Error("TUI evidence recorder is unavailable");
    const header = ctx?.sessionManager?.getHeader?.();
    if (
      isChildSession(ctx) ||
      piSessionId(ctx) !== recorder.sessionId ||
      !header ||
      header.id !== recorder.sessionId ||
      ctx?.cwd !== recorder.cwd
    )
      throw new Error("TUI evidence owner/session/cwd mismatch");
  };

  const appendNative = (event: unknown) => {
    if (!recorder) throw new Error("TUI evidence recorder is unavailable");
    fs.writeSync(recorder.fd, `${JSON.stringify(event)}\n`, null, "utf8");
  };

  pi.on("session_start", (_event, ctx: any) => {
    if (isChildSession(ctx) || ctx?.mode !== "tui") return;
    if (recorder) {
      try {
        assertOwner(ctx);
      } catch (error) {
        reportFailure(ctx, error);
      }
      return;
    }
    if (disabled) {
      reportFailure(ctx, new Error("TUI evidence recorder is disabled"));
      return;
    }
    try {
      if (!path.isAbsolute(jobFile))
        throw new Error("TUI job file must be absolute");
      const jobPathInfo = fs.lstatSync(jobFile);
      if (jobPathInfo.isSymbolicLink() || !jobPathInfo.isFile())
        throw new Error("TUI job file must be a regular non-symlink");

      let jobFd: number | null = null;
      let job: any;
      try {
        jobFd = fs.openSync(
          jobFile,
          fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
        );
        const opened = fs.fstatSync(jobFd);
        if (
          !opened.isFile() ||
          opened.dev !== jobPathInfo.dev ||
          opened.ino !== jobPathInfo.ino
        )
          throw new Error("TUI job file identity changed while opening");
        job = JSON.parse(fs.readFileSync(jobFd, "utf8"));
      } finally {
        if (jobFd !== null) fs.closeSync(jobFd);
      }
      if (!job || typeof job !== "object" || Array.isArray(job))
        throw new Error("TUI job descriptor must be an object");
      if (job.presentation !== "tui" || job.terminal_mode !== true)
        throw new Error("TUI job descriptor presentation mismatch");

      const sessionId = piSessionId(ctx);
      const header = ctx?.sessionManager?.getHeader?.();
      if (
        !sessionId ||
        !header ||
        header.id !== sessionId
      )
        throw new Error("TUI session header identity mismatch");
      if (typeof ctx?.cwd !== "string" || typeof job.cwd !== "string")
        throw new Error("TUI job descriptor cwd is missing");
      const cwd = fs.realpathSync(ctx.cwd);
      if (
        cwd !== ctx.cwd ||
        fs.realpathSync(job.cwd) !== cwd ||
        job.cwd !== cwd ||
        typeof header.cwd !== "string" ||
        fs.realpathSync(header.cwd) !== cwd
      )
        throw new Error("TUI job descriptor cwd mismatch");

      const eventsPath = path.join(path.dirname(jobFile), "events.jsonl");
      if (job.events_path !== eventsPath)
        throw new Error("TUI job descriptor events path mismatch");
      const fd = fs.openSync(
        eventsPath,
        fs.constants.O_WRONLY |
          fs.constants.O_APPEND |
          fs.constants.O_NOFOLLOW,
      );
      try {
        const info = fs.fstatSync(fd);
        if (!info.isFile())
          throw new Error("TUI events path must be a regular file");
        if ((info.mode & 0o777) !== 0o600)
          throw new Error("TUI events file must have mode 0600");
      } catch (error) {
        fs.closeSync(fd);
        throw error;
      }
      recorder = { fd, cwd, sessionId };
      appendNative(header);
    } catch (error) {
      reportFailure(ctx, error);
    }
  });

  const recordToolEvent = (event: unknown, ctx: any) => {
    if (isChildSession(ctx) || ctx?.mode !== "tui" || disabled) return;
    try {
      assertOwner(ctx);
      appendNative(event);
    } catch (error) {
      reportFailure(ctx, error);
    }
  };
  pi.on("tool_execution_start", recordToolEvent);
  pi.on("tool_execution_end", recordToolEvent);

  pi.on("agent_end", (_event, ctx: any) => {
    if (isChildSession(ctx) || ctx?.mode !== "tui" || disabled) return;
    try {
      assertOwner(ctx);
      fs.fsyncSync(recorder!.fd);
      ctx.shutdown();
    } catch (error) {
      reportFailure(ctx, error);
    }
  });

  pi.on("session_shutdown", () => {
    closeRecorder();
    disabled = true;
  });
}
