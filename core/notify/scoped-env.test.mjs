/**
 * @description Contract tests for scoped-env.mjs — the builder that assembles the env object
 * used to spawn a project's `claude -p` parent session on the VPS. Every case feeds SYNTHETIC
 * baseEnv / projectDevVars / claudeDevVarsContent to the pure buildScopedEnv() function; no real
 * ~/.bashrc, ~/.claude, or process.env is ever read. Fully hermetic — no temp dirs needed since
 * buildScopedEnv takes its inputs as injected data, not file paths.
 *
 * Auth model pinned here (see buildScopedEnv contract in scoped-env.mjs):
 *   - The parent `claude -p` authenticates via its OWN ~/.claude Claude Code config, NOT an
 *     env var. ANTHROPIC_AUTH_TOKEN must NEVER be injected into the returned (parent) env —
 *     that key is the Ollama hand-token fallback; setting it on the parent 401s Claude Code.
 *   - OLLAMA_HAND_TOKEN must be preserved into the returned env so spawn-hand can map it into
 *     the child hand process later.
 *   - Only the TARGET project's own .dev.vars keys are included — never a sibling project's,
 *     and never ~/.bashrc-sourced shell aliases (e.g. Cloudflare wrangler shortcuts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildScopedEnv } from "./scoped-env.mjs";

test("buildScopedEnv: excludes a ~/.bashrc-sourced Cloudflare alias var carried on the base/parent env", () => {
  const baseEnv = { WR_MERIDIUM: "1", HOME: "/home/robson", PATH: "/usr/bin" };

  const env = buildScopedEnv("projectX", {
    baseEnv,
    projectDevVars: { projectX: "X_SECRET=x" },
    claudeDevVarsContent: "ANTHROPIC_AUTH_TOKEN=tok\nOLLAMA_HAND_TOKEN=oll",
  });

  assert.equal(
    "WR_MERIDIUM" in env,
    false,
    "a ~/.bashrc-sourced alias var present on the base env must not be inherited into the scoped env"
  );
});

test("buildScopedEnv: includes the target project's own .dev.vars secret, excludes a sibling project's", () => {
  const env = buildScopedEnv("projectX", {
    baseEnv: {},
    projectDevVars: {
      projectX: "X_SECRET=x",
      projectY: "Y_SECRET=y",
    },
    claudeDevVarsContent: "",
  });

  assert.equal(env.X_SECRET, "x", "the target project's own .dev.vars secret must be present");
  assert.equal(
    "Y_SECRET" in env,
    false,
    "a sibling project's .dev.vars secret must never be exported into this project's session env"
  );
});

test("buildScopedEnv: never injects ANTHROPIC_AUTH_TOKEN into the parent env, but preserves OLLAMA_HAND_TOKEN", () => {
  const env = buildScopedEnv("projectX", {
    baseEnv: {},
    projectDevVars: { projectX: "" },
    claudeDevVarsContent: "ANTHROPIC_AUTH_TOKEN=tok\nOLLAMA_HAND_TOKEN=oll",
  });

  assert.equal(
    "ANTHROPIC_AUTH_TOKEN" in env,
    false,
    "ANTHROPIC_AUTH_TOKEN must never be injected into the parent env — it would 401 Claude Code"
  );
  assert.equal(
    env.OLLAMA_HAND_TOKEN,
    "oll",
    "OLLAMA_HAND_TOKEN must be preserved so spawn-hand can resolve the cheap-hand token"
  );
});
