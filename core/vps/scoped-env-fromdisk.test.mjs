#!/usr/bin/env node
/**
 * @description Pinned assertions for buildScopedEnvFromDisk (glue-1) — the disk-reading adapter
 * that wires the pure buildScopedEnv (scoped-env.mjs) to real Cron-A dispatch. All fixtures are
 * injected via the readFileSafe seam — no real ~/.claude or process.env is touched.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { buildScopedEnvFromDisk } from "./scoped-env-fromdisk.mjs";

const PROJECT_ROOT = "/fake/projX";
const HOME_DIR = "/fake/home";
const BASE_ENV = { PATH: "/usr/bin", HOME: HOME_DIR };

function makeReadFileSafe(contentByPath) {
  return (path) => contentByPath[path] ?? "";
}

test("loads the target project's own .dev.vars secret into the returned env", () => {
  const readFileSafe = makeReadFileSafe({
    [join(PROJECT_ROOT, ".dev.vars")]: "X_SECRET=x\n",
  });

  const env = buildScopedEnvFromDisk("projX", {
    projectRoot: PROJECT_ROOT,
    homeDir: HOME_DIR,
    baseEnv: BASE_ENV,
    readFileSafe,
  });

  assert.equal(env.X_SECRET, "x");
});

test("carries OLLAMA_HAND_TOKEN from ~/.claude/.dev.vars but excludes ANTHROPIC_AUTH_TOKEN", () => {
  const readFileSafe = makeReadFileSafe({
    [join(HOME_DIR, ".claude", ".dev.vars")]:
      "ANTHROPIC_AUTH_TOKEN=tok\nOLLAMA_HAND_TOKEN=oll\n",
  });

  const env = buildScopedEnvFromDisk("projX", {
    projectRoot: PROJECT_ROOT,
    homeDir: HOME_DIR,
    baseEnv: BASE_ENV,
    readFileSafe,
  });

  assert.equal(env.OLLAMA_HAND_TOKEN, "oll");
  assert.equal("ANTHROPIC_AUTH_TOKEN" in env, false);
});

test("does not inherit ~/.bashrc-style aliases from baseEnv", () => {
  const baseEnvWithAlias = { ...BASE_ENV, WR_MERIDIUM: "1" };
  const readFileSafe = makeReadFileSafe({});

  const env = buildScopedEnvFromDisk("projX", {
    projectRoot: PROJECT_ROOT,
    homeDir: HOME_DIR,
    baseEnv: baseEnvWithAlias,
    readFileSafe,
  });

  assert.equal("WR_MERIDIUM" in env, false);
});

test("tolerates a missing project .dev.vars and still carries the global OLLAMA_HAND_TOKEN", () => {
  const readFileSafe = makeReadFileSafe({
    [join(HOME_DIR, ".claude", ".dev.vars")]: "OLLAMA_HAND_TOKEN=oll\n",
    // No entry for join(PROJECT_ROOT, ".dev.vars") — readFileSafe returns '' for it.
  });

  assert.doesNotThrow(() => {
    buildScopedEnvFromDisk("projX", {
      projectRoot: PROJECT_ROOT,
      homeDir: HOME_DIR,
      baseEnv: BASE_ENV,
      readFileSafe,
    });
  });

  const env = buildScopedEnvFromDisk("projX", {
    projectRoot: PROJECT_ROOT,
    homeDir: HOME_DIR,
    baseEnv: BASE_ENV,
    readFileSafe,
  });

  assert.equal(env.OLLAMA_HAND_TOKEN, "oll");
});
