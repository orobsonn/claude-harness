/**
 * @description Test-only isolation for HARNESS_OBSERVABILITY_RUN_PATH. Production code
 * (obs-emit.mjs's obsAppend) resolves this env var straight from process.env by default — a test
 * that drives a real emitter-capable hook (obs-eye.ts, obs-hand.ts, obs-plan-write.ts,
 * loop-guard.ts, mark-gate.mjs's CLI, plan-write-gate.ts, planner-recovery.ts) without isolating
 * it inherits whatever real run outbox the test process's environment carries — inside an actual
 * harness session that env var points at a live run, so fixture events land in the real feed
 * (#490). Call `isolateObservabilityRunPath()` once at module scope, before any `test(...)`
 * registration, to blank the var for every test in that file and restore the prior value
 * (present or absent) once the file's tests finish.
 */
import { before, after } from "node:test";

const ENV_KEY = "HARNESS_OBSERVABILITY_RUN_PATH";
let installed = false;

export function isolateObservabilityRunPath() {
  if (installed) return;
  installed = true;
  let saved;
  let hadValue = false;
  before(() => {
    hadValue = Object.prototype.hasOwnProperty.call(process.env, ENV_KEY);
    saved = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
  });
  after(() => {
    if (hadValue) process.env[ENV_KEY] = saved;
    else delete process.env[ENV_KEY];
  });
}
