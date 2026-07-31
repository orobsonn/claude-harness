#!/usr/bin/env node
/**
 * @description Tests vendor-core.mjs vendoring behavior, especially hooks inclusion
 * and *.test.mjs exclusion.
 *
 * Usage:
 *   node vendor-core.test.mjs
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  execFileSync,
  spawnSync,
} from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  isFrameworkCopyIncluded,
  shouldVendorModule,
  findMissingHookVpsDeps,
  rewriteSharedImportsForVendor,
  pluginsAreRelative,
  defaultOcPluginPaths,
  harnessOcPluginFiles,
  missingHarnessOcPluginFiles,
  isHarnessAutoloadPluginPath,
  normalizeRuntimeTarget,
  resolveProjectTarget,
  writeOpencodeConfig,
  writeSettings,
  installRepoFiles,
  assertFreshNativeInstall,
  OC_RETIRED_FILES,
  pruneOcRetiredFiles,
} from "./vendor-core.mjs";
import { mkdirSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve paths relative to the test location
const vendorCoreScript = join(__dirname, "vendor-core.mjs");
// Dual-runtime: this file lives under core/claude-code/skills/.../references/ (5 up = repo root).
// Legacy flat layout was core/skills/.../references/ (4 up).
const harnessRoot = existsSync(join(__dirname, "../../../../../package.json"))
  ? join(__dirname, "../../../../..")
  : join(__dirname, "../../../..");

// core/opencode/opencode.json.example (4 up from references/ to reach core/)
const OC_EXAMPLE_PATH = join(__dirname, "../../../../opencode/opencode.json.example");
// repo-root opencode.json (5 up from references/ to reach the repo root)
const ROOT_OPENCODE_JSON_PATH = join(__dirname, "../../../../../opencode.json");

/** Retired in v0.45.1 (#359) — the unpinned `#*` ref accepted any branch/PR/commit as executable. */
const RETIRED_NPX_WILDCARDS = [
  "npx github:orobsonn/claude-harness#* init*",
  "npx -y github:orobsonn/claude-harness#* init*",
  'npx -y "github:orobsonn/claude-harness#*" init*',
];
// core/claude-code (3 up from references/ to reach core/claude-code/)
const CC_CORE_DIR = join(harnessRoot, "core/claude-code");
const CC_SETTINGS_PATH = join(CC_CORE_DIR, "settings.json");

function createIssueAuthoringSourceFixture() {
  const sourceRoot = mkdtempSync(join(tmpdir(), "vendor-source-fixture-"));
  const copies = [
    ["core/opencode/skills/creating-issues/SKILL.md", "core/opencode/skills/creating-issues/SKILL.md"],
    [
      "core/opencode/skills/creating-issues/references/submit-issue.mjs",
      "core/opencode/skills/creating-issues/references/submit-issue.mjs",
    ],
    ["core/opencode/rules/creating-issues.md", "core/opencode/rules/creating-issues.md"],
    ["core/github/ISSUE_TEMPLATE/harness-task.yml", "core/github/ISSUE_TEMPLATE/harness-task.yml"],
  ];
  for (const [from, to] of copies) {
    const destination = join(sourceRoot, to);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(harnessRoot, from), destination);
  }
  return sourceRoot;
}

function snapshotTree(root) {
  const visit = (path) => {
    const info = lstatSync(path);
    if (info.isSymbolicLink()) return { type: "symlink" };
    if (info.isFile()) return { type: "file", body: readFileSync(path).toString("base64") };
    return {
      type: "directory",
      entries: Object.fromEntries(
        readdirSync(path).sort().map((name) => [name, visit(join(path, name))]),
      ),
    };
  };
  return visit(root);
}

test("findMissingHookVpsDeps: flags a hook whose ../vps import has no file in .claude/vps, and passes when present", () => {
  const claudeDir = mkdtempSync(join(tmpdir(), "vendor-check-"));
  mkdirSync(join(claudeDir, "hooks"), { recursive: true });
  writeFileSync(
    join(claudeDir, "hooks", "stamp-triage.mjs"),
    'import { appendEvent } from "../vps/obs-outbox.mjs";\n',
    "utf8",
  );

  // vps/ absent → the import is reported missing (the stale-jump state)
  const missing = findMissingHookVpsDeps(claudeDir);
  assert.equal(missing.length, 1);
  assert.deepEqual(missing[0], { hook: "stamp-triage.mjs", module: "obs-outbox.mjs" });

  // once the module is mirrored, the check passes clean
  mkdirSync(join(claudeDir, "vps"), { recursive: true });
  writeFileSync(join(claudeDir, "vps", "obs-outbox.mjs"), "export const x = 1;\n", "utf8");
  assert.deepEqual(findMissingHookVpsDeps(claudeDir), []);
});

test("findMissingHookVpsDeps: ignores *.test.mjs hook imports (their imports never ship)", () => {
  const claudeDir = mkdtempSync(join(tmpdir(), "vendor-check-"));
  mkdirSync(join(claudeDir, "hooks"), { recursive: true });
  writeFileSync(
    join(claudeDir, "hooks", "foo.test.mjs"),
    'import { readEvents } from "../vps/heavy-only-in-tests.mjs";\n',
    "utf8",
  );
  assert.deepEqual(findMissingHookVpsDeps(claudeDir), [], "a test-only ../vps import is never a vendor defect");
});

test("vendor-core: hooks and docs are included in FRAMEWORK_OWNED", (t) => {
  const scriptContent = readFileSync(vendorCoreScript, "utf8");
  assert.match(
    scriptContent,
    /const FRAMEWORK_OWNED = \["agents",\s*"skills",\s*"rules",\s*"hooks",\s*"docs"\]/,
    "FRAMEWORK_OWNED should contain 'hooks' and 'docs' alongside agents, skills, and rules"
  );
});

test("vendor-core: all required hook files are copied to target", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "vendor-test-"));
  try {
    const result = spawnSync(
      "node",
      [vendorCoreScript, "--source", harnessRoot, "--target", tempDir],
      { encoding: "utf8", stdio: "pipe" }
    );

    if (result.status !== 0) {
      throw new Error(
        `vendor-core failed: ${result.stderr || result.stdout}`
      );
    }

    const requiredFiles = [
      ".claude/hooks/entry-gate.mjs",
      ".claude/hooks/stamp-triage.mjs",
      ".claude/hooks/reinject-state.mjs",
      ".claude/hooks/classify.mjs",
      ".claude/hooks/mark.mjs",
      ".claude/hooks/lib/gate-lib.mjs",
    ];

    for (const file of requiredFiles) {
      const fullPath = join(tempDir, file);
      assert.ok(
        existsSync(fullPath),
        `${file} should exist in vendored target`
      );
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

/**
 * @description #361/#ac-5.1 regression — the shared-import rewrite must cover the WHOLE framework
 * tree, not just hooks/. `core/claude-code` collapses to `.claude`, so a vendored file sits one
 * level closer to shared/ than its monorepo original. When the rewrite skipped skills/, the
 * vendored spawn-hand.mjs kept `../../../../shared/` — resolving OUTSIDE .claude/ — and died with
 * ERR_MODULE_NOT_FOUND on import: every hand dispatch in every vendored project, dead. Importing
 * the real vendored module is the only assertion that proves the path resolves; a string check on
 * the import line would pass against a subtly wrong depth.
 */
test("vendor-core: vendored skill references importing core/shared actually resolve (#361)", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "vendor-test-"));
  try {
    const result = spawnSync(
      "node",
      [vendorCoreScript, "--source", harnessRoot, "--target", tempDir],
      { encoding: "utf8", stdio: "pipe" },
    );
    assert.equal(result.status, 0, `vendor-core failed: ${result.stderr || result.stdout}`);

    // The ladder constant travels with the vendor — the lock is a factory default (#ac-5.1).
    assert.ok(
      existsSync(join(tempDir, ".claude/shared/lib/hand-model-ladder.mjs")),
      "the approved-ladder constant must be vendored into .claude/shared/lib/",
    );

    const spawnHand = join(tempDir, ".claude/skills/orchestrating-delivery/references/spawn-hand.mjs");
    assert.ok(existsSync(spawnHand), "vendored spawn-hand.mjs must exist");
    await import(pathToFileURL(spawnHand).href);

    // And the gate — a hook, deeper in the tree — enforces the ladder with no project config.
    const gate = await import(pathToFileURL(join(tempDir, ".claude/hooks/plan-write-gate.mjs")).href);
    const refused = gate.checkPlanContent(
      '{"model_strategy":{"hand_tiers":{"low":"gpt-oss:20b","medium":"glm-5.2","high":"kimi-k2.7-code"},"planner":"opus"}}',
    );
    assert.match(refused ?? "", /gpt-oss:20b/, "a fresh vendored project must refuse an off-ladder tier");
    assert.equal(
      gate.checkPlanContent(
        '{"model_strategy":{"hand_tiers":{"low":"gemma4","medium":"glm-5.2","high":"kimi-k2.7-code"},"planner":"opus"}}',
      ),
      null,
      "the approved ladder must pass",
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("vendor-core: mirrors the vps modules the hooks import so vendored hooks resolve (P1 regression)", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "vendor-test-"));
  try {
    const result = spawnSync(
      "node",
      [vendorCoreScript, "--source", harnessRoot, "--target", tempDir],
      { encoding: "utf8", stdio: "pipe" }
    );
    if (result.status !== 0) {
      throw new Error(`vendor-core failed: ${result.stderr || result.stdout}`);
    }

    // stamp-triage.mjs / obs-eye-append.mjs import `../vps/obs-outbox.mjs`; vps/ is not
    // framework-owned, so without the mirror the vendored hook crashes on load
    // (ERR_MODULE_NOT_FOUND) → triage.json never writes → the entry-gate blocks every subagent.
    assert.ok(
      existsSync(join(tempDir, ".claude/vps/obs-outbox.mjs")),
      "obs-outbox.mjs must be mirrored into .claude/vps/"
    );

    // The real regression guard: the vendored hook must actually resolve its ../vps import.
    const hookUrl = pathToFileURL(join(tempDir, ".claude/hooks/stamp-triage.mjs")).href;
    await assert.doesNotReject(
      import(hookUrl),
      "vendored stamp-triage.mjs must resolve its ../vps/obs-outbox.mjs import"
    );

    // Only what the hooks import — cron-only vps runtime must NOT leak into .claude/vps/.
    assert.ok(
      !existsSync(join(tempDir, ".claude/vps/cron-a-dispatch.mjs")),
      "cron-only vps modules must not be vendored"
    );
    // A test-only import of a heavy vps module (notify-telegram.mjs, imported by hooks/*.test.mjs)
    // must NOT drag it in — *.test.mjs are not vendored, so their imports never ship.
    assert.ok(
      !existsSync(join(tempDir, ".claude/vps/notify-telegram.mjs")),
      "vps modules imported only by test files must not be vendored"
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("vendor-core: installs .dev.vars.example placeholder when absent", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "vendor-test-"));
  try {
    const result = spawnSync(
      "node",
      [vendorCoreScript, "--source", harnessRoot, "--target", tempDir],
      { encoding: "utf8", stdio: "pipe" }
    );

    if (result.status !== 0) {
      throw new Error(`vendor-core failed: ${result.stderr || result.stdout}`);
    }

    const placeholder = join(tempDir, ".dev.vars.example");
    assert.ok(
      existsSync(placeholder),
      ".dev.vars.example should be installed at the project root"
    );

    const content = readFileSync(placeholder, "utf8");
    assert.match(
      content,
      /ANTHROPIC_AUTH_TOKEN=\s*$/m,
      "placeholder must carry the token key with no real value"
    );
    assert.ok(
      !/ANTHROPIC_AUTH_TOKEN=\S/.test(content),
      "placeholder must NOT contain a real token value"
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("vendor-core: ensures root .gitignore ignores .dev.vars, idempotently", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "vendor-test-"));
  try {
    // Seed a root .gitignore that LACKS .dev.vars (the documented setup copies
    // .dev.vars.example -> .dev.vars at the root, which the runner reads).
    writeFileSync(join(tempDir, ".gitignore"), "node_modules/\n");

    const run = () =>
      spawnSync(
        "node",
        [vendorCoreScript, "--source", harnessRoot, "--target", tempDir],
        { encoding: "utf8", stdio: "pipe" }
      );

    const first = run();
    if (first.status !== 0) {
      throw new Error(`vendor-core failed: ${first.stderr || first.stdout}`);
    }

    const gitignore = join(tempDir, ".gitignore");
    const afterFirst = readFileSync(gitignore, "utf8");
    assert.match(
      afterFirst,
      /^\.dev\.vars$/m,
      "root .gitignore must ignore .dev.vars after vendor runs"
    );
    assert.ok(
      afterFirst.includes("node_modules/"),
      "existing .gitignore entries must be preserved"
    );

    const second = run();
    if (second.status !== 0) {
      throw new Error(`vendor-core failed: ${second.stderr || second.stdout}`);
    }

    const afterSecond = readFileSync(gitignore, "utf8");
    const occurrences = afterSecond
      .split(/\r?\n/)
      .filter((line) => line.trim() === ".dev.vars").length;
    assert.strictEqual(
      occurrences,
      1,
      "re-running vendor must NOT duplicate the .dev.vars block (idempotent)"
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("vendor-core: glob/example siblings do NOT short-circuit the bare .dev.vars append", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "vendor-test-"));
  try {
    // A pre-existing .gitignore with ONLY sibling entries: the committed example file and
    // a glob that does NOT match the extensionless .dev.vars. A prefix match would wrongly
    // treat the token file as already ignored and skip the append.
    writeFileSync(join(tempDir, ".gitignore"), ".dev.vars.example\n.dev.vars.*\n");

    const result = spawnSync(
      "node",
      [vendorCoreScript, "--source", harnessRoot, "--target", tempDir],
      { encoding: "utf8", stdio: "pipe" }
    );
    if (result.status !== 0) {
      throw new Error(`vendor-core failed: ${result.stderr || result.stdout}`);
    }

    const after = readFileSync(join(tempDir, ".gitignore"), "utf8");
    assert.match(
      after,
      /^\.dev\.vars$/m,
      "bare .dev.vars must be appended even when sibling glob/example entries already exist"
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("vendor-core: no *.test.mjs files are copied to hooks", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "vendor-test-"));
  try {
    const result = spawnSync(
      "node",
      [vendorCoreScript, "--source", harnessRoot, "--target", tempDir],
      { encoding: "utf8", stdio: "pipe" }
    );

    if (result.status !== 0) {
      throw new Error(
        `vendor-core failed: ${result.stderr || result.stdout}`
      );
    }

    const hooksDir = join(tempDir, ".claude", "hooks");
    if (existsSync(hooksDir)) {
      const allFiles = [];
      const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const fullPath = join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(fullPath);
          } else {
            allFiles.push(entry.name);
          }
        }
      };
      walk(hooksDir);

      const testFiles = allFiles.filter((f) => f.endsWith(".test.mjs"));
      assert.strictEqual(
        testFiles.length,
        0,
        `No *.test.mjs files should be present under .claude/hooks/, but found: ${testFiles.join(", ")}`
      );
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// locked_test — hand-config filter predicate (AC v2.3)
test("isFrameworkCopyIncluded: settings.json in hand-config is INCLUDED (returns true)", () => {
  const src =
    "skills/orchestrating-delivery/references/hand-config/settings.json";
  assert.strictEqual(
    isFrameworkCopyIncluded(src),
    true,
    "settings.json must be included so the Stop-hook config reaches consumers"
  );
});

test("isFrameworkCopyIncluded: resolve-hook-command.test.mjs in hand-config is EXCLUDED (returns false)", () => {
  const src =
    "skills/orchestrating-delivery/references/hand-config/resolve-hook-command.test.mjs";
  assert.strictEqual(
    isFrameworkCopyIncluded(src),
    false,
    "a .test.mjs file living in hand-config/ must be excluded by the filter"
  );
});

// --- opt-in module vendoring (codex-adversary) ------------------------------

test("shouldVendorModule: opt-in flag forces copy; else only when already present", () => {
  const exists = (p) => p === "/proj/.claude/modules/codex-adversary";
  // --with-codex => always copy, regardless of presence
  assert.strictEqual(shouldVendorModule("/proj/.claude", "codex-adversary", true, () => false), true);
  // no flag + already vendored => refresh (do not let an existing opt-in go stale)
  assert.strictEqual(shouldVendorModule("/proj/.claude", "codex-adversary", false, exists), true);
  // no flag + absent => safe default: skip
  assert.strictEqual(shouldVendorModule("/proj/.claude", "codex-adversary", false, () => false), false);
});

test("vendor-core: --with-codex vendors the module; default omits it", async () => {
  const withDir = mkdtempSync(join(tmpdir(), "vendor-codex-"));
  const plainDir = mkdtempSync(join(tmpdir(), "vendor-plain-"));
  try {
    const run = (target, extra = []) =>
      spawnSync("node", [vendorCoreScript, "--source", harnessRoot, "--target", target, ...extra], {
        encoding: "utf8",
        stdio: "pipe",
      });

    const withRes = run(withDir, ["--with-codex"]);
    if (withRes.status !== 0) throw new Error(`vendor failed: ${withRes.stderr || withRes.stdout}`);
    assert.ok(
      existsSync(join(withDir, ".claude/modules/codex-adversary/references/cross-family.mjs")),
      "--with-codex must vendor the module"
    );
    assert.ok(
      !existsSync(join(withDir, ".claude/modules/codex-adversary/references/cross-family.test.mjs")),
      "*.test.mjs must be excluded from the vendored module"
    );

    const plainRes = run(plainDir);
    if (plainRes.status !== 0) throw new Error(`vendor failed: ${plainRes.stderr || plainRes.stdout}`);
    assert.ok(
      !existsSync(join(plainDir, ".claude/modules")),
      "default init (no flag) must NOT vendor any module"
    );
  } finally {
    rmSync(withDir, { recursive: true, force: true });
    rmSync(plainDir, { recursive: true, force: true });
  }
});

test("vendor-core: an already-vendored module is refreshed on update without the flag", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vendor-update-"));
  try {
    // Simulate a prior opt-in: the module dir already exists in the target.
    mkdirSync(join(tempDir, ".claude/modules/codex-adversary"), { recursive: true });

    const res = spawnSync(
      "node",
      [vendorCoreScript, "--source", harnessRoot, "--target", tempDir],
      { encoding: "utf8", stdio: "pipe" }
    );
    if (res.status !== 0) throw new Error(`vendor failed: ${res.stderr || res.stdout}`);

    assert.ok(
      existsSync(join(tempDir, ".claude/modules/codex-adversary/references/cross-family.mjs")),
      "an existing module must be refreshed even without --with-codex"
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("vendored module resolves canonical sources from .claude/agents (vendored layout)", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vendor-selftest-"));
  try {
    const vendor = spawnSync(
      "node",
      [vendorCoreScript, "--source", harnessRoot, "--target", tempDir, "--with-codex"],
      { encoding: "utf8", stdio: "pipe" }
    );
    if (vendor.status !== 0) throw new Error(`vendor failed: ${vendor.stderr || vendor.stdout}`);

    // The --self-test composes the adversary prompt from the canonical sources WITHOUT calling codex.
    // In a vendored project these live at .claude/agents/... (no core/), so this proves the dual-layout
    // resolver (item 1) works end-to-end after vendoring.
    const selfTest = spawnSync(
      "node",
      [".claude/modules/codex-adversary/references/codex-adversary.mjs", "--self-test"],
      { cwd: tempDir, encoding: "utf8", stdio: "pipe" }
    );
    assert.strictEqual(selfTest.status, 0, `self-test must exit 0: ${selfTest.stderr}`);
    assert.match(selfTest.stdout, /adversary/i, "composed prompt must embed the vendored adversary role");
    assert.match(selfTest.stdout, /ROLE \(verbatim from/, "prompt must cite the resolved canonical role path");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// --- T9: OpenCode vendor target ------------------------------------------------

test("t9-creates: --runtime opencode creates .opencode agents command docs skills plugin tools and harness.routing.json", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vendor-oc-"));
  try {
    const result = spawnSync(
      "node",
      [vendorCoreScript, "--source", harnessRoot, "--target", tempDir, "--runtime", "opencode"],
      { encoding: "utf8", stdio: "pipe" },
    );
    assert.equal(result.status, 0, `vendor failed: ${result.stderr || result.stdout}`);

    const required = [
      ".opencode/agents",
      ".opencode/agents/harness-config.md",
      ".opencode/command/configuring-model-routing.md",
      ".opencode/command/updating-harness.md",
      ".opencode/docs/SPAWN-PATTERN.md",
      ".opencode/skills",
      ".opencode/plugin",
      ".opencode/tools",
      ".opencode/harness.routing.json",
      ".opencode/plugin/entry-gate.ts",
      ".opencode/shared/lib/capture-oracle.mjs",
      "opencode.json",
      "AGENTS.md",
      "MEMORY.md",
      "kaizen.md",
      ".opencode/skills/creating-issues/SKILL.md",
      ".opencode/rules/creating-issues.md",
      ".github/ISSUE_TEMPLATE/harness-task.yml",
    ];
    for (const rel of required) {
      assert.ok(existsSync(join(tempDir, rel)), `missing ${rel}`);
    }
    // default runtime remains claude-only — OC path must NOT create .claude
    assert.ok(!existsSync(join(tempDir, ".claude/agents")), "opencode-only must not vendor .claude agents");
    assert.ok(!existsSync(join(tempDir, ".opencode/agents/SPAWN-PATTERN.md")), "documentation must not be callable as an agent");
    assert.equal(
      readFileSync(join(tempDir, ".opencode/docs/SPAWN-PATTERN.md"), "utf8"),
      readFileSync(join(harnessRoot, "core/opencode/docs/SPAWN-PATTERN.md"), "utf8"),
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("re-vendoring onto an already-vendored project deletes retired plugin files (no zombie auto-load)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vendor-oc-retired-"));
  try {
    const staleResolver = join(tempDir, ".opencode/plugin/command-resolver.ts");
    const staleLib = join(tempDir, ".opencode/plugin/lib/command-resolver.mjs");
    mkdirSync(dirname(staleResolver), { recursive: true });
    mkdirSync(dirname(staleLib), { recursive: true });
    writeFileSync(staleResolver, "// stale plugin from a prior vendor\n", "utf8");
    writeFileSync(staleLib, "// stale lib from a prior vendor\n", "utf8");

    const result = spawnSync(
      "node",
      [vendorCoreScript, "--source", harnessRoot, "--target", tempDir, "--runtime", "opencode"],
      { encoding: "utf8", stdio: "pipe" },
    );
    assert.equal(result.status, 0, `vendor failed: ${result.stderr || result.stdout}`);

    assert.ok(!existsSync(staleResolver), "retired plugin file must be deleted on re-vendor");
    assert.ok(!existsSync(staleLib), "retired plugin lib must be deleted on re-vendor");
    // A live harness plugin planted the same run must survive untouched (only the exact
    // retired paths are pruned — this is not a directory wipe).
    assert.ok(existsSync(join(tempDir, ".opencode/plugin/entry-gate.ts")));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("re-vendoring moves the closure-11 into framework-owned lib, sweeps only old paths, and preserves a project sibling", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vendor-oc-closure-11-"));
  const closure = [
    "gate-state.mjs",
    "entry-decide.mjs",
    "dispatch-scope.mjs",
    "hand-records.mjs",
    "planner-state.mjs",
    "obs-emit.mjs",
    "plan-hash.mjs",
    "planner-artifact.mjs",
    "planner-fallback-config.mjs",
    "roles.mjs",
    "task-dispatch-identity.mjs",
  ];
  try {
    const projectSibling = join(tempDir, ".opencode", "plugin", "lib", "project-owned-sibling.mjs");
    mkdirSync(dirname(projectSibling), { recursive: true });
    writeFileSync(projectSibling, "export const projectOwned = true;\n", "utf8");
    for (const name of closure) {
      const stale = join(tempDir, ".opencode", "plugin", "lib", name);
      mkdirSync(dirname(stale), { recursive: true });
      writeFileSync(stale, "// stale pre-move closure module\n", "utf8");
    }

    const result = spawnSync(
      "node",
      [vendorCoreScript, "--source", harnessRoot, "--target", tempDir, "--runtime", "opencode"],
      { encoding: "utf8", stdio: "pipe" },
    );
    assert.equal(result.status, 0, `vendor failed: ${result.stderr || result.stdout}`);

    for (const name of closure) {
      assert.ok(existsSync(join(tempDir, ".opencode", "lib", name)), `framework-owned lib must vendor ${name}`);
      assert.ok(!existsSync(join(tempDir, ".opencode", "plugin", "lib", name)), `retired old path must be swept: ${name}`);
    }
    assert.ok(existsSync(projectSibling), "exact-path sweep must preserve a project-owned sibling in the retired-path directory");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("OC_RETIRED_FILES covers every exact path scheduled for OpenCode parity pruning (#576 ac-1.2)", () => {
  // Review alias / second-eye agent files stay in source for the two-release compatibility
  // window (#582) — they are NOT retired. Spawn hands and dual plugin modules remain scheduled.
  const scheduled = [
    "agents/executor-high-spawn.md",
    "agents/executor-low-spawn.md",
    "agents/executor-medium-spawn.md",
    "agents/sniper-high-spawn.md",
    "agents/sniper-low-spawn.md",
    "agents/sniper-medium-spawn.md",
    "agents/test-author-spawn.md",
    "plugin/loop-guard.ts",
    "plugin/lib/dual-enforcement.mjs",
    "plugin/lib/dual-enforcement.test.mjs",
    "plugin/lib/dual-merge.mjs",
    "plugin/lib/dual-merge.test.mjs",
    "plugin/lib/dual-nudge.mjs",
    "plugin/lib/marker-seal.mjs",
    "plugin/lib/marker-security.test.mjs",
    "skills/orchestrating-delivery/dual-runtime.mjs",
    "skills/orchestrating-delivery/dual-runtime.test.mjs",
    "plugin/lib/gate-state.mjs",
    "plugin/lib/entry-decide.mjs",
    "plugin/lib/dispatch-scope.mjs",
    "plugin/lib/hand-records.mjs",
    "plugin/lib/planner-state.mjs",
    "plugin/lib/obs-emit.mjs",
    "plugin/lib/plan-hash.mjs",
    "plugin/lib/planner-artifact.mjs",
    "plugin/lib/planner-fallback-config.mjs",
    "plugin/lib/roles.mjs",
    "plugin/lib/task-dispatch-identity.mjs",
  ];
  for (const kept of [
    "agents/adversary-family-1.md",
    "agents/adversary-family-2.md",
    "agents/adversary-openai.md",
    "agents/plan-reviewer-family-1.md",
    "agents/plan-reviewer-family-2.md",
    "agents/plan-reviewer-openai.md",
  ]) {
    assert.ok(!OC_RETIRED_FILES.includes(kept), `review alias stub must stay loadable: ${kept}`);
  }

  for (const path of scheduled) {
    assert.ok(OC_RETIRED_FILES.includes(path), `missing scheduled retired path: ${path}`);
  }
  assert.equal(new Set(OC_RETIRED_FILES).size, OC_RETIRED_FILES.length, "retired paths must be unique");

  // The pruning keeps these modules alive on purpose (docs/prd/oc-parity-pruning.md § Passo 5,
  // #583): adversary-nudge is the spec loop's only brake — the Claude Code lane has no adversary
  // cap to replace it — and revise-nudge is the authoritative round budget. Listing either as
  // retired would delete it from every vendored project the day its path changes.
  const keptOnPurpose = [
    "plugin/lib/adversary-nudge.mjs",
    "plugin/lib/adversary-nudge.test.mjs",
    "plugin/lib/revise-nudge.mjs",
    "plugin/lib/revise-nudge.test.mjs",
  ];
  for (const path of keptOnPurpose) {
    assert.ok(!OC_RETIRED_FILES.includes(path), `retired path must not include a module kept on purpose: ${path}`);
  }
});

test("retired dual files are pruned while review-guard and review budgets remain vendored (#583)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vendor-oc-predeclared-retired-"));
  try {
    const result = spawnSync(
      "node",
      [vendorCoreScript, "--source", harnessRoot, "--target", tempDir, "--runtime", "opencode"],
      { encoding: "utf8", stdio: "pipe" },
    );
    assert.equal(result.status, 0, `vendor failed: ${result.stderr || result.stdout}`);
    assert.ok(existsSync(join(tempDir, ".opencode/plugin/review-guard.ts")));
    assert.ok(!existsSync(join(tempDir, ".opencode/plugin/loop-guard.ts")));
    assert.ok(!existsSync(join(tempDir, ".opencode/plugin/lib/dual-merge.mjs")));
    assert.ok(existsSync(join(tempDir, ".opencode/plugin/lib/adversary-nudge.mjs")));
    assert.ok(existsSync(join(tempDir, ".opencode/plugin/lib/revise-nudge.mjs")));
    assert.ok(!existsSync(join(tempDir, ".opencode/plugin/lib/marker-seal.mjs")));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a pruned source removes vendored zombies, tolerates absent targets, and no longer requires retired plugins (#576 ac-1.1/ac-1.3)", () => {
  const root = mkdtempSync(join(tmpdir(), "vendor-oc-pruned-source-"));
  const source = join(root, "core/opencode");
  const target = join(root, "project");
  const ocDir = join(target, ".opencode");
  try {
    mkdirSync(join(source, "plugin/lib"), { recursive: true });
    mkdirSync(join(ocDir, "plugin/lib"), { recursive: true });
    for (const entry of harnessOcPluginFiles()) {
      const rel = entry.replace(/^\.\/\.opencode\//, "");
      mkdirSync(dirname(join(source, rel)), { recursive: true });
      mkdirSync(dirname(join(target, entry.replace(/^\.\//, ""))), { recursive: true });
      writeFileSync(join(source, rel), "// live\n", "utf8");
      writeFileSync(join(target, entry.replace(/^\.\//, "")), "// live\n", "utf8");
    }
    writeFileSync(join(ocDir, "plugin/loop-guard.ts"), "// stale\n", "utf8");
    writeFileSync(join(ocDir, "plugin/lib/dual-merge.mjs"), "// stale\n", "utf8");

    assert.deepEqual(missingHarnessOcPluginFiles(source, target), []);
    assert.doesNotThrow(() => pruneOcRetiredFiles(ocDir, source));
    assert.ok(!existsSync(join(ocDir, "plugin/loop-guard.ts")));
    assert.ok(!existsSync(join(ocDir, "plugin/lib/dual-merge.mjs")));
    assert.doesNotThrow(() => pruneOcRetiredFiles(ocDir, source));

    rmSync(join(ocDir, "plugin/entry-gate.ts"));
    assert.deepEqual(missingHarnessOcPluginFiles(source, target), ["./.opencode/plugin/entry-gate.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retired-file prune matches exact case only — a same-name-different-case user plugin survives on a case-insensitive fs", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vendor-oc-retired-case-"));
  try {
    // Deliberately different case from the retired "command-resolver.ts" — on a
    // case-insensitive filesystem (default macOS/Windows) a naive rmSync(join(dir, retiredName))
    // would resolve and delete this file too, even though its real on-disk name differs.
    const userPlugin = join(tempDir, ".opencode/plugin/Command-Resolver.ts");
    mkdirSync(dirname(userPlugin), { recursive: true });
    writeFileSync(userPlugin, "// user's own local plugin, unrelated to the harness one\n", "utf8");

    const result = spawnSync(
      "node",
      [vendorCoreScript, "--source", harnessRoot, "--target", tempDir, "--runtime", "opencode"],
      { encoding: "utf8", stdio: "pipe" },
    );
    assert.equal(result.status, 0, `vendor failed: ${result.stderr || result.stdout}`);

    assert.ok(existsSync(userPlugin), "a differently-cased user plugin must NOT be pruned");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("OpenCode vendor rejects a symlink target root before any external or partial write", () => {
  const parent = mkdtempSync(join(tmpdir(), "vendor-root-link-parent-"));
  const outside = mkdtempSync(join(tmpdir(), "vendor-root-link-outside-"));
  const target = join(parent, "project");
  try {
    symlinkSync(outside, target);
    const result = spawnSync(
      "node",
      [vendorCoreScript, "--source", harnessRoot, "--target", target, "--runtime", "opencode"],
      { encoding: "utf8", stdio: "pipe" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /target root must be a real directory|not an existing real directory/);
    assert.deepEqual(readdirSync(outside), [], "symlink target must remain byte-empty");
    assert.deepEqual(readdirSync(parent), ["project"], "no sibling or partial target files may be created");
  } finally {
    rmSync(target, { force: true });
    rmSync(parent, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("OpenCode vendor preflight rejects .opencode symlink before any root or external write", () => {
  const target = mkdtempSync(join(tmpdir(), "vendor-oc-link-target-"));
  const outside = mkdtempSync(join(tmpdir(), "vendor-oc-link-outside-"));
  try {
    writeFileSync(join(target, "preexisting.txt"), "keep\n");
    symlinkSync(outside, join(target, ".opencode"));
    const before = readdirSync(target).sort();
    const result = spawnSync(
      "node",
      [vendorCoreScript, "--source", harnessRoot, "--target", target, "--runtime", "opencode"],
      { encoding: "utf8", stdio: "pipe" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /symlink vendor destination.*\.opencode/);
    assert.deepEqual(readdirSync(outside), [], "no vendored file may traverse .opencode symlink");
    assert.deepEqual(readdirSync(target).sort(), before, "preflight must reject before root partial writes");
    assert.equal(readFileSync(join(target, "preexisting.txt"), "utf8"), "keep\n");
  } finally {
    rmSync(target, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("OpenCode source preflight names every required #342 artifact and leaves target byte-identical", () => {
  const required = [
    "core/opencode/skills/creating-issues",
    "core/opencode/skills/creating-issues/SKILL.md",
    "core/opencode/skills/creating-issues/references/submit-issue.mjs",
    "core/opencode/rules/creating-issues.md",
    "core/github/ISSUE_TEMPLATE/harness-task.yml",
  ];
  for (const artifact of required) {
    const sourceRoot = createIssueAuthoringSourceFixture();
    const target = mkdtempSync(join(tmpdir(), "vendor-source-preflight-target-"));
    try {
      mkdirSync(join(target, "existing"));
      writeFileSync(join(target, "existing/sentinel.bin"), Buffer.from([0, 1, 2, 255]));
      const before = snapshotTree(target);
      const sourceArtifact = join(sourceRoot, artifact);
      renameSync(sourceArtifact, `${sourceArtifact}.missing`);

      const result = spawnSync(
        "node",
        [vendorCoreScript, "--source", sourceRoot, "--target", target, "--runtime", "opencode"],
        { encoding: "utf8", stdio: "pipe" },
      );
      assert.notEqual(result.status, 0, `${artifact} absence must fail`);
      assert.ok(result.stderr.includes(artifact), `failure must name exact source artifact ${artifact}`);
      assert.deepEqual(snapshotTree(target), before, `${artifact} failure must not mutate target`);
    } finally {
      rmSync(sourceRoot, { recursive: true, force: true });
      rmSync(target, { recursive: true, force: true });
    }
  }
});

test("OpenCode source preflight rejects a required source symlink before target writes", () => {
  const sourceRoot = createIssueAuthoringSourceFixture();
  const target = mkdtempSync(join(tmpdir(), "vendor-source-link-target-"));
  const helper = join(sourceRoot, "core/opencode/skills/creating-issues/references/submit-issue.mjs");
  try {
    writeFileSync(join(target, "sentinel.txt"), "unchanged\n");
    const before = snapshotTree(target);
    rmSync(helper);
    symlinkSync(join(sourceRoot, "core/opencode/skills/creating-issues/SKILL.md"), helper);
    const result = spawnSync(
      "node",
      [vendorCoreScript, "--source", sourceRoot, "--target", target, "--runtime", "opencode"],
      { encoding: "utf8", stdio: "pipe" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /source artifact is a symlink/);
    assert.match(result.stderr, /core\/opencode\/skills\/creating-issues\/references\/submit-issue\.mjs/);
    assert.deepEqual(snapshotTree(target), before);
  } finally {
    rmSync(sourceRoot, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("OpenCode source preflight rejects legacy-only template and leaves target byte-identical", () => {
  const sourceRoot = createIssueAuthoringSourceFixture();
  const target = mkdtempSync(join(tmpdir(), "vendor-legacy-template-target-"));
  const canonical = join(sourceRoot, "core/github/ISSUE_TEMPLATE/harness-task.yml");
  const legacy = join(sourceRoot, "core/claude-code/github/ISSUE_TEMPLATE/harness-task.yml");
  try {
    mkdirSync(dirname(legacy), { recursive: true });
    cpSync(canonical, legacy);
    rmSync(canonical);
    writeFileSync(join(target, "sentinel.txt"), "unchanged\n");
    const before = snapshotTree(target);
    const result = spawnSync(
      "node",
      [vendorCoreScript, "--source", sourceRoot, "--target", target, "--runtime", "opencode"],
      { encoding: "utf8", stdio: "pipe" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /required OpenCode source artifact missing/);
    assert.match(result.stderr, /core\/github\/ISSUE_TEMPLATE\/harness-task\.yml/);
    assert.deepEqual(snapshotTree(target), before);
  } finally {
    rmSync(sourceRoot, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("repo template install is atomic, works beside custom templates, and preserves exact custom path", () => {
  const empty = mkdtempSync(join(tmpdir(), "vendor-template-empty-"));
  const custom = mkdtempSync(join(tmpdir(), "vendor-template-custom-"));
  try {
    mkdirSync(join(custom, ".github/ISSUE_TEMPLATE"), { recursive: true });
    writeFileSync(join(custom, ".github/ISSUE_TEMPLATE/bug.yml"), "custom bug\n");
    assert.match(installRepoFiles(join(harnessRoot, "core"), empty), /harness-task\.yml/);
    assert.match(installRepoFiles(join(harnessRoot, "core"), custom), /harness-task\.yml/);
    assert.equal(readFileSync(join(custom, ".github/ISSUE_TEMPLATE/bug.yml"), "utf8"), "custom bug\n");
    assert.equal(readdirSync(join(empty, ".github/ISSUE_TEMPLATE")).some((name) => name.endsWith(".tmp")), false);

    const exact = join(custom, ".github/ISSUE_TEMPLATE/harness-task.yml");
    writeFileSync(exact, "operator-owned exact template\n");
    assert.match(installRepoFiles(join(harnessRoot, "core"), custom), /none/);
    assert.equal(readFileSync(exact, "utf8"), "operator-owned exact template\n");
  } finally {
    rmSync(empty, { recursive: true, force: true });
    rmSync(custom, { recursive: true, force: true });
  }
});

test("repo template install rejects symlinked .github without writing outside target", () => {
  const target = mkdtempSync(join(tmpdir(), "vendor-template-link-github-"));
  const outside = mkdtempSync(join(tmpdir(), "vendor-template-outside-"));
  try {
    symlinkSync(outside, join(target, ".github"));
    assert.throws(() => installRepoFiles(join(harnessRoot, "core"), target), /symlink directory/);
    assert.equal(existsSync(join(outside, "ISSUE_TEMPLATE/harness-task.yml")), false);
  } finally {
    rmSync(target, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("repo template install rejects symlinked ISSUE_TEMPLATE without writing outside target", () => {
  const target = mkdtempSync(join(tmpdir(), "vendor-template-link-dir-"));
  const outside = mkdtempSync(join(tmpdir(), "vendor-template-outside-"));
  try {
    mkdirSync(join(target, ".github"));
    symlinkSync(outside, join(target, ".github/ISSUE_TEMPLATE"));
    assert.throws(() => installRepoFiles(join(harnessRoot, "core"), target), /symlink directory/);
    assert.equal(existsSync(join(outside, "harness-task.yml")), false);
  } finally {
    rmSync(target, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("repo template install rejects a symlink destination and preserves its outside target", () => {
  const target = mkdtempSync(join(tmpdir(), "vendor-template-link-file-"));
  const outside = mkdtempSync(join(tmpdir(), "vendor-template-outside-"));
  const outsideFile = join(outside, "owned.yml");
  try {
    mkdirSync(join(target, ".github/ISSUE_TEMPLATE"), { recursive: true });
    writeFileSync(outsideFile, "outside-owned\n");
    symlinkSync(outsideFile, join(target, ".github/ISSUE_TEMPLATE/harness-task.yml"));
    assert.throws(() => installRepoFiles(join(harnessRoot, "core"), target), /symlink repo-file destination/);
    assert.equal(readFileSync(outsideFile, "utf8"), "outside-owned\n");
  } finally {
    rmSync(target, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("fresh-install check fails while naming each missing native skill/template path", () => {
  const target = mkdtempSync(join(tmpdir(), "vendor-fresh-check-"));
  try {
    assert.throws(
      () => assertFreshNativeInstall(target, "opencode"),
      (error) => {
        assert.match(error.message, /\.opencode\/skills\/creating-issues\/SKILL\.md/);
        assert.match(error.message, /\.opencode\/rules\/creating-issues\.md/);
        assert.match(error.message, /\.github\/ISSUE_TEMPLATE\/harness-task\.yml/);
        return true;
      },
    );
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("canonical harness task form exposes every required roadmap field", () => {
  const form = readFileSync(join(harnessRoot, "core/github/ISSUE_TEMPLATE/harness-task.yml"), "utf8");
  assert.match(form, /^title: "\[harness\] "$/m);
  assert.match(form, /^labels: \["harness:ready"\]$/m);
  for (const id of ["user_journeys", "acceptance_criteria", "scope", "sensitive", "priority", "size"]) {
    assert.match(form, new RegExp(`^    id: ${id}$`, "m"), `form missing ${id}`);
  }
  assert.match(form, /#uj-N/);
  assert.match(form, /#ac-N\.M/);
});

test("t9-nonclobber: second run does not clobber existing MEMORY.md or kaizen.md", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vendor-oc-nc-"));
  try {
    const run = () =>
      spawnSync(
        "node",
        [vendorCoreScript, "--source", harnessRoot, "--target", tempDir, "--runtime", "opencode"],
        { encoding: "utf8", stdio: "pipe" },
      );
    assert.equal(run().status, 0);
    const marker = "OPERATOR_CUSTOM_MEMORY_MARKER_do_not_clobber";
    writeFileSync(join(tempDir, "MEMORY.md"), `${marker}\n`);
    writeFileSync(join(tempDir, "kaizen.md"), "CUSTOM_KAIZEN_LINE\n");
    assert.equal(run().status, 0);
    assert.equal(readFileSync(join(tempDir, "MEMORY.md"), "utf8"), `${marker}\n`);
    assert.equal(readFileSync(join(tempDir, "kaizen.md"), "utf8"), "CUSTOM_KAIZEN_LINE\n");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("t9-relative: plugin entries are relative paths not absolute home paths", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vendor-oc-rel-"));
  try {
    const result = spawnSync(
      "node",
      [vendorCoreScript, "--source", harnessRoot, "--target", tempDir, "--runtime", "opencode"],
      { encoding: "utf8", stdio: "pipe" },
    );
    assert.equal(result.status, 0, `vendor failed: ${result.stderr || result.stdout}`);
    const cfg = JSON.parse(readFileSync(join(tempDir, "opencode.json"), "utf8"));
    assert.ok(pluginsAreRelative(cfg.plugin), `plugins must be relative: ${JSON.stringify(cfg.plugin)}`);
    for (const p of cfg.plugin) {
      assert.ok(p.startsWith("./"), `plugin path must start with ./: ${p}`);
      assert.ok(!p.startsWith("/"), `absolute path forbidden: ${p}`);
      assert.ok(!p.includes("/Users/"), `home path forbidden: ${p}`);
      assert.ok(!p.includes(process.env.HOME || "___no_home___"), `HOME path forbidden: ${p}`);
    }
    assert.deepEqual(cfg.plugin, defaultOcPluginPaths());

    // entry-gate pulls shared utils from task-dispatch-identity / hook-identity / gate-state
    // (#580); imports must stay relative, never absolute home.
    const entry = readFileSync(join(tempDir, ".opencode/plugin/entry-gate.ts"), "utf8");
    assert.match(entry, /import\("\.\.\/lib\/task-dispatch-identity\.mjs"\)/);
    assert.match(entry, /import\("\.\/lib\/hook-identity\.mjs"\)/);
    assert.match(entry, /import\("\.\.\/lib\/gate-state\.mjs"\)/);
    assert.ok(!entry.includes("/Users/"), "vendored plugin must not embed absolute home paths");
    const reviewGuard = readFileSync(join(tempDir, ".opencode/plugin/review-guard.ts"), "utf8");
    assert.match(reviewGuard, /import\("\.\.\/shared\/lib\/path-helpers\.mjs"\)/);
    assert.ok(!reviewGuard.includes("/Users/"), "vendored shared import must be relative, not home path");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("normalizeRuntimeTarget: absent/empty → claude; known tokens map; garbage THROWS (no silent fail-open)", () => {
  assert.equal(normalizeRuntimeTarget(undefined), "claude");
  assert.equal(normalizeRuntimeTarget(null), "claude");
  assert.equal(normalizeRuntimeTarget(""), "claude");
  assert.equal(normalizeRuntimeTarget("claude"), "claude");
  assert.equal(normalizeRuntimeTarget("opencode"), "opencode");
  assert.equal(normalizeRuntimeTarget("oc"), "opencode");
  assert.equal(normalizeRuntimeTarget("both"), "both");
  assert.equal(normalizeRuntimeTarget("all"), "both");
  assert.equal(normalizeRuntimeTarget("BOTH"), "both");
  // The fail-open bug: a typo / stale-binary token must NOT become a silent claude-only vendor.
  assert.throws(() => normalizeRuntimeTarget("codex"), /invalid --runtime/);
  assert.throws(() => normalizeRuntimeTarget("cluade"), /invalid --runtime/);
});

test("resolveProjectTarget: existing dir passes; runtime token → hint at --runtime; missing dir throws", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vc-target-"));
  try {
    assert.equal(resolveProjectTarget(undefined, tempDir), tempDir);
    assert.equal(resolveProjectTarget(tempDir, "/unused"), tempDir);
    // The --target/--runtime footgun: `--target both` (not a dir) must not create ./both/.
    assert.throws(() => resolveProjectTarget("both", tempDir), /use --runtime both/);
    assert.throws(() => resolveProjectTarget("opencode", tempDir), /use --runtime opencode/);
    assert.throws(() => resolveProjectTarget("both/", tempDir), /use --runtime both/);
    assert.throws(() => resolveProjectTarget(join(tempDir, "nope"), tempDir), /not an existing directory/);
    // F2: a file path is NOT a directory — reject at the boundary, not later at mkdir.
    const aFile = join(tempDir, "afile.txt");
    writeFileSync(aFile, "x");
    assert.throws(() => resolveProjectTarget(aFile, tempDir), /not an existing directory/);
    // F3: a stray dir literally named `both` must STILL get the runtime hint, not vendor into ./both.
    const bothDir = join(tempDir, "both");
    mkdirSync(bothDir);
    assert.throws(() => resolveProjectTarget("both", bothDir), /use --runtime both/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("rewriteSharedImportsForVendor: depth-aware monorepo → vendored paths", () => {
  assert.equal(
    rewriteSharedImportsForVendor(
      'await import("../../shared/lib/path-helpers.mjs")',
      "plugin/entry-gate.ts",
    ),
    'await import("../shared/lib/path-helpers.mjs")',
  );
  assert.equal(
    rewriteSharedImportsForVendor(
      'import { x } from "../../shared/lib/gate-state-shape.mjs";',
      "lib/gate-state.mjs",
    ),
    'import { x } from "../shared/lib/gate-state-shape.mjs";',
  );
  assert.equal(
    rewriteSharedImportsForVendor(
      "node core/opencode/plugin/lib/mark-gate.mjs stamp",
      "plugin/lib/bash-decide.mjs",
    ),
    "node .opencode/plugin/lib/mark-gate.mjs stamp",
  );
});

// --- OC plugin registration (auto-load, not plugin[]) ------------------------------
// OpenCode globs `.opencode/plugin/*.{ts,js}` — harness files must NOT also appear in
// opencode.json plugin[] (double factory registration). plugin[] is for external packages only.

test("defaultOcPluginPaths() / example / root opencode.json plugin[] are empty (OC auto-load)", () => {
  const fromFn = defaultOcPluginPaths();
  const fromExample = JSON.parse(readFileSync(OC_EXAMPLE_PATH, "utf8")).plugin ?? [];
  const fromRoot = JSON.parse(readFileSync(ROOT_OPENCODE_JSON_PATH, "utf8")).plugin ?? [];

  assert.deepStrictEqual(fromFn, []);
  assert.deepStrictEqual(fromExample, []);
  assert.deepStrictEqual(fromRoot, []);
});

test("harnessOcPluginFiles lists obs-eye and agent-idle-nudge on disk (auto-load carriers)", () => {
  const files = harnessOcPluginFiles();
  assert.ok(files.includes("./.opencode/plugin/obs-eye.ts"));
  assert.ok(files.includes("./.opencode/plugin/agent-idle-nudge.ts"));
  assert.ok(files.every((p) => isHarnessAutoloadPluginPath(p)));
});

test("core/opencode/opencode.json.example sets permission.question allow and permission.external_directory allow", () => {
  const cfg = JSON.parse(readFileSync(OC_EXAMPLE_PATH, "utf8"));

  assert.strictEqual(cfg.permission.question, "allow");
  assert.strictEqual(cfg.permission.external_directory, "allow");
});

test("writeOpencodeConfig propagates the example's permission block into a fresh vendored project", () => {
  const root = mkdtempSync(join(tmpdir(), "vendor-core-writeconfig-"));
  try {
    const openCodeDir = join(root, "oc-src");
    const targetDir = join(root, "target");
    mkdirSync(openCodeDir, { recursive: true });
    mkdirSync(targetDir, { recursive: true });
    cpSync(OC_EXAMPLE_PATH, join(openCodeDir, "opencode.json.example"));

    const status = writeOpencodeConfig(openCodeDir, targetDir);
    assert.strictEqual(status, "created");

    const written = JSON.parse(readFileSync(join(targetDir, "opencode.json"), "utf8"));
    assert.strictEqual(written.permission.question, "allow");
    assert.strictEqual(written.permission.external_directory, "allow");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writeOpencodeConfig strips harness autoload paths; keeps external plugins", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vendor-oc-sidecar-"));
  try {
    writeFileSync(
      join(tempDir, "opencode.json"),
      JSON.stringify({
        model: "project/model",
        plugin: [
          "project-plugin",
          "./local/plugin.ts",
          "./.opencode/plugin/entry-gate.ts",
          "./.opencode/plugin/planner-recovery.ts",
        ],
      }),
    );
    const status = writeOpencodeConfig(join(harnessRoot, "core/opencode"), tempDir);
    assert.match(status, /updated existing/);
    writeOpencodeConfig(join(harnessRoot, "core/opencode"), tempDir);
    const config = JSON.parse(readFileSync(join(tempDir, "opencode.json"), "utf8"));
    assert.equal(config.model, "project/model");
    assert.deepEqual(config.plugin, ["project-plugin", "./local/plugin.ts"]);
    assert.equal(config.plugin.filter((entry) => entry.includes("planner-recovery.ts")).length, 0);
    assert.equal(existsSync(join(tempDir, "opencode.harness.json")), false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("writeOpencodeConfig preserves malformed project config and emits repair sidecar", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vendor-oc-invalid-config-"));
  try {
    const original = "{ project-owned invalid json\n";
    writeFileSync(join(tempDir, "opencode.json"), original);
    const status = writeOpencodeConfig(join(harnessRoot, "core/opencode"), tempDir);
    assert.match(status, /manual repair/);
    assert.equal(readFileSync(join(tempDir, "opencode.json"), "utf8"), original);
    const sidecar = JSON.parse(readFileSync(join(tempDir, "opencode.harness.json"), "utf8"));
    assert.ok(Array.isArray(sidecar.plugin));
    assert.equal(sidecar.plugin.filter((p) => String(p).includes(".opencode/plugin/")).length, 0);
    assert.equal(existsSync(join(tempDir, ".opencode", ".harness-config-manifest.json")), false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("writeOpencodeConfig (issue #479): a fresh project gains a manifest and re-running it is byte-identical", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vendor-oc-manifest-fresh-"));
  try {
    const first = writeOpencodeConfig(join(harnessRoot, "core/opencode"), tempDir, "v0.50.0");
    assert.equal(first, "created");

    const manifestPath = join(tempDir, ".opencode", ".harness-config-manifest.json");
    assert.ok(existsSync(manifestPath), "a fresh project must gain the manifest sidecar (ac-1.3)");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(manifest.harnessVersion, "v0.50.0");
    assert.equal(manifest.owned.question, "allow");

    const configBefore = readFileSync(join(tempDir, "opencode.json"), "utf8");
    const manifestBefore = readFileSync(manifestPath, "utf8");

    writeOpencodeConfig(join(harnessRoot, "core/opencode"), tempDir, "v0.50.0");

    assert.equal(readFileSync(join(tempDir, "opencode.json"), "utf8"), configBefore, "ac-1.4: config must be byte-identical on a second pass");
    assert.equal(readFileSync(manifestPath, "utf8"), manifestBefore, "ac-1.4: manifest must be byte-identical on a second pass");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("writeOpencodeConfig (issue #479, ac-1.2/ac-1.7-style): tier 2 drops the retired npx wildcard entries but keeps a diverged custom bash rule", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vendor-oc-ledger-tier2-"));
  try {
    mkdirSync(join(tempDir, ".opencode"), { recursive: true });
    writeFileSync(join(tempDir, ".opencode", ".harness-version"), "v0.14.0\nvendored_at: 2026-01-01T00:00:00.000Z\n");
    const legacyConfig = JSON.parse(readFileSync(ROOT_OPENCODE_JSON_PATH, "utf8"));
    // The legacy state must be built here, never borrowed from the repo's live opencode.json: that
    // file is itself migrated over time, and once the harness retires these keys from it the
    // fixture silently stops carrying anything to remove — the migration then reports only "kept
    // custom" and this test fails for a reason that has nothing to do with the code under test.
    for (const wildcard of RETIRED_NPX_WILDCARDS) legacyConfig.permission.bash[wildcard] = "allow";
    legacyConfig.permission.bash["git pull*"] = "ask"; // operator customization diverging from the historical "allow"
    writeFileSync(join(tempDir, "opencode.json"), `${JSON.stringify(legacyConfig, null, 2)}\n`);

    const status = writeOpencodeConfig(join(harnessRoot, "core/opencode"), tempDir, "v0.50.0");
    assert.match(status, /permission migration/);
    // ac-1.7: the operator must see WHICH key was kept and why, not just an aggregate count.
    assert.match(status, /git pull\*/, "a diverged retired key must be named in the report, not just counted");
    assert.match(status, /removed retired/);

    const migrated = JSON.parse(readFileSync(join(tempDir, "opencode.json"), "utf8"));
    for (const wildcard of RETIRED_NPX_WILDCARDS) {
      assert.ok(!Object.hasOwn(migrated.permission.bash, wildcard), `retired wildcard must be pruned: ${wildcard}`);
    }
    assert.equal(migrated.permission.bash["git pull*"], "ask", "a value diverging from the ledger's historical default must survive");

    const manifest = JSON.parse(readFileSync(join(tempDir, ".opencode", ".harness-config-manifest.json"), "utf8"));
    assert.equal(manifest.harnessVersion, "v0.50.0");

    const backupPath = join(tempDir, "opencode.json.pre-migration.bak");
    assert.ok(existsSync(backupPath), "a tier-2 removal must preserve the pre-migration bytes once (rollback layer 2)");
    const backup = JSON.parse(readFileSync(backupPath, "utf8"));
    assert.equal(backup.permission.bash["npx github:orobsonn/claude-harness#* init*"], "allow", "the backup must hold the ORIGINAL pre-migration content");

    // Re-running must NOT clobber the backup — it is a one-time snapshot of the true pre-migration state.
    const backupBefore = readFileSync(backupPath, "utf8");
    writeOpencodeConfig(join(harnessRoot, "core/opencode"), tempDir, "v0.51.0");
    assert.equal(readFileSync(backupPath, "utf8"), backupBefore, "the backup must never be overwritten by a later run");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("writeOpencodeConfig (issue #479): a malformed manifest.owned degrades gracefully and never blocks a valid re-migration", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vendor-oc-manifest-corrupt-"));
  try {
    writeOpencodeConfig(join(harnessRoot, "core/opencode"), tempDir, "v0.50.0");
    const originalConfig = readFileSync(join(tempDir, "opencode.json"), "utf8");

    // Corrupt the manifest's `owned` field into a scalar — migrateOpencodeConfig defensively
    // ignores it (falls back to {}), so this alone must NOT block a normal, valid re-migration.
    const manifestPath = join(tempDir, ".opencode", ".harness-config-manifest.json");
    writeFileSync(manifestPath, JSON.stringify({ version: 1, harnessVersion: "v0.50.0", owned: "not-an-object" }));

    const status = writeOpencodeConfig(join(harnessRoot, "core/opencode"), tempDir, "v0.50.0");
    assert.doesNotMatch(status, /manual repair/, "a malformed manifest must degrade gracefully, not corrupt the project");
    assert.equal(readFileSync(join(tempDir, "opencode.json"), "utf8"), originalConfig);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---------- writeSettings (issue #487: cc-settings-migration) ----------

test("writeSettings: fresh project gets the shipped settings.json and a manifest", () => {
  const claudeDir = mkdtempSync(join(tmpdir(), "vendor-cc-settings-fresh-"));
  try {
    const status = writeSettings(CC_CORE_DIR, claudeDir, "v0.50.0");
    assert.equal(status, "created");

    const written = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"));
    const shipped = JSON.parse(readFileSync(CC_SETTINGS_PATH, "utf8"));
    assert.deepEqual(written, shipped);

    const manifest = JSON.parse(readFileSync(join(claudeDir, ".harness-config-manifest.json"), "utf8"));
    assert.equal(manifest.harnessVersion, "v0.50.0");
    assert.deepEqual(manifest.owned.permissions.deny, shipped.permissions.deny);
  } finally {
    rmSync(claudeDir, { recursive: true, force: true });
  }
});

test("writeSettings (ac-1.1): an already-vendored project without the migration's manifest gains the secret-read denies while its own custom permission survives", () => {
  const claudeDir = mkdtempSync(join(tmpdir(), "vendor-cc-settings-ac11-"));
  try {
    // Simulate a project vendored before this migration existed (v0.18.7-era): no denies at all,
    // plus an operator customization the migration must never touch.
    const legacySettings = {
      permissions: {
        allow: ["Edit", "Write", "Bash(git status:*)", "Bash(my-custom-tool:*)"],
        deny: [],
        defaultMode: "acceptEdits",
      },
    };
    writeFileSync(join(claudeDir, "settings.json"), `${JSON.stringify(legacySettings, null, 2)}\n`);
    writeFileSync(join(claudeDir, ".harness-version"), "v0.18.7\nvendored_at: 2026-01-01T00:00:00.000Z\n");

    const status = writeSettings(CC_CORE_DIR, claudeDir, "v0.51.0");
    assert.match(status, /merged existing settings\.json/);
    assert.match(status, /added/);

    const migrated = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"));
    for (const secretDeny of ["Read(.env)", "Read(.env.*)", "Read(.dev.vars)", "Read(~/.ssh/**)", "Read(~/.aws/**)"]) {
      assert.ok(migrated.permissions.deny.includes(secretDeny), `must inject ${secretDeny}`);
    }
    assert.ok(
      migrated.permissions.allow.includes("Bash(my-custom-tool:*)"),
      "operator's own permission must survive the migration untouched",
    );
    assert.equal(migrated.permissions.defaultMode, "acceptEdits");

    const manifest = JSON.parse(readFileSync(join(claudeDir, ".harness-config-manifest.json"), "utf8"));
    assert.equal(manifest.harnessVersion, "v0.51.0");
  } finally {
    rmSync(claudeDir, { recursive: true, force: true });
  }
});

test("writeSettings (ac-1.2): a stale settings.harness.json orphan is consumed and removed", () => {
  const claudeDir = mkdtempSync(join(tmpdir(), "vendor-cc-settings-orphan-"));
  try {
    const shipped = JSON.parse(readFileSync(CC_SETTINGS_PATH, "utf8"));
    writeFileSync(join(claudeDir, "settings.json"), `${JSON.stringify(shipped, null, 2)}\n`);
    // The old (pre-#487) writeSettings behavior: copy parked here for "manual merge" that never happened.
    writeFileSync(join(claudeDir, "settings.harness.json"), `${JSON.stringify(shipped, null, 2)}\n`);

    const status = writeSettings(CC_CORE_DIR, claudeDir, "v0.50.0");
    assert.match(status, /removed stale settings\.harness\.json orphan/);
    assert.equal(existsSync(join(claudeDir, "settings.harness.json")), false);
  } finally {
    rmSync(claudeDir, { recursive: true, force: true });
  }
});

test("writeSettings (ac-1.3): a second pass over an already-migrated project is byte-identical", () => {
  const claudeDir = mkdtempSync(join(tmpdir(), "vendor-cc-settings-idempotent-"));
  try {
    writeSettings(CC_CORE_DIR, claudeDir, "v0.50.0");
    const configBefore = readFileSync(join(claudeDir, "settings.json"), "utf8");
    const manifestBefore = readFileSync(join(claudeDir, ".harness-config-manifest.json"), "utf8");

    const status = writeSettings(CC_CORE_DIR, claudeDir, "v0.50.0");
    assert.match(status, /already up to date/);
    assert.equal(readFileSync(join(claudeDir, "settings.json"), "utf8"), configBefore);
    assert.equal(readFileSync(join(claudeDir, ".harness-config-manifest.json"), "utf8"), manifestBefore);
  } finally {
    rmSync(claudeDir, { recursive: true, force: true });
  }
});

test("writeSettings (adversary finding, issue #487): a secret-read deny that silently disappears from a shrunken/corrupted source is NEVER dropped without an explicit ledger entry, even though the manifest recorded it as harness-owned", () => {
  const claudeDir = mkdtempSync(join(tmpdir(), "vendor-cc-settings-tier1-"));
  const fakeCoreV1 = mkdtempSync(join(tmpdir(), "vendor-cc-fakecore-v1-"));
  const fakeCoreV2 = mkdtempSync(join(tmpdir(), "vendor-cc-fakecore-v2-"));
  try {
    writeFileSync(
      join(fakeCoreV1, "settings.json"),
      JSON.stringify({ permissions: { allow: ["Edit"], deny: ["Read(.env)", "Read(.dev.vars)"] } }),
    );
    writeSettings(fakeCoreV1, claudeDir, "v0.50.0");

    // Operator customization: an extra deny the harness never shipped.
    const afterFirst = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"));
    afterFirst.permissions.deny.push("Read(secrets/**)");
    writeFileSync(join(claudeDir, "settings.json"), `${JSON.stringify(afterFirst, null, 2)}\n`);

    // A shrunken source — a bad --source, a truncated checkout, a merge mistake — no longer ships
    // Read(.dev.vars) even though RETIRED_CC_PERMISSION_ENTRIES has no ledger entry for it. This
    // must NOT be treated as a legitimate retirement: manifest ownership alone is not corroboration.
    writeFileSync(
      join(fakeCoreV2, "settings.json"),
      JSON.stringify({ permissions: { allow: ["Edit"], deny: ["Read(.env)", "Read(.aws/**)"] } }),
    );
    const status = writeSettings(fakeCoreV2, claudeDir, "v0.51.0");
    assert.doesNotMatch(status, /removed retired/, "no ledger entry exists for Read(.dev.vars) — it must survive, not be pruned");
    assert.equal(existsSync(join(claudeDir, "settings.json.pre-migration.bak")), false, "nothing was removed, so no backup should be created");

    const migrated = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"));
    assert.ok(
      migrated.permissions.deny.includes("Read(.dev.vars)"),
      "a previously-shipped secret-read deny must survive even when the new source stops shipping it, absent a ledger entry",
    );
    assert.ok(migrated.permissions.deny.includes("Read(.aws/**)"), "new v2 entry must still be added");
    assert.ok(migrated.permissions.deny.includes("Read(secrets/**)"), "operator's own addition must survive untouched");
  } finally {
    rmSync(claudeDir, { recursive: true, force: true });
    rmSync(fakeCoreV1, { recursive: true, force: true });
    rmSync(fakeCoreV2, { recursive: true, force: true });
  }
});

test("writeSettings (regression, issue #487 second adversary pass): a ledger-matched retirement IS removed, backs up the true pre-migration bytes exactly once, and a later no-op run never re-creates the backup", () => {
  // RETIRED_CC_PERMISSION_ENTRIES is empty in production (no entry has ever been retired yet), so
  // the removal path it gates is otherwise unreachable by any test — the fresh-virgin re-attack on
  // the issue #487 fix flagged this as a real regression gap on the very mechanism the HIGH finding
  // hardened. `retiredEntries` is writeSettings' test-only seam (never used outside this file).
  const claudeDir = mkdtempSync(join(tmpdir(), "vendor-cc-settings-ledger-removal-"));
  const fakeCoreV1 = mkdtempSync(join(tmpdir(), "vendor-cc-fakecore-ledger-v1-"));
  const fakeCoreV2 = mkdtempSync(join(tmpdir(), "vendor-cc-fakecore-ledger-v2-"));
  try {
    writeFileSync(
      join(fakeCoreV1, "settings.json"),
      JSON.stringify({ permissions: { allow: ["Edit"], deny: ["Read(.env)", "Read(legacy-secret)"] } }),
    );
    writeSettings(fakeCoreV1, claudeDir, "v0.50.0");

    // v2 genuinely retires Read(legacy-secret) — this time with a real, checked-in-shaped ledger entry.
    writeFileSync(
      join(fakeCoreV2, "settings.json"),
      JSON.stringify({ permissions: { allow: ["Edit"], deny: ["Read(.env)"] } }),
    );
    const retiredEntries = [
      {
        arrayPath: ["permissions", "deny"],
        entry: "Read(legacy-secret)",
        shippedThroughGeneration: { major: 0, minor: 50, patch: 0 },
      },
    ];

    const status = writeSettings(fakeCoreV2, claudeDir, "v0.51.0", { retiredEntries });
    assert.match(status, /removed retired/);

    const migrated = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"));
    assert.ok(!migrated.permissions.deny.includes("Read(legacy-secret)"), "a genuine ledger match must still remove the entry");

    const backupPath = join(claudeDir, "settings.json.pre-migration.bak");
    assert.ok(existsSync(backupPath), "a real removal must create the rollback backup");
    const backup = JSON.parse(readFileSync(backupPath, "utf8"));
    assert.ok(backup.permissions.deny.includes("Read(legacy-secret)"), "the backup must hold the true pre-migration bytes");

    const backupBefore = readFileSync(backupPath, "utf8");
    writeSettings(fakeCoreV2, claudeDir, "v0.52.0", { retiredEntries });
    assert.equal(readFileSync(backupPath, "utf8"), backupBefore, "a later no-op run must never overwrite the one-time backup");
  } finally {
    rmSync(claudeDir, { recursive: true, force: true });
    rmSync(fakeCoreV1, { recursive: true, force: true });
    rmSync(fakeCoreV2, { recursive: true, force: true });
  }
});

test("writeSettings preserves malformed existing settings.json and emits a repair sidecar", () => {
  const claudeDir = mkdtempSync(join(tmpdir(), "vendor-cc-settings-invalid-"));
  try {
    const original = "{ project-owned invalid json\n";
    writeFileSync(join(claudeDir, "settings.json"), original);
    const status = writeSettings(CC_CORE_DIR, claudeDir, "v0.50.0");
    assert.match(status, /manual repair/);
    assert.equal(readFileSync(join(claudeDir, "settings.json"), "utf8"), original);
    const sidecar = JSON.parse(readFileSync(join(claudeDir, "settings.harness.json"), "utf8"));
    assert.ok(Array.isArray(sidecar.permissions.deny));
    assert.equal(existsSync(join(claudeDir, ".harness-config-manifest.json")), false);
  } finally {
    rmSync(claudeDir, { recursive: true, force: true });
  }
});

test("writeSettings: a malformed manifest.owned degrades gracefully and never blocks a valid re-migration", () => {
  const claudeDir = mkdtempSync(join(tmpdir(), "vendor-cc-settings-manifest-corrupt-"));
  try {
    writeSettings(CC_CORE_DIR, claudeDir, "v0.50.0");
    const originalConfig = readFileSync(join(claudeDir, "settings.json"), "utf8");

    const manifestPath = join(claudeDir, ".harness-config-manifest.json");
    writeFileSync(manifestPath, JSON.stringify({ version: 1, harnessVersion: "v0.50.0", owned: "not-an-object" }));

    const status = writeSettings(CC_CORE_DIR, claudeDir, "v0.50.0");
    assert.doesNotMatch(status, /manual repair/, "a malformed manifest must degrade gracefully, not corrupt the project");
    assert.equal(readFileSync(join(claudeDir, "settings.json"), "utf8"), originalConfig);
  } finally {
    rmSync(claudeDir, { recursive: true, force: true });
  }
});
