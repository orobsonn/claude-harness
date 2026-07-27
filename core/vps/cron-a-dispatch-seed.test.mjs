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
} from "./cron-a-dispatch.mjs";
import { defaultOcPluginPaths } from "../claude-code/skills/initializing-projects/references/vendor-core.mjs";


const CANONICAL_STUBS = [
  "entry-gate.ts",
  "marker-authority.ts",
  "ceremony-coordinator.ts",
  "plan-gate.ts",
  "planner-recovery.ts",
  "plan-write-gate.ts",
  "loop-guard.ts",
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

const CRITICAL_SKILLS = ["triaging-requests", "orchestrating-delivery", "brainstorming"];
const CANONICAL_ROUTING = JSON.parse(
  readFileSync(new URL("../opencode/harness.routing.json", import.meta.url), "utf8"),
);

function legacyRouting() {
  const legacy = structuredClone(CANONICAL_ROUTING);
  legacy.version = 1;
  for (const role of ["plan-reviewer", "adversary"]) {
    const primary = { ...legacy.roles[role].families["family-1"] };
    const secondary = { ...legacy.roles[role].families["family-2"] };
    for (const key of ["primary", "optional", "countsLoop"]) {
      delete primary[key];
      delete secondary[key];
    }
    legacy.roles[role] = { ...primary, dual: [secondary] };
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
    assert.equal(routing.roles.adversary.families["family-1"].primary, true);
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("seedOpencodeRootConfig: [security] force-enforces deny entries for the additional dangerous-command classes (sudo, pipe-to-shell, chmod 777, netcat, dd, fork-bomb) alongside the pre-existing git/rm-rf denies", () => {
  const { root, projectRoot, worktree } = makeSeedDirs("oc-seed-extra-dangerous-classes-");
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
    const bash = cfg.permission.bash;
    const additionalDangerousClasses = [
      "sudo *",
      "* | sh",
      "* | bash",
      "chmod 777*",
      "chmod -R 777*",
      "nc *",
      "ncat *",
      "dd if=*",
      ":(){ :|:& };:",
    ];
    for (const key of additionalDangerousClasses) {
      assert.equal(
        bash[key],
        "deny",
        `permission.bash[${JSON.stringify(key)}] must be forced to 'deny' as an additional dangerous-command class`,
      );
    }
    assert.equal(
      bash["git push --force*"],
      "deny",
      "the pre-existing git push --force* deny must still be present alongside the additional classes",
    );
    assert.equal(
      bash["rm -rf /"],
      "deny",
      "the pre-existing rm -rf / deny must still be present alongside the additional classes",
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

test("#ac-1.4 decideBashDelivery empty gate still denies gh pr (logic regression)", async () => {
  const { decideBashDelivery } = await import("../opencode/plugin/lib/bash-decide.mjs");
  const d = decideBashDelivery({
    command: "gh pr create --draft",
    gateState: {},
    sessionId: "ses_x",
  });
  assert.equal(d.decision, "deny");
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
