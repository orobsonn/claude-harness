#!/usr/bin/env node
/** One detached process group per task launch. No LLM scheduling lives here. */
import { runTaskWorker } from "../../shared/lib/task-worker.mjs";
import {
  renderTaskEventLine,
  validateTaskProfileEnvironment,
} from "../lib/task-process.mjs";
import { verifyTaskRuntime } from "../lib/task-runtime-assets.mjs";

runTaskWorker({
  renderEventLine: renderTaskEventLine,
  verifyRuntime: verifyTaskRuntime,
  childEnvironment(processEnvironment, job, descriptorPath) {
    const env = {
      ...processEnvironment,
      ...(validateTaskProfileEnvironment(job.profile_environment) ?? {}),
    };
    // A task is a fresh local parent, never an inherited native subagent.
    for (const key of Object.keys(env)) {
      if (
        key.startsWith("HARNESS_DISPATCH_") ||
        key.startsWith("PI_SUBAGENT_") ||
        key === "PI_HARNESS_RESUME"
      )
        delete env[key];
    }
    delete env.PI_HARNESS_TASK_RUN;
    delete env.PI_HARNESS_TUI_JOB_FILE;
    if (!job.terminal_mode)
      for (const key of Object.keys(env)) if (key.startsWith("ORCA_")) delete env[key];
    if (job.presentation === "tui") env.PI_HARNESS_TUI_JOB_FILE = descriptorPath;
    return env;
  },
});
