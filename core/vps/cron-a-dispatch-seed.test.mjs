/**
 * @description Pins the hardened contract for `seedOpencodeRootConfig` + `materializeOpencodeRuntime`
 * (opencode headless hardening, #322 full runtime materialize). Permissions stay key-enforced;
 * the worktree must also receive a complete `.opencode/{skills,agents,plugin,tools,…}` layout so
 * headless `opencode run` can load triaging-requests / classify / entry-gate.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  seedOpencodeRootConfig,
  materializeOpencodeRuntime,
  isOpencodeRuntimeComplete,
  ocPluginFilesExist,
  rewriteOcPluginsToMonorepoCore,
  ensureOcPluginPathsExist,
  CANONICAL_OC_PLUGINS,
  DANGEROUS_BASH_DENYLIST,
} from "./cron-a-dispatch.mjs";
import { defaultOcPluginPaths } from "../claude-code/skills/initializing-projects/references/vendor-core.mjs";
import { RETIRED_OC_PERMISSION_ENTRIES, MANIFEST_FILENAME } from "../shared/lib/opencode-config-migration.mjs";


const CANONICAL_STUBS = [
  "entry-gate.ts",
  "marker-authority.ts",
  "ceremony-coordinator.ts",
  "second-eye-coordinator.ts",
  "plan-gate.ts",
  "planner-recovery.ts",
  "plan-write-gate.ts",
  "review-guard.ts",
  "reinject-state.ts",
  "version-check.ts",
  "harvest-guard.ts",
  "obs-plan-write.ts",
  "obs-eye.ts",
  "obs-hand.ts",
  "agent-idle-nudge.ts",
];

/** @description The 8 canonical secret-path deny patterns permission.read/edit must always carry. */
const CANONICAL_SECRET_DENIES = [
  ".env",
  ".env.*",
  "**/.env",
  "**/.env.*",
  ".dev.vars",
  "**/.dev.vars",
  "~/.ssh/**",
  "~/.aws/**",
];

test("OpenCode plugin[] is empty for harness; CANONICAL files stay on disk (auto-load)", () => {
  const root = JSON.parse(readFileSync(join(process.cwd(), "opencode.json"), "utf8")).plugin;
  const example = JSON.parse(readFileSync(join(process.cwd(), "core", "opencode", "opencode.json.example"), "utf8")).plugin;
  // Config must not list harness autoload paths (OC globs .opencode/plugin/*).
  assert.deepEqual(root ?? [], []);
  assert.deepEqual(example ?? [], []);
  assert.deepEqual(defaultOcPluginPaths(), []);
  assert.equal(CANONICAL_OC_PLUGINS.length, CANONICAL_STUBS.length);
  assert.ok(CANONICAL_OC_PLUGINS.length >= 10);
});

// --- #473 oc-permission-bash-parity ------------------------------------------------------

const CLAUDE_SETTINGS = JSON.parse(
  readFileSync(join(process.cwd(), "core", "claude-code", "settings.json"), "utf8"),
);

/**
 * @description Last-match-wins resolver over an OC `permission.bash` map, mirroring the REAL
 * OpenCode permission engine: `Permission.evaluate` resolves with `Array.prototype.findLast`
 * (confirmed by reading the installed `opencode` binary's minified source —
 * `K.flat().findLast((z) => match(...) && match(...))`) — the LAST entry in the object whose
 * pattern matches `command` wins, not the first and not the most specific. Iterates keys in
 * REVERSE insertion order (excluding the `"*"` fallback) and returns the first match found that
 * way, which is equivalent to `findLast` over the forward order.
 * @param {Record<string,string>} bashMap
 * @param {string} command
 * @returns {string}
 */
function resolveBash(bashMap, command) {
  const entries = Object.entries(bashMap).filter(([pattern]) => pattern !== "*");
  for (let i = entries.length - 1; i >= 0; i--) {
    const [pattern, action] = entries[i];
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    if (new RegExp(`^${escaped}$`).test(command)) return action;
  }
  return bashMap["*"];
}

/**
 * @description Builds a representative sample command for a `Bash(...)` allow pattern: the
 * `cmd:*` idiom gets a generic trailing arg (`cmd x`); a bare exact pattern (no `:*`) is used
 * verbatim. Lets the allowlist-parity test assert behavioral coverage without assuming the OC
 * glob key is byte-identical to the Claude Code pattern string (the two DSLs format prefix
 * matches differently, e.g. `Bash(gh:*)` vs OC's `"gh *"`).
 * @param {string} claudePattern
 * @returns {string}
 */
function claudeAllowToSample(claudePattern) {
  const inner = claudePattern.replace(/^Bash\(/, "").replace(/\)$/, "");
  return inner.endsWith(":*") ? `${inner.slice(0, -2)} x` : inner;
}

const CLAUDE_BASH_ALLOW_SAMPLES = CLAUDE_SETTINGS.permissions.allow
  .filter((p) => p.startsWith("Bash("))
  .map(claudeAllowToSample);

/** @description Real commands each of settings.json's 6 destructive-git Bash denies must block. */
const DESTRUCTIVE_GIT_SAMPLES = [
  "git reset --hard HEAD~1",
  "git push --force origin main",
  "git push origin --force",
  "git push -f origin main",
  "git push origin -f",
  "git clean -fd",
];

test("opencode.json + opencode.json.example: permission.bash contains the same broad allowlist as core/claude-code/settings.json (#ac-1.1)", () => {
  const configs = {
    root: JSON.parse(readFileSync(join(process.cwd(), "opencode.json"), "utf8")),
    example: JSON.parse(readFileSync(join(process.cwd(), "core", "opencode", "opencode.json.example"), "utf8")),
  };
  for (const [label, cfg] of Object.entries(configs)) {
    for (const sample of CLAUDE_BASH_ALLOW_SAMPLES) {
      assert.equal(
        resolveBash(cfg.permission.bash, sample),
        "allow",
        `${label} opencode.json permission.bash must allow ${JSON.stringify(sample)} (mirrors settings.json)`,
      );
    }
  }
});

test("opencode.json + opencode.json.example: permission.bash denies EXACTLY the 6 destructive-git classes from settings.json — no extras, and none of them swallow git push --force-with-lease (#ac-1.1/#ac-2.1/#ac-2.2)", () => {
  const claudeDenyCount = CLAUDE_SETTINGS.permissions.deny.filter((p) => p.startsWith("Bash(")).length;
  assert.equal(claudeDenyCount, 6, "settings.json must carry exactly 6 destructive-git Bash denies");
  const configs = {
    root: JSON.parse(readFileSync(join(process.cwd(), "opencode.json"), "utf8")),
    example: JSON.parse(readFileSync(join(process.cwd(), "core", "opencode", "opencode.json.example"), "utf8")),
  };
  for (const [label, cfg] of Object.entries(configs)) {
    const bash = cfg.permission.bash;
    const denyKeyCount = Object.entries(bash).filter(([key, value]) => key !== "*" && value === "deny").length;
    assert.equal(denyKeyCount, 6, `${label}: permission.bash must carry exactly 6 deny keys — no extras`);
    for (const sample of DESTRUCTIVE_GIT_SAMPLES) {
      assert.equal(resolveBash(bash, sample), "deny", `${label}: ${JSON.stringify(sample)} must resolve deny`);
    }
    assert.equal(
      resolveBash(bash, "git push --force-with-lease origin br"),
      "allow",
      `${label}: git push --force-with-lease must NOT be swallowed by the 6 destructive-git denies`,
    );
  }
});

test("opencode.json + opencode.json.example: permission.question resolves 'allow' locally (#ac-1.2)", () => {
  const root = JSON.parse(readFileSync(join(process.cwd(), "opencode.json"), "utf8"));
  const example = JSON.parse(readFileSync(join(process.cwd(), "core", "opencode", "opencode.json.example"), "utf8"));
  assert.equal(root.permission.question, "allow", "root opencode.json: permission.question must resolve 'allow' locally");
  assert.equal(example.permission.question, "allow", "opencode.json.example: permission.question must resolve 'allow' locally");
});

test("opencode.json + opencode.json.example: git push --force-with-lease resolves 'allow'; raw --force/-f stay 'deny' — the lease allow is ordered AFTER the broad deny so findLast (last-match-wins) picks it (#ac-2.1/#ac-2.2/#ac-2.3)", () => {
  const configs = {
    root: JSON.parse(readFileSync(join(process.cwd(), "opencode.json"), "utf8")),
    example: JSON.parse(readFileSync(join(process.cwd(), "core", "opencode", "opencode.json.example"), "utf8")),
  };
  for (const [label, cfg] of Object.entries(configs)) {
    const bash = cfg.permission.bash;
    assert.equal(resolveBash(bash, "git push --force-with-lease origin minha-branch"), "allow", `${label}: force-with-lease must resolve allow`);
    assert.equal(resolveBash(bash, "git push origin --force-with-lease"), "allow", `${label}: force-with-lease (remote-first form) must resolve allow`);
    assert.equal(resolveBash(bash, "git push --force origin main"), "deny", `${label}: raw --force must stay denied`);
    assert.equal(resolveBash(bash, "git push -f origin main"), "deny", `${label}: raw -f must stay denied`);
    assert.equal(resolveBash(bash, "git push origin --force"), "deny", `${label}: raw --force (remote-first form) must stay denied`);
    // #ac-2.3 invariant for THIS engine (findLast/last-match-wins, verified against the installed
    // opencode binary): the lease allow keys must be positioned AFTER (not before) the broader
    // --force/-f deny keys they would otherwise collide with — the opposite of a "most specific
    // rule wins" intuition. Locks the ORDER itself so a future edit can't silently un-invert it.
    const keys = Object.keys(bash);
    const leaseIdx = keys.indexOf("git push --force-with-lease*");
    const forceIdx = keys.indexOf("git push --force*");
    assert.ok(leaseIdx > -1 && forceIdx > -1, `${label}: both keys must exist`);
    assert.ok(leaseIdx > forceIdx, `${label}: git push --force-with-lease* must be ordered AFTER git push --force* (findLast picks the last match)`);
  }
});

/**
 * @description Minimal matcher for Claude Code's `Bash(...)` dialect, implementing only what's
 * needed to test our 2 narrowed deny patterns: per the official docs (code.claude.com/docs/en/permissions,
 * "Bash" section), a space immediately before a trailing `*` — or the equivalent `:*` suffix —
 * enforces a WORD BOUNDARY: the prefix must be followed by a space or end-of-string. `Bash(cmd *)`
 * matches `cmd foo` and bare `cmd`, but NOT `cmd-foo` (no boundary). A bare trailing `*` (no space)
 * has no such boundary. Deny always wins over allow in Claude Code regardless of pattern
 * specificity or file order ("Rules are evaluated in order: deny, then ask, then allow. The first
 * match in that order determines the outcome, and rule specificity doesn't change the order.") —
 * so the ONLY way to let force-with-lease through is to narrow the deny pattern itself, not reorder it.
 * @param {string} claudePattern
 * @param {string} command
 * @returns {boolean}
 */
function claudeBashMatches(claudePattern, command) {
  const inner = claudePattern.replace(/^Bash\(/, "").replace(/\)$/, "");
  // Reduce the `:*` idiom to its documented-equivalent literal " *" so one regex pass handles
  // both spellings; a trailing " *" (space before the star) enforces the word-boundary rule
  // (prefix followed by a space OR end-of-string) — a bare trailing "*" or an embedded "*" (e.g.
  // "git push * --force") is an ordinary unbounded wildcard, handled by the blanket replace below.
  const normalized = inner.endsWith(":*") ? `${inner.slice(0, -2)} *` : inner;
  const boundary = normalized.endsWith(" *");
  const body = boundary ? normalized.slice(0, -2) : normalized;
  const escapedBody = body.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  const suffix = boundary ? "(?: .*)?" : "";
  return new RegExp(`^${escapedBody}${suffix}$`).test(command);
}

/**
 * @description Resolves a command against settings.json's Bash rules using Claude Code's real
 * precedence: deny always wins over allow, unconditionally (see `claudeBashMatches` doc).
 * @param {object} settings
 * @param {string} command
 * @returns {"deny"|"allow"|"ask"}
 */
function resolveClaudeBash(settings, command) {
  const denies = settings.permissions.deny.filter((p) => p.startsWith("Bash("));
  if (denies.some((p) => claudeBashMatches(p, command))) return "deny";
  const allows = settings.permissions.allow.filter((p) => p.startsWith("Bash("));
  if (allows.some((p) => claudeBashMatches(p, command))) return "allow";
  return "ask";
}

test("settings.json: git push --force-with-lease resolves allow (deny narrowed with a word-boundary space); raw --force/-f stay denied; exactly 6 destructive-git denies (#ac-2.1/#ac-2.2)", () => {
  assert.equal(resolveClaudeBash(CLAUDE_SETTINGS, "git push --force-with-lease origin minha-branch"), "allow");
  assert.equal(resolveClaudeBash(CLAUDE_SETTINGS, "git push origin --force-with-lease"), "allow");
  assert.equal(resolveClaudeBash(CLAUDE_SETTINGS, "git push --force origin main"), "deny");
  assert.equal(resolveClaudeBash(CLAUDE_SETTINGS, "git push origin --force"), "deny");
  assert.equal(resolveClaudeBash(CLAUDE_SETTINGS, "git push -f origin main"), "deny");
  assert.equal(resolveClaudeBash(CLAUDE_SETTINGS, "git push origin -f"), "deny");
  const denyCount = CLAUDE_SETTINGS.permissions.deny.filter((p) => p.startsWith("Bash(")).length;
  assert.equal(denyCount, 6, "settings.json permissions.deny must still carry exactly 6 destructive-git Bash denies");
});

const CRITICAL_SKILLS = ["triaging-requests", "orchestrating-delivery", "brainstorming"];
const CANONICAL_ROUTING = JSON.parse(
  readFileSync(new URL("../opencode/harness.routing.json", import.meta.url), "utf8"),
);

function legacyRouting() {
  const legacy = structuredClone(CANONICAL_ROUTING);
  legacy.version = 1;
  for (const role of ["plan-reviewer", "adversary"]) {
    legacy.roles[role] = {
      model: legacy.roles[role].model ?? "openai/gpt-5.6-sol",
      dual: [{ model: "ollama-cloud/kimi-k2.7-code" }],
    };
  }
  return legacy;
}

/**
 * @description Minimal complete monorepo OC runtime under root/core/opencode (+ optional shared).
 * @param {string} root
 * @param {{ withSharedImport?: boolean }} [opts]
 */
function writeMinimalOcRuntime(root, opts = {}) {
  const oc = join(root, "core", "opencode");
  const plugin = join(oc, "plugin");
  mkdirSync(plugin, { recursive: true });
  for (const name of CANONICAL_STUBS) {
    let body = `// stub ${name}\n`;
    if (opts.withSharedImport && name === "entry-gate.ts") {
      body =
        `// stub entry-gate\n` +
        `const { x } = await import("../../shared/lib/path-helpers.mjs");\n`;
    }
    writeFileSync(join(plugin, name), body, "utf8");
  }
  for (const skill of CRITICAL_SKILLS) {
    const d = join(oc, "skills", skill);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "SKILL.md"), `# ${skill}\n`, "utf8");
  }
  mkdirSync(join(oc, "tools"), { recursive: true });
  writeFileSync(join(oc, "tools", "classify.ts"), "// classify stub\n", "utf8");
  mkdirSync(join(oc, "agents"), { recursive: true });
  writeFileSync(join(oc, "agents", "build.md"), "# build\n", "utf8");
  mkdirSync(join(oc, "hands"), { recursive: true });
  mkdirSync(join(oc, "rules"), { recursive: true });
  const lib = join(oc, "lib");
  mkdirSync(lib, { recursive: true });
  for (const name of ["gate-state.mjs", "entry-decide.mjs", "hand-records.mjs", "dispatch-scope.mjs"]) {
    writeFileSync(join(lib, name), `// critical lib ${name}\n`, "utf8");
  }
  writeFileSync(join(oc, "harness.routing.json"), `${JSON.stringify(CANONICAL_ROUTING)}\n`, "utf8");

  if (opts.withSharedImport) {
    const sharedLib = join(root, "core", "shared", "lib");
    mkdirSync(sharedLib, { recursive: true });
    writeFileSync(join(sharedLib, "path-helpers.mjs"), "export const x = 1;\n", "utf8");
  }
}

/** @description Write stub plugin files under root/core/opencode/plugin only (rewrite fallback). */
function writeMonorepoPluginStubs(root) {
  const corePlugin = join(root, "core", "opencode", "plugin");
  mkdirSync(corePlugin, { recursive: true });
  for (const name of CANONICAL_STUBS) {
    writeFileSync(join(corePlugin, name), `// stub ${name}\n`, "utf8");
  }
}

/**
 * @description Consumer-shaped complete .opencode under root.
 * @param {string} root
 */
function writeVendoredOcRuntime(root) {
  const oc = join(root, ".opencode");
  const plugin = join(oc, "plugin");
  mkdirSync(plugin, { recursive: true });
  for (const name of CANONICAL_STUBS) {
    writeFileSync(join(plugin, name), `// vendored ${name}\n`, "utf8");
  }
  for (const skill of CRITICAL_SKILLS) {
    const d = join(oc, "skills", skill);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "SKILL.md"), `# ${skill}\n`, "utf8");
  }
  mkdirSync(join(oc, "tools"), { recursive: true });
  writeFileSync(join(oc, "tools", "classify.ts"), "// classify\n", "utf8");
  mkdirSync(join(oc, "agents"), { recursive: true });
  writeFileSync(join(oc, "agents", "build.md"), "# build\n", "utf8");
  const lib = join(oc, "lib");
  mkdirSync(lib, { recursive: true });
  for (const name of ["gate-state.mjs", "entry-decide.mjs", "hand-records.mjs", "dispatch-scope.mjs"]) {
    writeFileSync(join(lib, name), `// vendored critical lib ${name}\n`, "utf8");
  }
}

/** @description Fresh temp root with projectRoot + worktree dirs. */
function makeSeedDirs(prefix, opts = {}) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const projectRoot = join(root, "proj");
  const worktree = join(root, "wt");
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  if (!opts.bare) {
    // Default monorepo fixture includes shared — materialize fail-closes without it.
    writeMinimalOcRuntime(projectRoot, { withSharedImport: true });
  }
  return { root, projectRoot, worktree };
}

/** @description Assert #ac-1.1 critical paths under worktree .opencode. */
function assertCriticalRuntime(worktree) {
  for (const rel of [
    ".opencode/skills/triaging-requests/SKILL.md",
    ".opencode/skills/orchestrating-delivery/SKILL.md",
    ".opencode/skills/brainstorming/SKILL.md",
    ".opencode/plugin/entry-gate.ts",
    ".opencode/tools/classify.ts",
    ".opencode/agents/build.md",
  ]) {
    assert.equal(existsSync(join(worktree, rel)), true, `missing ${rel}`);
  }
}

test("seedOpencodeRootConfig: forces permission.question to 'deny' even when the projectRoot source omits it", () => {
  const { root, projectRoot, worktree } = makeSeedDirs("oc-seed-question-");
  try {
    writeFileSync(
      join(projectRoot, "opencode.json"),
      JSON.stringify({ permission: { external_directory: "allow", bash: { "*": "allow" } } }),
    );
    seedOpencodeRootConfig(worktree, projectRoot);
    const cfg = JSON.parse(readFileSync(join(worktree, "opencode.json"), "utf8"));
    assert.equal(cfg.permission.question, "deny", "permission.question must be forced to 'deny' regardless of the stale source");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("seedOpencodeRootConfig: forces permission.question to 'deny' in the seeded worktree even when the projectRoot source explicitly carries the new local default 'allow' (#ac-1.2)", () => {
  const { root, projectRoot, worktree } = makeSeedDirs("oc-seed-question-local-allow-");
  try {
    writeFileSync(
      join(projectRoot, "opencode.json"),
      JSON.stringify({ permission: { question: "allow", external_directory: "allow", bash: { "*": "allow" } } }),
    );
    seedOpencodeRootConfig(worktree, projectRoot);
    const cfg = JSON.parse(readFileSync(join(worktree, "opencode.json"), "utf8"));
    assert.equal(
      cfg.permission.question,
      "deny",
      "the local session's 'allow' must NOT leak into the fleet-seeded worktree — deny stays worktree-only (#ac-1.2)",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("seedOpencodeRootConfig: forces permission.external_directory to 'allow' even when the projectRoot source omits it", () => {
  const { root, projectRoot, worktree } = makeSeedDirs("oc-seed-extdir-");
  try {
    writeFileSync(
      join(projectRoot, "opencode.json"),
      JSON.stringify({ permission: { question: "deny", bash: { "*": "allow" } } }),
    );
    seedOpencodeRootConfig(worktree, projectRoot);
    const cfg = JSON.parse(readFileSync(join(worktree, "opencode.json"), "utf8"));
    assert.equal(cfg.permission.external_directory, "allow", "permission.external_directory must be forced to 'allow'");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("seedOpencodeRootConfig: re-forces the dangerous-command bash deny-list entry when the projectRoot source dropped it", () => {
  const { root, projectRoot, worktree } = makeSeedDirs("oc-seed-denylist-");
  try {
    writeFileSync(
      join(projectRoot, "opencode.json"),
      JSON.stringify({
        permission: {
          question: "deny",
          external_directory: "allow",
          bash: { "*": "allow" },
        },
      }),
    );
    seedOpencodeRootConfig(worktree, projectRoot);
    const cfg = JSON.parse(readFileSync(join(worktree, "opencode.json"), "utf8"));
    assert.equal(cfg.permission.bash["*"], "allow", "permission.bash['*'] must remain 'allow'");
    assert.equal(
      cfg.permission.bash["git push --force*"],
      "deny",
      "permission.bash['git push --force*'] must be re-forced to 'deny' even when the source dropped it",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("seedOpencodeRootConfig: union-enforces canonical denies without dropping a project-specific extra deny from the source", () => {
  const { root, projectRoot, worktree } = makeSeedDirs("oc-seed-extra-deny-");
  try {
    writeFileSync(
      join(projectRoot, "opencode.json"),
      JSON.stringify({
        permission: {
          question: "deny",
          external_directory: "allow",
          bash: { "*": "allow", "kubectl delete*": "deny" },
        },
      }),
    );
    seedOpencodeRootConfig(worktree, projectRoot);
    const cfg = JSON.parse(readFileSync(join(worktree, "opencode.json"), "utf8"));
    assert.equal(
      cfg.permission.bash["kubectl delete*"],
      "deny",
      "a project-specific extra deny from the source must survive canonical-deny enforcement (union, never replace)",
    );
    assert.equal(cfg.permission.bash["*"], "allow", "permission.bash['*'] must remain 'allow'");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("seedOpencodeRootConfig: the example-fallback path is ALSO key-enforced when projectRoot has no opencode.json", () => {
  const { root, projectRoot, worktree } = makeSeedDirs("oc-seed-fallback-enforce-");
  try {
    writeFileSync(
      join(projectRoot, "core", "opencode", "opencode.json.example"),
      JSON.stringify({ permission: { bash: { "*": "allow" } } }),
    );
    seedOpencodeRootConfig(worktree, projectRoot);
    const cfg = JSON.parse(readFileSync(join(worktree, "opencode.json"), "utf8"));
    assert.equal(cfg.permission.question, "deny", "fallback-sourced config must also have permission.question forced to 'deny'");
    assert.equal(
      cfg.permission.external_directory,
      "allow",
      "fallback-sourced config must also have permission.external_directory forced to 'allow'",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("seedOpencodeRootConfig: migrates active Grok defaults and preserves custom non-Grok models", () => {
  for (const input of [
    { model: "xai/grok-4.5", small_model: "xai/grok-build-0.1", expected: ["openai/gpt-5.6-sol", "openai/gpt-5.5"] },
    { model: "custom/primary", small_model: "custom/small", expected: ["custom/primary", "custom/small"] },
    { model: "custom/grok-finetune", small_model: "acme/not-grok-small", expected: ["custom/grok-finetune", "acme/not-grok-small"] },
    { model: "xai/grok-private", small_model: "xai/grok-build-custom", expected: ["xai/grok-private", "xai/grok-build-custom"] },
  ]) {
    const { root, projectRoot, worktree } = makeSeedDirs("oc-seed-model-migrate-");
    try {
      writeFileSync(join(projectRoot, "opencode.json"), JSON.stringify(input));
      seedOpencodeRootConfig(worktree, projectRoot);
      const cfg = JSON.parse(readFileSync(join(worktree, "opencode.json"), "utf8"));
      assert.deepEqual([cfg.model, cfg.small_model], input.expected);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("seedOpencodeRootConfig: never promotes an unmerged sidecar and materializes routing v2", () => {
  const { root, projectRoot, worktree } = makeSeedDirs("oc-seed-sidecar-routing-");
  try {
    writeFileSync(join(projectRoot, "opencode.harness.json"), JSON.stringify({
      model: "xai/grok-4.3",
      small_model: "xai/grok-build-0.1",
      custom: "UNMERGED_SENTINEL",
    }));
    writeFileSync(
      join(projectRoot, "core", "opencode", "harness.routing.json"),
      JSON.stringify(legacyRouting()),
    );
    seedOpencodeRootConfig(worktree, projectRoot);
    const cfg = JSON.parse(readFileSync(join(worktree, "opencode.json"), "utf8"));
    const routing = JSON.parse(readFileSync(join(worktree, ".opencode", "harness.routing.json"), "utf8"));
    assert.equal(cfg.model, "openai/gpt-5.6-sol");
    assert.equal(cfg.small_model, "openai/gpt-5.5");
    assert.equal(cfg.custom, undefined);
    assert.equal(routing.version, 2);
    assert.equal(routing.roles.adversary.model, "openai/gpt-5.6-sol");
    assert.equal(typeof routing.roles.adversary.secondEyeModel, "string");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("seedOpencodeRootConfig: rejects an unknown materialized routing version", () => {
  const { root, projectRoot, worktree } = makeSeedDirs("oc-seed-routing-v3-");
  try {
    writeFileSync(
      join(projectRoot, "core", "opencode", "harness.routing.json"),
      JSON.stringify({ ...CANONICAL_ROUTING, version: 3 }),
    );
    assert.throws(
      () => seedOpencodeRootConfig(worktree, projectRoot),
      /routing version unsupported: 3/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("seedOpencodeRootConfig: accepts routing v2 with single evaluators and no families (#576 ac-2.1)", () => {
  const { root, projectRoot, worktree } = makeSeedDirs("oc-seed-routing-single-evaluator-");
  try {
    const routing = structuredClone(CANONICAL_ROUTING);
    routing.roles["plan-reviewer"] = { model: "openai/gpt-5.6-sol" };
    routing.roles.adversary = { model: "openai/gpt-5.6-sol" };
    delete routing.constraints;
    writeFileSync(
      join(projectRoot, "core", "opencode", "harness.routing.json"),
      JSON.stringify(routing),
    );

    assert.doesNotThrow(() => seedOpencodeRootConfig(worktree, projectRoot));
    const materialized = JSON.parse(
      readFileSync(join(worktree, ".opencode", "harness.routing.json"), "utf8"),
    );
    assert.deepEqual(materialized.roles.adversary, { model: "openai/gpt-5.6-sol" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("seedOpencodeRootConfig: preserves the return-shape contract — 'copied' still includes 'opencode.json' when a projectRoot source is written", () => {
  const { root, projectRoot, worktree } = makeSeedDirs("oc-seed-return-shape-");
  try {
    writeFileSync(
      join(projectRoot, "opencode.json"),
      JSON.stringify({
        permission: { question: "deny", external_directory: "allow", bash: { "*": "allow" } },
      }),
    );
    const r = seedOpencodeRootConfig(worktree, projectRoot);
    assert.ok(
      Array.isArray(r.copied) && r.copied.includes("opencode.json"),
      "the returned copied array must include 'opencode.json' (task-1's pinned return-shape contract)",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("seedOpencodeRootConfig: fail-safe on malformed projectRoot opencode.json — falls back to the vendored example, never throws, never leaves a permissive config", () => {
  const { root, projectRoot, worktree } = makeSeedDirs("oc-seed-malformed-");
  try {
    writeFileSync(join(projectRoot, "opencode.json"), "{ invalid json");
    writeFileSync(
      join(projectRoot, "core", "opencode", "opencode.json.example"),
      JSON.stringify({
        permission: {
          question: "deny",
          external_directory: "allow",
          bash: { "*": "allow", "git push --force*": "deny", "rm -rf*": "deny" },
        },
      }),
    );
    assert.doesNotThrow(() => seedOpencodeRootConfig(worktree, projectRoot), "a malformed source config must never throw");
    const cfg = JSON.parse(readFileSync(join(worktree, "opencode.json"), "utf8"));
    assert.equal(cfg.permission.question, "deny");
    assert.equal(cfg.permission.external_directory, "allow");
    assert.equal(cfg.permission.bash["*"], "allow");
    assert.equal(
      cfg.permission.bash["git push --force*"],
      "deny",
      "malformed source must never propagate into a permissive worktree config — deny-list entries must be intact",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("seedOpencodeRootConfig: double-fault — malformed projectRoot config AND no readable example candidate — never throws, still writes safe denies from the in-code constant", () => {
  const { root, projectRoot, worktree } = makeSeedDirs("oc-seed-double-fault-");
  try {
    writeFileSync(join(projectRoot, "opencode.json"), "{ invalid json");
    // Deliberately no opencode.json.example — a genuine double-fault for config, but runtime source exists.
    assert.doesNotThrow(() => seedOpencodeRootConfig(worktree, projectRoot), "a double-fault (malformed source + no example) must never throw");
    const cfg = JSON.parse(readFileSync(join(worktree, "opencode.json"), "utf8"));
    assert.equal(cfg.permission.question, "deny");
    assert.equal(cfg.permission.external_directory, "allow");
    assert.equal(cfg.permission.bash["*"], "allow");
    assert.equal(
      cfg.permission.bash["git push --force*"],
      "deny",
      "on a double-fault the dangerous-command deny entries must come from the in-code DANGEROUS_BASH_DENYLIST constant — never an allow-all bash lacking denies",
    );
    // #ac-2.1/#ac-2.2: even on a genuine double-fault, DANGEROUS_BASH_DENYLIST itself (not just
    // the project's own opencode.json) must allow force-with-lease while still denying raw
    // --force/-f — the fleet's own fallback safety net must never regress the parity decision.
    assert.equal(
      resolveBash(cfg.permission.bash, "git push --force-with-lease origin minha-branch"),
      "allow",
      "double-fault worktree config must still allow git push --force-with-lease (DANGEROUS_BASH_DENYLIST fallback)",
    );
    assert.equal(
      resolveBash(cfg.permission.bash, "git push --force origin main"),
      "deny",
      "double-fault worktree config must still deny raw git push --force",
    );
    // DANGEROUS_BASH_DENYLIST must ALSO carry the remote-first (`git push * --force*`/`* -f*`)
    // variants — without them, a double-fault would silently allow `git push origin --force`
    // through the default "*": "allow" fallback (no entry in the pure denylist-only bash map
    // would match it).
    assert.equal(
      resolveBash(cfg.permission.bash, "git push origin --force"),
      "deny",
      "double-fault worktree config must deny the remote-first raw --force form too",
    );
    assert.equal(
      resolveBash(cfg.permission.bash, "git push origin -f"),
      "deny",
      "double-fault worktree config must deny the remote-first raw -f form too",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- #486 oc-fleet-seed-migration ---------------------------------------------------------

test("DANGEROUS_BASH_DENYLIST: frozen fallback denies EXACTLY the 6 destructive-git classes from settings.json plus the #499 fleet-only hardening classes (bash -c/node -e/python -c/npx/bunx/tar/source and their sibling spellings) — no OpenCode-only extras (sudo/rm-rf/chmod/nc/dd/fork-bomb/git-add/no-verify) (#ac-1.3, denylist_final)", () => {
  const denyKeys = Object.entries(DANGEROUS_BASH_DENYLIST)
    .filter(([, value]) => value === "deny")
    .map(([key]) => key);
  const expectedDenyKeys = [
    "git push --force*",
    "git push * --force*",
    "git push -f*",
    "git push * -f*",
    "git reset --hard*",
    "git clean -f*",
    "bash -c*",
    "sh -c*",
    "zsh -c*",
    "*/bash -c*",
    "env bash -c*",
    "node -e*",
    "node --eval*",
    "node -p*",
    "node --print*",
    "python -c*",
    "python3 -c*",
    "python3.* -c*",
    "python* -m*",
    "npx *",
    "npm exec*",
    "npm x *",
    "pnpm dlx*",
    "yarn dlx*",
    "bun x*",
    "bunx *",
    "tar -x*",
    "tar --extract*",
    "tar x*",
    "unzip *",
    "source *",
    ". *",
  ];
  assert.deepEqual(
    denyKeys,
    expectedDenyKeys,
    `DANGEROUS_BASH_DENYLIST deny keys drifted from the pinned list — no extras, none missing, order preserved (order is load-bearing for findLast). Got ${JSON.stringify(denyKeys)}`,
  );
  for (const key of expectedDenyKeys) {
    assert.equal(DANGEROUS_BASH_DENYLIST[key], "deny", `DANGEROUS_BASH_DENYLIST must deny ${JSON.stringify(key)}`);
  }
  for (const retiredClass of [
    "sudo *",
    "* | sh",
    "* | bash",
    "chmod 777*",
    "chmod -R 777*",
    "nc *",
    "ncat *",
    "dd if=*",
    ":(){ :|:& };:",
    "rm -rf /",
    "rm -rf /*",
    "rm -fr /",
    "rm -fr /*",
    "git add .",
    "git add -A*",
    "git add --all*",
    "git commit --no-verify*",
  ]) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(DANGEROUS_BASH_DENYLIST, retiredClass),
      false,
      `DANGEROUS_BASH_DENYLIST must not resurrect the #475-retired OpenCode-only class ${JSON.stringify(retiredClass)} — issue #499's scope is limited to bash -c/node -e/python -c/npx/bunx/tar/source, not the full pre-#475 wall`,
    );
  }
});

test("DANGEROUS_BASH_DENYLIST: the FULL allow-key list is pinned — a future edit that widens or adds a carve-out must update this test, not slip in silently (the exact gap the compliance review caught: only deny keys were counted, so a new allow needed no review)", () => {
  const allowKeys = Object.entries(DANGEROUS_BASH_DENYLIST)
    .filter(([, value]) => value === "allow")
    .map(([key]) => key);
  assert.deepEqual(allowKeys, [
    "git push --force-with-lease*",
    "git push * --force-with-lease*",
    "npx tsc --noEmit*",
    "npx github:orobsonn/claude-harness#v* init*",
    "npx -y github:orobsonn/claude-harness#v* init*",
    'npx -y "github:orobsonn/claude-harness#v*" init*',
    "npx @orobsonn/claude-harness init*",
    "npx @orobsonn/claude-harness setup-*",
    "npx vitest*",
    "npx jest*",
    "npx mocha*",
    "npx --no-install vitest*",
    "npx --no-install jest*",
    "npx --no-install mocha*",
    "npx -y vitest*",
    "npx -y jest*",
    "npx -y mocha*",
    "npx --yes vitest*",
    "npx --yes jest*",
    "npx --yes mocha*",
  ], `DANGEROUS_BASH_DENYLIST allow keys drifted from the pinned list, got ${JSON.stringify(allowKeys)}`);
});

test("DANGEROUS_BASH_DENYLIST: #499 hardening denies bash -c, node -e, python -c/python3 -c, npx, bunx, tar extraction, source, AND the sibling spellings (sh -c/zsh -c/env bash -c, node --eval/-p/--print, python3.x -c, python -m, npm exec/x, pnpm/yarn dlx, bun x, tar --extract/tar x, unzip, dot-source) — the forms an adversarial round found still resolved allow (#ac-1.1, #uj-1)", () => {
  const bash = { "*": "allow", ...DANGEROUS_BASH_DENYLIST };
  bash["*"] = "allow";
  for (const command of [
    'bash -c "echo x"',
    'sh -c "echo x"',
    'zsh -c "echo x"',
    '/bin/bash -c "echo x"',
    'env bash -c "echo x"',
    'node -e "1"',
    'node --eval "1"',
    'node -p "1"',
    'node --print "1"',
    'python -c "1"',
    'python3 -c "1"',
    'python3.12 -c "1"',
    "python -m http.server",
    "python3 -m pip install evil",
    "npx anything",
    "npm exec cowsay hi",
    "npm x cowsay hi",
    "pnpm dlx cowsay hi",
    "yarn dlx cowsay hi",
    "bun x cowsay hi",
    "bunx anything",
    "tar -xf x.tgz",
    "tar --extract -f x.tgz",
    "tar xf x.tgz",
    "unzip x.zip",
    "source ./x.sh",
    ". ./x.sh",
  ]) {
    assert.equal(resolveBash(bash, command), "deny", `DANGEROUS_BASH_DENYLIST must deny ${JSON.stringify(command)}`);
  }
});

test("DANGEROUS_BASH_DENYLIST: the #499 hardening does not deny the harness's own prescribed npx commands (typecheck gate, self-installer in BOTH documented forms, and the locked-test runner) that the fleet already runs in production (#ac-1.2, #uj-2, zero regression)", () => {
  const bash = { "*": "allow", ...DANGEROUS_BASH_DENYLIST };
  bash["*"] = "allow";
  for (const command of [
    // typecheck gate
    "npx tsc --noEmit",
    // self-installer — GitHub-ref form (README.md alternate form + pinned/legacy tag variants)
    'npx -y "github:orobsonn/claude-harness#v0.51.0" init --target opencode',
    'npx -y "github:orobsonn/claude-harness#v0.51.0" init --target claude',
    'npx -y "github:orobsonn/claude-harness#v0.51.0" init --target both',
    "npx github:orobsonn/claude-harness#v0.45.0 init --target opencode",
    "npx -y github:orobsonn/claude-harness#v0.45.0 init --target opencode",
    // self-installer — published npm-scoped package form (README.md:259/267/292)
    "npx @orobsonn/claude-harness init --target opencode",
    "npx @orobsonn/claude-harness setup-local",
    "npx @orobsonn/claude-harness setup-vps",
    // locked-test runner — core/shared/lib/validate-plan.mjs's isAllowlistedLockedTestCommand,
    // prescribed by executor-{low,medium,high}.md and build.md against the frozen test snapshot
    "npx vitest run tests/a.spec.ts",
    "npx --no-install vitest run --reporter=json tests/a.spec.ts",
    "npx -y vitest run tests/a.spec.ts",
    "npx jest tests/a.spec.ts",
    "npx mocha tests/a.spec.ts",
  ]) {
    assert.equal(resolveBash(bash, command), "allow", `DANGEROUS_BASH_DENYLIST must still allow the prescribed command ${JSON.stringify(command)}`);
  }
  // #ac-1.1 must still hold: the carve-outs are narrow enough that the AC's own generic sample
  // (no runner/installer substring) still resolves deny.
  assert.equal(resolveBash(bash, "npx anything"), "deny", "a generic npx invocation outside the prescribed set must still be denied");
});

test("DANGEROUS_BASH_DENYLIST: the npx runner/installer carve-outs are anchored at the START of the command — a substring-anywhere carve-out would let an attacker smuggle an allowed command past the new npx deny by appending the runner name as a trailing token", () => {
  const bash = { "*": "allow", ...DANGEROUS_BASH_DENYLIST };
  bash["*"] = "allow";
  for (const command of [
    "npx evil-package vitest",
    "npx exfil-tool --config vitest.config.ts",
    "npx curl-pipe-thing # vitest",
    'npx some-pkg && cat ~/.ssh/id_rsa # jest',
    "npx malicious-mocha-lookalike-tool",
    "npx not-orobsonn/claude-harness-clone init",
    "npx @orobsonn/claude-harness-not-really-ours x",
    // #499 review round 2: the FIRST fix for the installer carve-out (`npx
    // *orobsonn/claude-harness#*init*`) still had a leading `*` before the org name — it let an
    // attacker's OWN package name (the actual thing npx executes) through as long as the literal
    // substring "orobsonn/claude-harness#" and "init" appeared LATER in the same command string.
    "npx -y evilpkg orobsonn/claude-harness# init",
    "npx github:attacker/orobsonn/claude-harness#main init",
  ]) {
    assert.equal(resolveBash(bash, command), "deny", `an npx command that merely CONTAINS a carved-out runner/installer name must still be denied: ${JSON.stringify(command)}`);
  }
  // The legitimate, anchored forms must still resolve allow.
  for (const command of [
    "npx github:orobsonn/claude-harness#v0.45.0 init --target opencode",
    "npx -y github:orobsonn/claude-harness#v0.45.0 init --target opencode",
    'npx -y "github:orobsonn/claude-harness#v0.51.0" init --target opencode',
  ]) {
    assert.equal(resolveBash(bash, command), "allow", `the legitimate anchored installer form must still resolve allow: ${JSON.stringify(command)}`);
  }
});

test("seedOpencodeRootConfig: #499 hardening survives the REAL 3-source merge (baseBash + exampleBash + DANGEROUS_BASH_DENYLIST) — the fleet's own prescribed npx allows are declared EARLY by the project's real opencode.json.example, and must still win over the new broad npx/bunx/etc denies added LAST by the denylist (#ac-1.1, #ac-1.2)", () => {
  const { root, projectRoot, worktree } = makeSeedDirs("oc-seed-499-hardening-");
  try {
    writeFileSync(
      join(projectRoot, "core", "opencode", "opencode.json.example"),
      JSON.stringify({
        permission: {
          question: "deny",
          external_directory: "allow",
          bash: {
            "*": "ask",
            "npx tsc --noEmit": "allow",
            'npx -y "github:orobsonn/claude-harness#v*" init --target opencode': "allow",
            "npm test*": "allow",
            "node*": "allow",
            "git status*": "allow",
          },
        },
      }),
    );
    seedOpencodeRootConfig(worktree, projectRoot);
    const cfg = JSON.parse(readFileSync(join(worktree, "opencode.json"), "utf8"));
    const bash = cfg.permission.bash;
    // #ac-1.1: the new dangerous forms are denied even though they came through the full merge,
    // not just the isolated DANGEROUS_BASH_DENYLIST constant.
    for (const command of [
      'bash -c "echo x"',
      'node -e "1"',
      'python3 -c "1"',
      "npx anything",
      "bunx anything",
      "tar -xf x.tgz",
      "source ./x.sh",
    ]) {
      assert.equal(resolveBash(bash, command), "deny", `seeded worktree must deny ${JSON.stringify(command)}`);
    }
    // #ac-1.2: the project's OWN early-declared prescribed npx allows (typecheck + installer) must
    // NOT be shadowed by the new broad "npx *" deny appended after them by DANGEROUS_BASH_DENYLIST —
    // this is the exact ordering hazard the [#499] doc comment on DANGEROUS_BASH_DENYLIST calls out.
    assert.equal(resolveBash(bash, "npx tsc --noEmit"), "allow", "npx typecheck gate must not regress");
    assert.equal(
      resolveBash(bash, 'npx -y "github:orobsonn/claude-harness#v0.51.0" init --target opencode'),
      "allow",
      "npx self-installer must not regress",
    );
    // #ac-1.2: the npm-scoped installer form and the locked-test runner are NOT declared by this
    // project's own opencode.json.example fixture above — they only survive because
    // DANGEROUS_BASH_DENYLIST itself carries the carve-out, proving the fix does not depend on a
    // consumer project happening to declare these commands.
    assert.equal(resolveBash(bash, "npx @orobsonn/claude-harness init --target opencode"), "allow", "npm-scoped installer must not regress");
    assert.equal(resolveBash(bash, "npx vitest run tests/a.spec.ts"), "allow", "locked-test runner (vitest) must not regress");
    assert.equal(resolveBash(bash, "npx jest tests/a.spec.ts"), "allow", "locked-test runner (jest) must not regress");
    // Untouched prescribed commands must resolve exactly as before.
    assert.equal(resolveBash(bash, "npm test foo"), "allow");
    assert.equal(resolveBash(bash, "node script.js"), "allow");
    assert.equal(resolveBash(bash, "git status"), "allow");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("DANGEROUS_BASH_DENYLIST and RETIRED_OC_PERMISSION_ENTRIES are disjoint — no bash key can be simultaneously frozen-forced and marked droppable by the migration ledger (#ac-1.3)", () => {
  const denylistKeys = new Set(Object.keys(DANGEROUS_BASH_DENYLIST));
  const retiredBashKeys = RETIRED_OC_PERMISSION_ENTRIES.filter((entry) => entry.path[0] === "bash").map(
    (entry) => entry.path[1],
  );
  assert.ok(retiredBashKeys.length > 0, "sanity: the retirement ledger must carry at least one bash entry");
  for (const key of retiredBashKeys) {
    assert.equal(
      denylistKeys.has(key),
      false,
      `retired ledger key ${JSON.stringify(key)} must not also be frozen in DANGEROUS_BASH_DENYLIST`,
    );
  }
});

/**
 * @description Writes a minimal `core/opencode/opencode.json.example` with `permission.bash` as a
 * real (possibly empty) object. `migrateOpencodeConfig`'s merge only recurses INTO a nested key
 * (e.g. `bash`) when the new-generation side also has that key as a plain object — without this,
 * the whole `bash` map is compared as one atomic leaf against the ledger (which is keyed at
 * `["bash", "<command>"]`, never `["bash"]` alone) and nothing inside it can ever be recognized as
 * retired. Every real vendored project ships an example with `permission.bash` populated, so this
 * mirrors production shape while staying minimal for the test.
 * @param {string} projectRoot
 */
function writeMinimalPermissionExample(projectRoot) {
  writeFileSync(
    join(projectRoot, "core", "opencode", "opencode.json.example"),
    JSON.stringify({ permission: { bash: {} } }),
  );
}

test("seedOpencodeRootConfig: a projectRoot config carrying a retired permission entry (still equal to its ledger historicalValue, harness provenance present) seeds a worktree CLEAN of it (#ac-1.1)", () => {
  const { root, projectRoot, worktree } = makeSeedDirs("oc-seed-retired-drop-");
  try {
    writeMinimalPermissionExample(projectRoot);
    writeFileSync(
      join(projectRoot, "opencode.json"),
      JSON.stringify({
        permission: {
          question: "deny",
          external_directory: "allow",
          bash: {
            "*": "allow",
            "npx github:orobsonn/claude-harness#* init*": "allow",
            // NOT in the ledger (issue #513 adversarial finding): no evidence the harness ever
            // shipped this wildcard form — the shipped default has always been the narrower
            // "git pull" (no wildcard) — so it must survive untouched, never dropped as "retired".
            "git pull*": "allow",
          },
        },
      }),
    );
    mkdirSync(join(projectRoot, ".opencode"), { recursive: true });
    writeFileSync(join(projectRoot, ".opencode", ".harness-version"), "a1b2c3d4e5f6\n");
    seedOpencodeRootConfig(worktree, projectRoot);
    const cfg = JSON.parse(readFileSync(join(worktree, "opencode.json"), "utf8"));
    assert.equal(
      Object.prototype.hasOwnProperty.call(cfg.permission.bash, "npx github:orobsonn/claude-harness#* init*"),
      false,
      "the retired unpinned npx wildcard key must be dropped from the seeded worktree config",
    );
    assert.equal(
      cfg.permission.bash["git pull*"],
      "allow",
      "git pull* is NOT a ledger entry (no evidence it was ever a harness default) — it must survive, not be dropped",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("seedOpencodeRootConfig: an operator custom bash deny that is NOT in the retirement ledger survives seeding untouched (#ac-1.2)", () => {
  const { root, projectRoot, worktree } = makeSeedDirs("oc-seed-retired-keep-custom-");
  try {
    writeMinimalPermissionExample(projectRoot);
    writeFileSync(
      join(projectRoot, "opencode.json"),
      JSON.stringify({
        permission: {
          question: "deny",
          external_directory: "allow",
          bash: { "*": "allow", "kubectl delete*": "deny" },
        },
      }),
    );
    mkdirSync(join(projectRoot, ".opencode"), { recursive: true });
    writeFileSync(join(projectRoot, ".opencode", ".harness-version"), "a1b2c3d4e5f6\n");
    seedOpencodeRootConfig(worktree, projectRoot);
    const cfg = JSON.parse(readFileSync(join(worktree, "opencode.json"), "utf8"));
    assert.equal(
      cfg.permission.bash["kubectl delete*"],
      "deny",
      "an operator-authored deny outside the retirement ledger must survive the migration + seed untouched",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("issue #513 ac-1: seedOpencodeRootConfig drops a retired-shaped entry by content match EVEN WHEN the project's version stamp is newer than the ledger's historical shipping generation", () => {
  const { root, projectRoot, worktree } = makeSeedDirs("oc-seed-retired-past-cutoff-");
  try {
    writeMinimalPermissionExample(projectRoot);
    writeFileSync(
      join(projectRoot, "opencode.json"),
      JSON.stringify({
        permission: {
          question: "deny",
          external_directory: "allow",
          bash: { "*": "allow", "npx github:orobsonn/claude-harness#* init*": "allow" },
        },
      }),
    );
    mkdirSync(join(projectRoot, ".opencode"), { recursive: true });
    // Real-population case #513 reports: seeded before the entry's retirement, re-vendored after it
    // (while the fleet-seed migration engine itself didn't exist yet) — a version stamp well past
    // the entry's historical last-shipped generation, still carrying the exact retired value.
    writeFileSync(join(projectRoot, ".opencode", ".harness-version"), "v0.49.0\n");
    seedOpencodeRootConfig(worktree, projectRoot);
    const cfg = JSON.parse(readFileSync(join(worktree, "opencode.json"), "utf8"));
    assert.equal(
      Object.prototype.hasOwnProperty.call(cfg.permission.bash, "npx github:orobsonn/claude-harness#* init*"),
      false,
      "a retired key must be dropped by content match alone, regardless of the project's own generation stamp — the project HAS harness provenance (a legible .harness-version stamp), so a coincidental match cannot be the operator's own doing",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("seedOpencodeRootConfig: with no readable .harness-version and no manifest, a retired-shaped key is treated as unknown provenance and is kept, never guessed away (#ac-1.2)", () => {
  const { root, projectRoot, worktree } = makeSeedDirs("oc-seed-retired-no-stamp-");
  try {
    writeMinimalPermissionExample(projectRoot);
    writeFileSync(
      join(projectRoot, "opencode.json"),
      JSON.stringify({
        permission: {
          question: "deny",
          external_directory: "allow",
          bash: { "*": "allow", "npx github:orobsonn/claude-harness#* init*": "allow" },
        },
      }),
    );
    // No .opencode/.harness-version and no manifest — zero harness provenance.
    seedOpencodeRootConfig(worktree, projectRoot);
    const cfg = JSON.parse(readFileSync(join(worktree, "opencode.json"), "utf8"));
    assert.equal(
      cfg.permission.bash["npx github:orobsonn/claude-harness#* init*"],
      "allow",
      "without a version stamp the migration must never guess a key is retired — it must survive",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("seedOpencodeRootConfig: a tier-1 manifest (harness-owned key still matching what the manifest recorded) also drops the retired entry, without writing anything back to projectRoot (#ac-1.1)", () => {
  const { root, projectRoot, worktree } = makeSeedDirs("oc-seed-retired-manifest-");
  try {
    writeMinimalPermissionExample(projectRoot);
    writeFileSync(
      join(projectRoot, "opencode.json"),
      JSON.stringify({
        permission: {
          question: "deny",
          external_directory: "allow",
          bash: { "*": "allow", "npx github:orobsonn/claude-harness#* init*": "allow" },
        },
      }),
    );
    mkdirSync(join(projectRoot, ".opencode"), { recursive: true });
    writeFileSync(
      join(projectRoot, ".opencode", MANIFEST_FILENAME),
      JSON.stringify({
        version: 1,
        harnessVersion: "v0.45.0",
        owned: { bash: { "npx github:orobsonn/claude-harness#* init*": "allow" } },
      }),
    );
    const manifestBefore = readFileSync(join(projectRoot, ".opencode", MANIFEST_FILENAME), "utf8");
    seedOpencodeRootConfig(worktree, projectRoot);
    const cfg = JSON.parse(readFileSync(join(worktree, "opencode.json"), "utf8"));
    assert.equal(
      Object.prototype.hasOwnProperty.call(cfg.permission.bash, "npx github:orobsonn/claude-harness#* init*"),
      false,
      "a manifest-owned retired key must also be dropped from the seeded worktree",
    );
    assert.equal(
      readFileSync(join(projectRoot, ".opencode", MANIFEST_FILENAME), "utf8"),
      manifestBefore,
      "the fleet seed path is read-only against projectRoot — it must never rewrite the operator's own manifest",
    );
    assert.equal(
      existsSync(join(projectRoot, "opencode.json.pre-migration.bak")),
      false,
      "the fleet seed path must never write a migration backup into the operator's tracked tree",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("seedOpencodeRootConfig: permission.bash['*'] stays 'allow' in the seeded worktree regardless of migration — the fleet residue this forces is ledger-recognized (RETIRED_OC_PERMISSION_ENTRIES ['bash','*']), never leaked as a NEW unrecognized default (#ac-1.4)", () => {
  const wildcardEntry = RETIRED_OC_PERMISSION_ENTRIES.find(
    (entry) => entry.path[0] === "bash" && entry.path[1] === "*",
  );
  assert.ok(wildcardEntry, "the ledger must already track bash['*']:'allow' as recognized fleet residue");
  assert.equal(wildcardEntry.historicalValue, "allow");

  const { root, projectRoot, worktree } = makeSeedDirs("oc-seed-wildcard-residue-");
  try {
    writeFileSync(
      join(projectRoot, "opencode.json"),
      JSON.stringify({ permission: { bash: { "*": "ask" } } }),
    );
    seedOpencodeRootConfig(worktree, projectRoot);
    const cfg = JSON.parse(readFileSync(join(worktree, "opencode.json"), "utf8"));
    assert.equal(
      cfg.permission.bash["*"],
      "allow",
      "worktree bash['*'] must stay 'allow' — scoped to the ephemeral worktree, per the ledger-recognized entry",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("seedOpencodeRootConfig: [orphan-state, double-fault] malformed source still seeds permissions + disk plugins (not plugin[])", () => {
  const { root, projectRoot, worktree } = makeSeedDirs("oc-seed-double-fault-plugin-");
  try {
    writeFileSync(join(projectRoot, "opencode.json"), "{ this is not json");
    assert.doesNotThrow(() => seedOpencodeRootConfig(worktree, projectRoot), "malformed source must not throw when runtime source exists");
    const cfg = JSON.parse(readFileSync(join(worktree, "opencode.json"), "utf8"));
    // OC auto-loads .opencode/plugin/* — plugin[] must not re-list harness paths
    assert.ok(Array.isArray(cfg.plugin));
    assert.equal(cfg.plugin.length, 0, `plugin[] must be empty for harness, got ${JSON.stringify(cfg.plugin)}`);
    assert.equal(existsSync(join(worktree, ".opencode/plugin/obs-eye.ts")), true);
    assert.equal(existsSync(join(worktree, ".opencode/plugin/entry-gate.ts")), true);
    assert.equal(cfg.permission.question, "deny");
    // This fixture has no opencode.json.example anywhere either (writeMinimalOcRuntime doesn't
    // write one) — same starved-permission-source shape as a real double-fault. Pin the actual
    // resulting deny set here (not just DANGEROUS_BASH_DENYLIST's own shape, already covered
    // elsewhere) so a future regression in the [baseBash, exampleBash, DANGEROUS_BASH_DENYLIST]
    // union — the exact class of bug issue #282 was about — fails THIS executable path, not just
    // a structural assertion on the constant in isolation.
    const denyKeys = Object.fromEntries(Object.entries(cfg.permission.bash).filter(([, v]) => v === "deny"));
    assert.deepEqual(denyKeys, {
      "git push --force*": "deny",
      "git push * --force*": "deny",
      "git push -f*": "deny",
      "git push * -f*": "deny",
      "git reset --hard*": "deny",
      "git clean -f*": "deny",
      "bash -c*": "deny",
      "sh -c*": "deny",
      "zsh -c*": "deny",
      "*/bash -c*": "deny",
      "env bash -c*": "deny",
      "node -e*": "deny",
      "node --eval*": "deny",
      "node -p*": "deny",
      "node --print*": "deny",
      "python -c*": "deny",
      "python3 -c*": "deny",
      "python3.* -c*": "deny",
      "python* -m*": "deny",
      "npx *": "deny",
      "npm exec*": "deny",
      "npm x *": "deny",
      "pnpm dlx*": "deny",
      "yarn dlx*": "deny",
      "bun x*": "deny",
      "bunx *": "deny",
      "tar -x*": "deny",
      "tar --extract*": "deny",
      "tar x*": "deny",
      "unzip *": "deny",
      "source *": "deny",
      ". *": "deny",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


// ── #315 / #322 OC runtime materialize + plugin paths ─────────────────────

test("rewriteOcPluginsToMonorepoCore: maps .opencode/plugin → core/opencode/plugin", () => {
  assert.deepEqual(
    rewriteOcPluginsToMonorepoCore([
      "./.opencode/plugin/entry-gate.ts",
      "./.opencode/plugin/plan-gate.ts",
    ]),
    ["./core/opencode/plugin/entry-gate.ts", "./core/opencode/plugin/plan-gate.ts"],
  );
});

test("materializeOpencodeRuntime + seed: monorepo fixture → critical paths + canonical plugin[] (#ac-1.1 #ac-1.2 #ac-1.3)", () => {
  const { root, projectRoot, worktree } = makeSeedDirs("oc-seed-mono-mat-");
  try {
    writeFileSync(
      join(projectRoot, "opencode.json"),
      JSON.stringify({
        plugin: ["./.opencode/plugin/entry-gate.ts", "./.opencode/plugin/plan-gate.ts"],
        permission: { bash: { "*": "allow" } },
      }),
    );
    const mat = materializeOpencodeRuntime(worktree, projectRoot);
    assert.equal(mat.source, "monorepo");
    assertCriticalRuntime(worktree);
    assert.equal(isOpencodeRuntimeComplete(join(worktree, ".opencode")), true);

    seedOpencodeRootConfig(worktree, projectRoot);
    const cfg = JSON.parse(readFileSync(join(worktree, "opencode.json"), "utf8"));
    assert.ok(Array.isArray(cfg.plugin));
    assert.equal(cfg.plugin.length, 0, "harness paths stripped from plugin[] (OC auto-load)");
    assert.equal(ocPluginFilesExist(worktree, [...CANONICAL_OC_PLUGINS]), true);
    assert.equal(existsSync(join(worktree, ".opencode/plugin/entry-gate.ts")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("materializeOpencodeRuntime: closure-11 critical libs are required and copied into the headless runtime", () => {
  const { root, projectRoot, worktree } = makeSeedDirs("oc-seed-closure-11-");
  const criticalLibs = ["gate-state.mjs", "entry-decide.mjs", "hand-records.mjs", "dispatch-scope.mjs"];
  try {
    const mat = materializeOpencodeRuntime(worktree, projectRoot);
    assert.equal(mat.source, "monorepo");
    for (const name of criticalLibs) {
      assert.ok(existsSync(join(worktree, ".opencode", "lib", name)), `runtime must copy lib/${name}`);
    }
    rmSync(join(worktree, ".opencode", "lib", "gate-state.mjs"));
    assert.equal(isOpencodeRuntimeComplete(join(worktree, ".opencode")), false, "missing critical lib must make runtime incomplete");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("materializeOpencodeRuntime: missing source throws fail-closed (#ac-1.4)", () => {
  const { root, projectRoot, worktree } = makeSeedDirs("oc-seed-missing-mat-", { bare: true });
  try {
    assert.throws(
      () => materializeOpencodeRuntime(worktree, projectRoot),
      /materialize failed|incomplete|no complete source/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("seedOpencodeRootConfig: no runtime source anywhere → throws fail-closed (#ac-1.4)", () => {
  const { root, projectRoot, worktree } = makeSeedDirs("oc-seed-missing-", { bare: true });
  try {
    writeFileSync(
      join(projectRoot, "opencode.json"),
      JSON.stringify({
        plugin: ["./.opencode/plugin/entry-gate.ts"],
        permission: { bash: { "*": "allow" } },
      }),
    );
    assert.throws(
      () => seedOpencodeRootConfig(worktree, projectRoot),
      /materialize failed|incomplete|no complete source|plugins missing|gates would be dead|First missing/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("seedOpencodeRootConfig: consumer vendored source re-syncs framework-owned; strips harness from plugin[] (#ac-1.5)", () => {
  const { root, projectRoot, worktree } = makeSeedDirs("oc-seed-vendored-", { bare: true });
  try {
    writeVendoredOcRuntime(projectRoot);
    writeFileSync(join(projectRoot, ".opencode", "plugin", "entry-gate.ts"), "// source-of-truth\n", "utf8");
    writeFileSync(join(projectRoot, ".opencode", "plugin", "local-extra.ts"), "// project-local\n", "utf8");
    // Worktree has stale framework file + a non-framework extra that must survive merge-copy
    writeVendoredOcRuntime(worktree);
    writeFileSync(join(worktree, ".opencode", "plugin", "loop-guard.ts"), "// retired zombie\n", "utf8");
    writeFileSync(join(worktree, ".opencode", "plugin", "entry-gate.ts"), "// stale-worktree\n", "utf8");
    writeFileSync(join(worktree, ".opencode", "plugin", "local-extra.ts"), "// project-local\n", "utf8");
    writeFileSync(
      join(projectRoot, "opencode.json"),
      JSON.stringify({
        plugin: [
          "./.opencode/plugin/entry-gate.ts",
          "./.opencode/plugin/plan-gate.ts",
          "./.opencode/plugin/local-extra.ts",
          "my-external-package",
        ],
        permission: { bash: { "*": "allow" } },
      }),
    );
    seedOpencodeRootConfig(worktree, projectRoot);
    const cfg = JSON.parse(readFileSync(join(worktree, "opencode.json"), "utf8"));
    // Harness autoload paths stripped; external package plugins preserved
    assert.deepEqual(cfg.plugin, ["my-external-package"]);
    assert.equal(existsSync(join(worktree, ".opencode/plugin/entry-gate.ts")), true);
    assert.equal(existsSync(join(worktree, ".opencode/plugin/planner-recovery.ts")), true);
    assert.equal(existsSync(join(worktree, ".opencode/plugin/review-guard.ts")), true);
    assert.equal(existsSync(join(worktree, ".opencode/plugin/loop-guard.ts")), false);
    assertCriticalRuntime(worktree);
    assert.equal(
      readFileSync(join(worktree, ".opencode", "plugin", "entry-gate.ts"), "utf8"),
      "// source-of-truth\n",
      "framework-owned files re-sync from projectRoot vendored source (intentional overwrite)",
    );
    assert.equal(
      existsSync(join(worktree, ".opencode", "plugin", "local-extra.ts")),
      true,
      "non-framework extra under .opencode/plugin survives merge-copy",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("materializeOpencodeRuntime: rewrites monorepo shared imports + copies shared (#ac-1.6)", () => {
  const { root, projectRoot, worktree } = makeSeedDirs("oc-seed-shared-", { bare: true });
  try {
    writeMinimalOcRuntime(projectRoot, { withSharedImport: true });
    const mat = materializeOpencodeRuntime(worktree, projectRoot);
    assert.equal(mat.source, "monorepo");
    const entry = readFileSync(join(worktree, ".opencode", "plugin", "entry-gate.ts"), "utf8");
    assert.ok(entry.includes("../shared/lib/path-helpers.mjs"), "import must target vendored shared");
    assert.ok(!entry.includes("../../shared/"), "monorepo ../../shared must be rewritten");
    assert.equal(existsSync(join(worktree, ".opencode", "shared", "lib", "path-helpers.mjs")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("materializeOpencodeRuntime: monorepo critical without core/shared → throws fail-closed (gates would be dead)", () => {
  const { root, projectRoot, worktree } = makeSeedDirs("oc-seed-no-shared-", { bare: true });
  try {
    writeMinimalOcRuntime(projectRoot, { withSharedImport: false });
    // Deliberately no core/shared — critical skills/plugins alone must not pass materialize.
    assert.equal(existsSync(join(projectRoot, "core", "shared")), false);
    assert.throws(
      () => materializeOpencodeRuntime(worktree, projectRoot),
      /core\/shared|shared libs missing|dead plugins/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ensureOcPluginPathsExist: verifies harness on disk; returns external plugins only", () => {
  const root = mkdtempSync(join(tmpdir(), "oc-seed-ensure-"));
  const worktree = join(root, "wt");
  mkdirSync(worktree, { recursive: true });
  try {
    writeMonorepoPluginStubs(worktree);
    // Harness paths verified via monorepo rewrite fallback; stripped from return value
    const out = ensureOcPluginPathsExist(worktree, ["./.opencode/plugin/entry-gate.ts"]);
    assert.deepEqual(out, []);
    const withProjectPackage = ensureOcPluginPathsExist(worktree, [
      "project-plugin",
      "./.opencode/plugin/entry-gate.ts",
    ]);
    assert.deepEqual(withProjectPackage, ["project-plugin"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#481-ac-1.1 decideBashDelivery empty gate + no blocking rail evidence now allows gh pr (CC parity — bash gate no longer enforces ceremony)", async () => {
  // Was: "empty gate still denies gh pr" — that fail-closed ceremony requirement on the bash
  // gate is exactly what issue #481 removes (mirroring Claude Code's decideBash, which never
  // enforced mode/classified on the raw bash delivery command). With no gitState/regate/
  // capture/feature_id evidence to deny on, an empty gate-state now allows.
  const { decideBashDelivery } = await import("../opencode/plugin/lib/bash-decide.mjs");
  const d = decideBashDelivery({
    command: "gh pr create --draft",
    gateState: {},
    sessionId: "ses_x",
  });
  assert.equal(d.decision, "allow");
});


// ── permission.read/edit canonical secret-path deny enforcement (map-union, never scalar-replace) ─────────────────────

test("seedOpencodeRootConfig: [security] a scalar source permission.read/edit is never allowed to replace the canonical deny map (#ac-1.4)", () => {
  const { root, projectRoot, worktree } = makeSeedDirs("oc-seed-scalar-readedit-");
  try {
    writeFileSync(
      join(projectRoot, "opencode.json"),
      JSON.stringify({
        permission: {
          question: "deny",
          external_directory: "allow",
          bash: { "*": "allow" },
          read: "allow",
          edit: "allow",
        },
      }),
    );
    seedOpencodeRootConfig(worktree, projectRoot);
    const cfg = JSON.parse(readFileSync(join(worktree, "opencode.json"), "utf8"));
    for (const key of ["read", "edit"]) {
      const map = cfg.permission[key];
      assert.equal(typeof map, "object", `permission.${key} must be an object, not the source scalar 'allow' that would otherwise replace it`);
      assert.equal(Object.keys(map)[0], "*", `permission.${key}'s "*" wildcard must be the FIRST key (OpenCode resolves permissions last-match-wins)`);
      assert.equal(map["*"], "allow", `permission.${key}["*"] must remain 'allow'`);
      for (const pattern of CANONICAL_SECRET_DENIES) {
        assert.equal(
          map[pattern],
          "deny",
          `permission.${key}[${JSON.stringify(pattern)}] must be forced to 'deny' even when the source was a bare scalar`,
        );
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("seedOpencodeRootConfig: [security] absent permission.read/edit keys still yield the full canonical deny map (#ac-1.4)", () => {
  const { root, projectRoot, worktree } = makeSeedDirs("oc-seed-absent-readedit-");
  try {
    writeFileSync(
      join(projectRoot, "opencode.json"),
      JSON.stringify({
        permission: {
          question: "deny",
          external_directory: "allow",
          bash: { "*": "allow" },
        },
      }),
    );
    seedOpencodeRootConfig(worktree, projectRoot);
    const cfg = JSON.parse(readFileSync(join(worktree, "opencode.json"), "utf8"));
    for (const key of ["read", "edit"]) {
      const map = cfg.permission[key];
      assert.equal(typeof map, "object", `permission.${key} must be an object even when the source omitted the key entirely`);
      assert.equal(Object.keys(map)[0], "*", `permission.${key}'s "*" wildcard must be the FIRST key (OpenCode resolves permissions last-match-wins)`);
      assert.equal(map["*"], "allow", `permission.${key}["*"] must default to 'allow'`);
      for (const pattern of CANONICAL_SECRET_DENIES) {
        assert.equal(
          map[pattern],
          "deny",
          `permission.${key}[${JSON.stringify(pattern)}] must be forced to 'deny' when the source omitted the key`,
        );
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("seedOpencodeRootConfig: [security] a project-specific extra read deny survives union with the canonical deny map (#ac-1.4)", () => {
  const { root, projectRoot, worktree } = makeSeedDirs("oc-seed-union-readdeny-");
  try {
    writeFileSync(
      join(projectRoot, "opencode.json"),
      JSON.stringify({
        permission: {
          question: "deny",
          external_directory: "allow",
          bash: { "*": "allow" },
          read: { "*": "allow", "vault/**": "deny" },
        },
      }),
    );
    seedOpencodeRootConfig(worktree, projectRoot);
    const cfg = JSON.parse(readFileSync(join(worktree, "opencode.json"), "utf8"));
    const map = cfg.permission.read;
    assert.equal(
      map["vault/**"],
      "deny",
      "a project-specific extra deny from the source must survive canonical-deny enforcement (union, never replace)",
    );
    for (const pattern of CANONICAL_SECRET_DENIES) {
      assert.equal(
        map[pattern],
        "deny",
        `permission.read[${JSON.stringify(pattern)}] must be forced to 'deny' alongside the project-specific extra deny`,
      );
    }
    assert.equal(Object.keys(map)[0], "*", "permission.read's \"*\" wildcard must be the FIRST key (last-match-wins order)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("seedOpencodeRootConfig: [security] a permissive source value can never resurrect a canonical secret-path deny (#ac-1.4)", () => {
  const { root, projectRoot, worktree } = makeSeedDirs("oc-seed-resurrect-deny-");
  try {
    writeFileSync(
      join(projectRoot, "opencode.json"),
      JSON.stringify({
        permission: {
          question: "deny",
          external_directory: "allow",
          bash: { "*": "allow" },
          read: { "*": "allow", ".env": "allow" },
        },
      }),
    );
    seedOpencodeRootConfig(worktree, projectRoot);
    const cfg = JSON.parse(readFileSync(join(worktree, "opencode.json"), "utf8"));
    assert.equal(
      cfg.permission.read[".env"],
      "deny",
      "a source value that explicitly allows '.env' must never override the canonical secret-path deny",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("seedOpencodeRootConfig: [security] canonical deny defaults are never mutated across successive calls in the same process (#ac-1.4)", () => {
  const first = makeSeedDirs("oc-seed-leak-a-");
  const second = makeSeedDirs("oc-seed-leak-b-");
  try {
    writeFileSync(
      join(first.projectRoot, "opencode.json"),
      JSON.stringify({
        permission: {
          question: "deny",
          external_directory: "allow",
          bash: { "*": "allow" },
          read: { "*": "allow", "projA/**": "deny" },
        },
      }),
    );
    seedOpencodeRootConfig(first.worktree, first.projectRoot);

    writeFileSync(
      join(second.projectRoot, "opencode.json"),
      JSON.stringify({
        permission: {
          question: "deny",
          external_directory: "allow",
          bash: { "*": "allow" },
        },
      }),
    );
    seedOpencodeRootConfig(second.worktree, second.projectRoot);
    const cfg = JSON.parse(readFileSync(join(second.worktree, "opencode.json"), "utf8"));
    const map = cfg.permission.read;
    assert.equal(
      Object.prototype.hasOwnProperty.call(map, "projA/**"),
      false,
      "a project-specific deny seeded for a DIFFERENT projectRoot must never leak into this worktree's config — the in-code defaults must not be mutated in place",
    );
    for (const pattern of CANONICAL_SECRET_DENIES) {
      assert.equal(
        map[pattern],
        "deny",
        `permission.read[${JSON.stringify(pattern)}] must still be forced to 'deny' for the second, unrelated projectRoot`,
      );
    }
  } finally {
    rmSync(first.root, { recursive: true, force: true });
    rmSync(second.root, { recursive: true, force: true });
  }
});

test("seedOpencodeRootConfig: [security] the example-fallback path also key-enforces the canonical secret-path deny map (#ac-1.4)", () => {
  const { root, projectRoot, worktree } = makeSeedDirs("oc-seed-fallback-readedit-");
  try {
    writeFileSync(
      join(projectRoot, "core", "opencode", "opencode.json.example"),
      JSON.stringify({
        permission: {
          bash: { "*": "allow" },
          read: "allow",
        },
      }),
    );
    seedOpencodeRootConfig(worktree, projectRoot);
    const cfg = JSON.parse(readFileSync(join(worktree, "opencode.json"), "utf8"));
    const map = cfg.permission.read;
    assert.equal(typeof map, "object", "fallback-sourced permission.read must be an object, not the source scalar 'allow' that would otherwise replace it");
    assert.equal(Object.keys(map)[0], "*", "fallback-sourced permission.read's \"*\" wildcard must be the FIRST key (last-match-wins order)");
    assert.equal(map["*"], "allow", "fallback-sourced permission.read[\"*\"] must remain 'allow'");
    for (const pattern of CANONICAL_SECRET_DENIES) {
      assert.equal(
        map[pattern],
        "deny",
        `fallback-sourced permission.read[${JSON.stringify(pattern)}] must be forced to 'deny'`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("seedOpencodeRootConfig: [security] the 8 canonical denies are the LAST keys of the seeded read/edit map, after any source-supplied pattern (#ac-1.4)", () => {
  const { root, projectRoot, worktree } = makeSeedDirs("oc-seed-deny-position-");
  try {
    const sourceMap = {};
    for (const pattern of CANONICAL_SECRET_DENIES) {
      sourceMap[pattern] = "deny";
    }
    sourceMap["**/.env*"] = "allow";
    sourceMap["**/.dev.vars*"] = "allow";
    sourceMap["~/.ssh/**/*"] = "allow";
    sourceMap["~/.aws/**/*"] = "allow";
    writeFileSync(
      join(projectRoot, "opencode.json"),
      JSON.stringify({
        permission: {
          question: "deny",
          external_directory: "allow",
          bash: { "*": "allow" },
          read: sourceMap,
          edit: sourceMap,
        },
      }),
    );
    seedOpencodeRootConfig(worktree, projectRoot);
    const cfg = JSON.parse(readFileSync(join(worktree, "opencode.json"), "utf8"));
    for (const key of ["read", "edit"]) {
      const map = cfg.permission[key];
      const keys = Object.keys(map);
      assert.equal(keys[0], "*", `permission.${key}'s "*" wildcard must still be the FIRST key`);
      assert.deepEqual(
        keys.slice(-8),
        CANONICAL_SECRET_DENIES,
        `permission.${key}'s 8 canonical denies must be the LAST 8 serialized keys, after every source-supplied pattern — OpenCode resolves permissions last-match-wins, so a source pattern serialized after them would shadow the deny`,
      );
      const smallestCanonicalIndex = Math.min(...CANONICAL_SECRET_DENIES.map((pattern) => keys.indexOf(pattern)));
      for (const allowPattern of ["**/.env*", "**/.dev.vars*", "~/.ssh/**/*", "~/.aws/**/*"]) {
        const idx = keys.indexOf(allowPattern);
        assert.ok(
          idx !== -1 && idx < smallestCanonicalIndex,
          `permission.${key}[${JSON.stringify(allowPattern)}] must be serialized BEFORE the canonical deny block, never after it — a source key serialized after the canonical block would shadow the deny under last-match-wins resolution`,
        );
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("seedOpencodeRootConfig: [security] a source rule with an unrecognised value is clamped to deny, never silently dropped (#ac-1.4)", () => {
  const { root, projectRoot, worktree } = makeSeedDirs("oc-seed-unrecognised-value-");
  try {
    writeFileSync(
      join(projectRoot, "opencode.json"),
      JSON.stringify({
        permission: {
          question: "deny",
          external_directory: "allow",
          bash: { "*": "allow" },
          read: { "vault/**": "Deny", "secrets/**": ["deny"] },
        },
      }),
    );
    seedOpencodeRootConfig(worktree, projectRoot);
    const cfg = JSON.parse(readFileSync(join(worktree, "opencode.json"), "utf8"));
    const map = cfg.permission.read;
    assert.equal(
      map["vault/**"],
      "deny",
      "a source rule with the unrecognised value 'Deny' (wrong case) must be clamped to 'deny', never silently dropped and left to fall under the forced '*': 'allow'",
    );
    assert.equal(
      map["secrets/**"],
      "deny",
      "a source rule with the unrecognised value ['deny'] (array, not a valid action) must be clamped to 'deny', never silently dropped and left to fall under the forced '*': 'allow'",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("seedOpencodeRootConfig: [security] a source map's own wildcard value survives instead of being widened to allow (#ac-1.4)", () => {
  const { root, projectRoot, worktree } = makeSeedDirs("oc-seed-wildcard-survives-");
  try {
    writeFileSync(
      join(projectRoot, "opencode.json"),
      JSON.stringify({
        permission: {
          question: "deny",
          external_directory: "allow",
          bash: { "*": "allow" },
          read: { "*": "deny", "src/**": "allow" },
        },
      }),
    );
    seedOpencodeRootConfig(worktree, projectRoot);
    const cfg = JSON.parse(readFileSync(join(worktree, "opencode.json"), "utf8"));
    const map = cfg.permission.read;
    assert.equal(Object.keys(map)[0], "*", "permission.read's \"*\" wildcard must still be the FIRST key (last-match-wins order)");
    assert.equal(
      map["*"],
      "deny",
      "a source '*' value of 'deny' must be preserved, not silently widened to the forced 'allow' — that would invert a project's default-deny read posture into default-allow",
    );
    assert.equal(map["src/**"], "allow", "a project-specific allow rule must survive alongside the preserved wildcard value");
    assert.deepEqual(
      Object.keys(map).slice(-8),
      CANONICAL_SECRET_DENIES,
      "the 8 canonical denies must still be the LAST 8 serialized keys regardless of the source's own wildcard value",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("seedOpencodeRootConfig: [security] an integer-like source key cannot displace the wildcard from the first position (#ac-1.4)", () => {
  const { root, projectRoot, worktree } = makeSeedDirs("oc-seed-integer-key-");
  try {
    writeFileSync(
      join(projectRoot, "opencode.json"),
      JSON.stringify({
        permission: {
          question: "deny",
          external_directory: "allow",
          bash: { "*": "allow" },
          read: { "0": "allow", "7": "deny" },
        },
      }),
    );
    seedOpencodeRootConfig(worktree, projectRoot);
    const cfg = JSON.parse(readFileSync(join(worktree, "opencode.json"), "utf8"));
    const map = cfg.permission.read;
    assert.equal(
      Object.keys(map)[0],
      "*",
      "the \"*\" wildcard must be the FIRST key even when the source carries integer-like keys — JavaScript serializes integer-index own keys before string keys regardless of insertion order, which can silently displace the wildcard and break the last-match-wins invariant",
    );
    assert.deepEqual(
      Object.keys(map).slice(-8),
      CANONICAL_SECRET_DENIES,
      "the 8 canonical denies must still be the LAST 8 serialized keys even when the source carries integer-like keys",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("seedOpencodeRootConfig: [security] a malformed example config with permission null does not crash the seed (#ac-1.4)", () => {
  const { root, projectRoot, worktree } = makeSeedDirs("oc-seed-example-null-permission-");
  try {
    writeFileSync(
      join(projectRoot, "opencode.json"),
      JSON.stringify({
        permission: { question: "deny", external_directory: "allow", bash: { "*": "allow" } },
      }),
    );
    writeFileSync(
      join(projectRoot, "core", "opencode", "opencode.json.example"),
      JSON.stringify({ permission: null }),
    );
    assert.doesNotThrow(
      () => seedOpencodeRootConfig(worktree, projectRoot),
      "a malformed example config with permission: null must not crash the seed — typeof null === 'object' passes the object guard, and dereferencing examplePermission.bash on the null then throws",
    );
    const cfg = JSON.parse(readFileSync(join(worktree, "opencode.json"), "utf8"));
    const map = cfg.permission.read;
    assert.equal(
      Object.keys(map)[0],
      "*",
      "permission.read's \"*\" wildcard must still be the FIRST key even when the example config's permission field was null",
    );
    assert.deepEqual(
      Object.keys(map).slice(-8),
      CANONICAL_SECRET_DENIES,
      "the 8 canonical denies must still be the LAST 8 serialized keys even when the example config's permission field was null",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("seedOpencodeRootConfig: [security] an invalid scalar source permission falls back to allow instead of being emitted verbatim (#ac-1.4)", () => {
  const { root, projectRoot, worktree } = makeSeedDirs("oc-seed-invalid-scalar-value-");
  try {
    writeFileSync(
      join(projectRoot, "opencode.json"),
      JSON.stringify({
        permission: {
          question: "deny",
          external_directory: "allow",
          bash: { "*": "allow" },
          read: "banana",
          edit: "Deny",
        },
      }),
    );
    seedOpencodeRootConfig(worktree, projectRoot);
    const cfg = JSON.parse(readFileSync(join(worktree, "opencode.json"), "utf8"));
    for (const key of ["read", "edit"]) {
      const map = cfg.permission[key];
      assert.equal(
        Object.keys(map)[0],
        "*",
        `permission.${key}'s "*" wildcard must be the FIRST key even when the source scalar was an invalid action`,
      );
      assert.equal(
        map["*"],
        "allow",
        `permission.${key}["*"] must fall back to 'allow' — an invalid scalar source value must never be emitted verbatim into the seeded config`,
      );
      assert.deepEqual(
        Object.keys(map).slice(-8),
        CANONICAL_SECRET_DENIES,
        `permission.${key}'s 8 canonical denies must still be the LAST 8 serialized keys even when the source scalar was an invalid action`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
