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
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
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
  normalizeRuntimeTarget,
  resolveProjectTarget,
  writeOpencodeConfig,
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

test("vendor-core: hooks are included in FRAMEWORK_OWNED", (t) => {
  const scriptContent = readFileSync(vendorCoreScript, "utf8");
  assert.match(
    scriptContent,
    /const FRAMEWORK_OWNED = \["agents",\s*"skills",\s*"rules",\s*"hooks"\]/,
    "FRAMEWORK_OWNED should contain 'hooks' alongside agents, skills, and rules"
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

test("t9-creates: --runtime opencode creates .opencode agents skills plugin tools and harness.routing.json", () => {
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
    ];
    for (const rel of required) {
      assert.ok(existsSync(join(tempDir, rel)), `missing ${rel}`);
    }
    // default runtime remains claude-only — OC path must NOT create .claude
    assert.ok(!existsSync(join(tempDir, ".claude/agents")), "opencode-only must not vendor .claude agents");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
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

    // entry-gate delegates shared logic to ./lib/dual-enforcement.mjs; its imports (and the
    // shared imports rewritten inside dual-enforcement) must be relative, never absolute home.
    const entry = readFileSync(join(tempDir, ".opencode/plugin/entry-gate.ts"), "utf8");
    assert.match(entry, /from "\.\/lib\/dual-enforcement\.mjs"|import\("\.\/lib\/dual-enforcement\.mjs"\)/);
    assert.ok(!entry.includes("/Users/"), "vendored plugin must not embed absolute home paths");
    const dualEnf = readFileSync(join(tempDir, ".opencode/plugin/lib/dual-enforcement.mjs"), "utf8");
    assert.match(dualEnf, /from "\.\.\/\.\.\/shared\/lib\/gate-state-shape\.mjs"/);
    assert.ok(!dualEnf.includes("/Users/"), "vendored shared import must be relative, not home path");
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
      'import { x } from "../../../shared/lib/gate-state-shape.mjs";',
      "plugin/lib/gate-state.mjs",
    ),
    'import { x } from "../../shared/lib/gate-state-shape.mjs";',
  );
});

// --- OC plugin-registry parity (guard/regression) ------------------------------
//
// These four pin an existing, already-green parity contract across the three surfaces that
// must agree on the OpenCode plugin registry: defaultOcPluginPaths(), the
// core/opencode/opencode.json.example fixture, and the repo-root opencode.json — plus the
// permission.question / permission.external_directory contract those surfaces carry, including
// through writeOpencodeConfig's fresh-project write path.

test("defaultOcPluginPaths() matches the plugin[] parsed from the example and the repo-root opencode.json", () => {
  const fromFn = defaultOcPluginPaths();
  const fromExample = JSON.parse(readFileSync(OC_EXAMPLE_PATH, "utf8")).plugin;
  const fromRoot = JSON.parse(readFileSync(ROOT_OPENCODE_JSON_PATH, "utf8")).plugin;

  assert.deepStrictEqual(fromExample, fromFn);
  assert.deepStrictEqual(fromRoot, fromFn);
});

test("all three plugin registration surfaces include the obs-eye dual-nudge carrier", () => {
  const fromFn = defaultOcPluginPaths();
  const fromExample = JSON.parse(readFileSync(OC_EXAMPLE_PATH, "utf8")).plugin;
  const fromRoot = JSON.parse(readFileSync(ROOT_OPENCODE_JSON_PATH, "utf8")).plugin;

  assert.ok(fromFn.includes("./.opencode/plugin/obs-eye.ts"));
  assert.ok(fromExample.includes("./.opencode/plugin/obs-eye.ts"));
  assert.ok(fromRoot.includes("./.opencode/plugin/obs-eye.ts"));
});

test("core/opencode/opencode.json.example sets permission.question deny and permission.external_directory allow", () => {
  const cfg = JSON.parse(readFileSync(OC_EXAMPLE_PATH, "utf8"));

  assert.strictEqual(cfg.permission.question, "deny");
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
    assert.strictEqual(written.permission.question, "deny");
    assert.strictEqual(written.permission.external_directory, "allow");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
