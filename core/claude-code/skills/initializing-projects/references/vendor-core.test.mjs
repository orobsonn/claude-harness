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
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  isFrameworkCopyIncluded,
  shouldVendorModule,
  findUnresolvedVendoredImports,
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

test("vendor-core CLI stamps the release package version, not an older git-describe ancestor", () => {
  const target = mkdtempSync(join(tmpdir(), "vendor-package-version-"));
  try {
    const expected = `v${JSON.parse(readFileSync(join(harnessRoot, "package.json"), "utf8")).version}`;
    const result = spawnSync(
      process.execPath,
      [vendorCoreScript, "--source", harnessRoot, "--target", target, "--runtime", "opencode"],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const stamp = readFileSync(join(target, ".opencode", ".harness-version"), "utf8").split(/\r?\n/)[0];
    assert.equal(stamp, expected);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("vendor-core writes an exact Claude ownership manifest for lifecycle shipping", () => {
  const target = mkdtempSync(join(tmpdir(), "vendor-claude-owned-files-"));
  try {
    const result = spawnSync(
      process.execPath,
      [vendorCoreScript, "--source", harnessRoot, "--target", target, "--runtime", "claude"],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const manifest = JSON.parse(readFileSync(join(target, ".claude", ".harness-owned-files.json"), "utf8"));
    assert.equal(manifest.version, 1);
    assert.ok(manifest.files.includes(".claude/agents/executor.md"));
    assert.ok(manifest.files.includes(".claude/.harness-owned-files.json"));
    assert.ok(!manifest.files.includes(".claude/plans/local.json"));
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

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

/**
 * @description #807 — findUnresolvedVendoredImports replaces the retired core/vps/-only
 * findMissingHookVpsDeps. The generalized gate answers "does every relative import in every
 * vendored framework file resolve under .claude/?" — it must catch the same stale-jump failure
 * class (an updated file importing a path the installer never created → ERR_MODULE_NOT_FOUND on
 * load → the hook silently dies → the entry-gate blocks every delivery subagent), but for ANY
 * vendored dir (shared/, modules/, skills/ references at any depth), not just hooks/.
 */
test("findUnresolvedVendoredImports: flags a hook whose relative import has no file under .claude/, and passes when present", () => {
  const claudeDir = mkdtempSync(join(tmpdir(), "vendor-check-"));
  mkdirSync(join(claudeDir, "hooks"), { recursive: true });
  writeFileSync(
    join(claudeDir, "hooks", "stamp-triage.mjs"),
    'import { appendEvent } from "../shared/lib/obs-outbox.mjs";\n',
    "utf8",
  );

  // shared/ absent → the import is reported unresolved (the stale-jump state)
  const missing = findUnresolvedVendoredImports(claudeDir);
  assert.equal(missing.length, 1);
  assert.deepEqual(missing[0], {
    file: join("hooks", "stamp-triage.mjs"),
    specifier: "../shared/lib/obs-outbox.mjs",
  });

  // once the target exists, the check passes clean
  mkdirSync(join(claudeDir, "shared", "lib"), { recursive: true });
  writeFileSync(join(claudeDir, "shared", "lib", "obs-outbox.mjs"), "export const x = 1;\n", "utf8");
  assert.deepEqual(findUnresolvedVendoredImports(claudeDir), []);
});

test("findUnresolvedVendoredImports: ignores *.test.mjs imports (their imports never ship)", () => {
  const claudeDir = mkdtempSync(join(tmpdir(), "vendor-check-"));
  mkdirSync(join(claudeDir, "hooks"), { recursive: true });
  writeFileSync(
    join(claudeDir, "hooks", "foo.test.mjs"),
    'import { readEvents } from "../shared/lib/heavy-only-in-tests.mjs";\n',
    "utf8",
  );
  assert.deepEqual(
    findUnresolvedVendoredImports(claudeDir),
    [],
    "a test-only relative import is never a vendor defect",
  );
});

/**
 * @description Corrections #2/#4 to the spec: the regex must not be `from`-anchored only. A
 * multi-line import whose specifier line starts with `}` (obs-plan-write.mjs's real shape) must
 * still be caught, and so must a side-effect-shaped import (`import "./x.mjs"`) and a deferred
 * dynamic import (`await import('./x.mjs')` — the vps-access-nudge.mjs shape, whose own docstring
 * promises this exact gate sees it).
 */
test("findUnresolvedVendoredImports: catches a multi-line import specifier line starting with '}'", () => {
  const claudeDir = mkdtempSync(join(tmpdir(), "vendor-check-"));
  mkdirSync(join(claudeDir, "hooks"), { recursive: true });
  writeFileSync(
    join(claudeDir, "hooks", "obs-plan-write.mjs"),
    'import {\n  appendEvent,\n} from "../shared/lib/missing-multi.mjs";\n',
    "utf8",
  );
  const missing = findUnresolvedVendoredImports(claudeDir);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].specifier, "../shared/lib/missing-multi.mjs");
});

test("findUnresolvedVendoredImports: catches a side-effect import and a deferred dynamic import", () => {
  const claudeDir = mkdtempSync(join(tmpdir(), "vendor-check-"));
  mkdirSync(join(claudeDir, "hooks"), { recursive: true });
  writeFileSync(join(claudeDir, "hooks", "side-effect.mjs"), 'import "./missing-side-effect.mjs";\n', "utf8");
  mkdirSync(join(claudeDir, "hooks"), { recursive: true });
  writeFileSync(
    join(claudeDir, "hooks", "vps-access-nudge.mjs"),
    "const mod = await import('../skills/connecting-orca/references/orca-doctor.mjs');\n",
    "utf8",
  );
  const missing = findUnresolvedVendoredImports(claudeDir);
  const specifiers = missing.map((m) => m.specifier).sort();
  assert.deepEqual(specifiers, [
    "../skills/connecting-orca/references/orca-doctor.mjs",
    "./missing-side-effect.mjs",
  ]);
});

/**
 * @description Correction #3 to the spec: the measured false-positive is side-effect-shaped
 * (vendor-core.mjs's own JSDoc `import "../vps/obs-outbox.mjs"` prose), and there is a real
 * `from`-shaped case too (detect-stack.mjs's JSDoc usage example). Both must be ignored once
 * comments are stripped.
 */
test("findUnresolvedVendoredImports: ignores specifiers written only inside a /** ... */ block", () => {
  const claudeDir = mkdtempSync(join(tmpdir(), "vendor-check-"));
  mkdirSync(join(claudeDir, "hooks"), { recursive: true });
  writeFileSync(
    join(claudeDir, "hooks", "documented.mjs"),
    [
      "/**",
      " * usage:",
      " *   import { detectStack } from \"./nope-from.mjs\";",
      " *   import \"./nope-side-effect.mjs\";",
      " */",
      "export const x = 1;",
      "",
    ].join("\n"),
    "utf8",
  );
  assert.deepEqual(
    findUnresolvedVendoredImports(claudeDir),
    [],
    "a specifier that appears only inside a block comment must not be reported",
  );
});

/**
 * @description Correction #4 to the spec: the mandated line-oriented comment stripper must not
 * treat a `/*` inside a string literal (e.g. a glob like '**\/*.test.mjs') as a comment opener —
 * detect-stack.mjs's real NODE_TEST_COMMAND constant carries exactly this shape. A whole-file
 * block-comment regex would swallow everything up to the next comment-close marker, silently
 * hiding any import that follows.
 */
test("findUnresolvedVendoredImports: a glob string containing '/*' does not open a fake block comment", () => {
  const claudeDir = mkdtempSync(join(tmpdir(), "vendor-check-"));
  mkdirSync(join(claudeDir, "hooks"), { recursive: true });
  writeFileSync(
    join(claudeDir, "hooks", "glob-carrier.mjs"),
    [
      'const NODE_TEST_COMMAND = \'node --test "**/*.test.mjs"\';',
      '/** some later JSDoc */',
      'import { x } from "./missing-after-glob.mjs";',
      "",
    ].join("\n"),
    "utf8",
  );
  const missing = findUnresolvedVendoredImports(claudeDir);
  assert.deepEqual(
    missing.map((m) => m.specifier),
    ["./missing-after-glob.mjs"],
    "the import after the glob line must still be seen, not swallowed by a fake comment span",
  );
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
    const ladderModule = await import(pathToFileURL(join(tempDir, ".claude/shared/lib/hand-model-ladder.mjs")).href);
    // The vendored project's OWN toggle state (the test process's cwd is the harness repo).
    const inProject = { readActiveFamily: () => ladderModule.readActiveHandFamily(tempDir) };
    const OLLAMA_MS = '{"model_strategy":{"hand_tiers":{"low":"gemma4","medium":"glm-5.2","high":"kimi-k2.7-code"},"planner":"opus"}}';
    const CLAUDE_MS = '{"model_strategy":{"hand_tiers":{"low":"haiku","medium":"sonnet","high":"sonnet"},"planner":"opus"}}';

    const refused = gate.checkPlanContent(
      '{"model_strategy":{"hand_tiers":{"low":"gpt-oss:20b","medium":"glm-5.2","high":"kimi-k2.7-code"},"planner":"opus"}}',
      inProject,
    );
    assert.match(refused ?? "", /gpt-oss:20b/, "a fresh vendored project must refuse an off-ladder tier");

    // FACTORY DEFAULT: a freshly vendored project runs claude hands — no token file, no third-party
    // endpoint, nothing to configure. The ollama ladder is refused until the operator opts in.
    assert.equal(gate.checkPlanContent(CLAUDE_MS, inProject), null, "the default claude ladder must pass");
    assert.match(
      gate.checkPlanContent(OLLAMA_MS, inProject) ?? "",
      /active hand family is claude/,
      "the ollama ladder must be refused until the operator opts in",
    );

    // THE OPERATOR FLOW, end to end: one command in the project flips the family, and the gate
    // that governs plan authoring immediately enforces the other ladder.
    const flip = spawnSync("node", [join(tempDir, ".claude/shared/lib/hand-model-ladder.mjs"), "use", "ollama"], {
      cwd: tempDir,
      encoding: "utf8",
      stdio: "pipe",
    });
    assert.equal(flip.status, 0, `the hand-family CLI failed: ${flip.stderr || flip.stdout}`);
    assert.match(flip.stdout, /ollama/);
    assert.equal(gate.checkPlanContent(OLLAMA_MS, inProject), null, "after the flip the ollama ladder must pass");
    assert.match(
      gate.checkPlanContent(CLAUDE_MS, inProject) ?? "",
      /active hand family is ollama/,
      "after the flip the claude ladder must be refused",
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

/** @description Recursively lists every file under `root` (absolute paths). Test-local helper. */
function listFilesRecursive(root) {
  const out = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(root);
  return out;
}

/**
 * @description #807 #ac-2.2 — obs-outbox.mjs moved to core/shared/lib/, which is already
 * blanket-mirrored and depth-rewritten by the pre-existing shared/ vendoring path. A clean vendor
 * must therefore create NO `.claude/vps/` at all, and — the generalized replacement for the old
 * hooks-only check — every relative import in every vendored file must resolve under `.claude/`.
 * The dynamic imports are the real regression guard (a string check on the import line would pass
 * against a subtly wrong depth): stamp-triage.mjs is the depth-1 hook case, descriptor-emitter.mjs
 * is the depth-3 skill-reference case the old hooks-only findMissingHookVpsDeps never covered.
 */
test("vendor-core: a clean vendor creates NO .claude/vps/, and every vendored file resolves its imports (#807 #ac-2.2)", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "vendor-test-"));
  try {
    const result = spawnSync(
      "node",
      [vendorCoreScript, "--source", harnessRoot, "--target", tempDir],
      { encoding: "utf8", stdio: "pipe" },
    );
    assert.equal(result.status, 0, `vendor-core failed: ${result.stderr || result.stdout}`);

    assert.equal(
      existsSync(join(tempDir, ".claude/vps")),
      false,
      "the retired vps mirror must not be recreated",
    );
    assert.deepEqual(
      findUnresolvedVendoredImports(join(tempDir, ".claude")),
      [],
      "every vendored relative import must resolve under .claude/",
    );

    await assert.doesNotReject(
      import(pathToFileURL(join(tempDir, ".claude/hooks/stamp-triage.mjs")).href),
      "vendored stamp-triage.mjs must resolve its obs-outbox import",
    );
    await assert.doesNotReject(
      import(
        pathToFileURL(
          join(tempDir, ".claude/skills/orchestrating-delivery/references/descriptor-emitter.mjs"),
        ).href
      ),
      "a depth-3 skill reference must resolve its shared import too",
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

/**
 * @description #807 §2.6 — re-expression of the retired `.claude/vps/notify-telegram.mjs` /
 * `.claude/vps/scoped-env.mjs` absence checks now that `.claude/vps/` no longer exists at all.
 * Strictly stronger than the original: notify-telegram.mjs's only live consumer is a test file
 * (core/claude-code/hooks/obs-markers.test.mjs), so it — and its sole dependent scoped-env.mjs —
 * must never appear ANYWHERE in a vendored tree, not merely absent from one retired directory.
 * `core/notify/` (their new home) sits in no FRAMEWORK_OWNED list, no shared/ mirror, and no
 * OPT_IN_MODULES sibling — this test is the tripwire that keeps that true. cron-a-dispatch.mjs
 * (the dead engine's composition root) is included for the same reason.
 */
test("vendor-core: retired-engine runtime never ships into a vendored project (#807)", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "vendor-test-"));
  try {
    const result = spawnSync(
      "node",
      [vendorCoreScript, "--source", harnessRoot, "--target", tempDir, "--with-codex"],
      { encoding: "utf8", stdio: "pipe" },
    );
    assert.equal(result.status, 0, `vendor-core failed: ${result.stderr || result.stdout}`);

    const all = listFilesRecursive(join(tempDir, ".claude"));
    for (const forbidden of ["notify-telegram.mjs", "scoped-env.mjs", "cron-a-dispatch.mjs"]) {
      assert.equal(
        all.some((p) => p.endsWith(sep + forbidden)),
        false,
        `${forbidden} must never be vendored — it is not a consumer-side module`,
      );
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

/**
 * @description #807 #ac-2.3 — an OLDER vendoring's `.claude/vps/` must be actively cleaned on the
 * next vendor, because it is now a second, stale copy of a module that also lives at
 * `.claude/shared/lib/obs-outbox.mjs` — and once `.harness-owned-files.json` stops listing it, the
 * lifecycle shipper would otherwise reclassify it as the project's own cargo. The static
 * CLAUDE_RETIRED_FILES ledger is the load-bearing half (case 3): the manifest is rewritten WITHOUT
 * the vps entry the very first time the new installer runs (copyHookVpsDeps no longer exists to
 * repopulate it), orphaning the stale file before the manifest ever recorded it as gone — only the
 * static ledger catches that case. An operator's own file in `.claude/vps/` must survive untouched,
 * and the directory itself is only removed when left empty (never force-removed).
 */
test("vendor-core: an OLDER vendoring's .claude/vps/ is cleaned, and an operator's own file there survives (#807 #ac-2.3)", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "vendor-test-"));
  try {
    let result = spawnSync(
      "node",
      [vendorCoreScript, "--source", harnessRoot, "--target", tempDir],
      { encoding: "utf8", stdio: "pipe" },
    );
    assert.equal(result.status, 0, `first vendor failed: ${result.stderr || result.stdout}`);

    // Case 1 + 2: simulate the legacy `.claude/vps/` mirror this installer used to write, with
    // BOTH a harness-written file and an operator's own file placed alongside it.
    mkdirSync(join(tempDir, ".claude/vps"), { recursive: true });
    writeFileSync(join(tempDir, ".claude/vps/obs-outbox.mjs"), "// stale legacy mirror\n", "utf8");
    writeFileSync(join(tempDir, ".claude/vps/OPERATOR_NOTES.md"), "keep me\n", "utf8");

    result = spawnSync(
      "node",
      [vendorCoreScript, "--source", harnessRoot, "--target", tempDir],
      { encoding: "utf8", stdio: "pipe" },
    );
    assert.equal(result.status, 0, `second vendor failed: ${result.stderr || result.stdout}`);

    assert.equal(
      existsSync(join(tempDir, ".claude/vps/obs-outbox.mjs")),
      false,
      "the stale harness-written mirror file must be removed",
    );
    assert.ok(
      existsSync(join(tempDir, ".claude/vps/OPERATOR_NOTES.md")),
      "a file the operator placed in .claude/vps/ must survive",
    );
    assert.ok(
      existsSync(join(tempDir, ".claude/vps")),
      "the directory must not be force-removed while an operator file remains in it",
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

/**
 * @description #807 #ac-2.3, case with only the harness file present: the retired directory
 * itself must be fully removed (not left as an empty husk) once nothing but harness output was in
 * it.
 */
test("vendor-core: .claude/vps/ is removed entirely when only the harness's stale file was in it (#807 #ac-2.3)", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "vendor-test-"));
  try {
    let result = spawnSync(
      "node",
      [vendorCoreScript, "--source", harnessRoot, "--target", tempDir],
      { encoding: "utf8", stdio: "pipe" },
    );
    assert.equal(result.status, 0, `first vendor failed: ${result.stderr || result.stdout}`);

    mkdirSync(join(tempDir, ".claude/vps"), { recursive: true });
    writeFileSync(join(tempDir, ".claude/vps/obs-outbox.mjs"), "// stale legacy mirror\n", "utf8");

    result = spawnSync(
      "node",
      [vendorCoreScript, "--source", harnessRoot, "--target", tempDir],
      { encoding: "utf8", stdio: "pipe" },
    );
    assert.equal(result.status, 0, `second vendor failed: ${result.stderr || result.stdout}`);

    assert.equal(
      existsSync(join(tempDir, ".claude/vps")),
      false,
      "an empty retired directory must be removed, not left behind",
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

/**
 * @description Correction #5's decisive case: on the LIKELIEST real path — an already-vendored
 * project whose `.harness-owned-files.json` was already rewritten by a version of this installer
 * that no longer mirrors `../vps/` deps — the manifest does NOT list the stale
 * `.claude/vps/obs-outbox.mjs` file at all (copyHookVpsDeps never ran to repopulate it). Only the
 * static CLAUDE_RETIRED_FILES ledger catches this; the manifest-union half of the delete set would
 * see nothing here.
 */
test("vendor-core: the static retired-files ledger cleans a stale .claude/vps/ file the manifest never listed (#807 #ac-2.3)", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "vendor-test-"));
  try {
    let result = spawnSync(
      "node",
      [vendorCoreScript, "--source", harnessRoot, "--target", tempDir],
      { encoding: "utf8", stdio: "pipe" },
    );
    assert.equal(result.status, 0, `first vendor failed: ${result.stderr || result.stdout}`);

    // Simulate the post-stale-jump state: a manifest that already reflects the new installer
    // (no vps/ entry anywhere) sitting alongside a leftover vps file an older release wrote.
    const manifestPath = join(tempDir, ".claude/.harness-owned-files.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.ok(
      !manifest.files.some((f) => f.replace(/\\/g, "/").includes(".claude/vps/")),
      "sanity check: a fresh manifest from this installer never lists .claude/vps/",
    );
    mkdirSync(join(tempDir, ".claude/vps"), { recursive: true });
    writeFileSync(join(tempDir, ".claude/vps/obs-outbox.mjs"), "// orphaned by an older release\n", "utf8");

    result = spawnSync(
      "node",
      [vendorCoreScript, "--source", harnessRoot, "--target", tempDir],
      { encoding: "utf8", stdio: "pipe" },
    );
    assert.equal(result.status, 0, `second vendor failed: ${result.stderr || result.stdout}`);

    assert.equal(
      existsSync(join(tempDir, ".claude/vps/obs-outbox.mjs")),
      false,
      "the static ledger must remove this file even though no manifest ever named it",
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
    const ownership = JSON.parse(readFileSync(join(tempDir, ".opencode/.harness-owned-files.json"), "utf8"));
    assert.equal(
      ownership.files.includes("harness.routing.json"),
      false,
      "the lifecycle overlay may own only files actually vendored into the clone",
    );
    assert.deepEqual(
      ownership.retired.filter((path) => path.includes("autonomy-controller")),
      [".opencode/plugin/autonomy-controller.ts", ".opencode/plugin/lib/autonomy-controller.mjs"],
      "the vendor must declare each actually-retired controller path for a pre-manifest update",
    );
    assert.ok(!ownership.retired.includes("src/product.js"), "the retirement ledger must never become a product allowlist");
    assert.equal(existsSync(join(tempDir, ".opencode/plugin/harvest-guard.ts")), false);
    assert.equal(existsSync(join(tempDir, ".opencode/plugin/lib/harvest-findings.mjs")), false);
    assert.equal(existsSync(join(tempDir, ".opencode/plugin/lib/agent-catalog-health.mjs")), false);
    assert.equal(existsSync(join(tempDir, ".opencode/plugin/lib/ceremony-binding.mjs")), false);
    assert.equal(existsSync(join(tempDir, ".opencode/plugin/lib/ceremony-transition.mjs")), false);
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

test("OpenCode vendor ignores AppleDouble metadata and removes stale AppleDouble artifacts", () => {
  const sourceRoot = mkdtempSync(join(tmpdir(), "vendor-oc-appledouble-source-"));
  const target = mkdtempSync(join(tmpdir(), "vendor-oc-appledouble-target-"));
  try {
    cpSync(join(harnessRoot, "core"), join(sourceRoot, "core"), { recursive: true });
    cpSync(join(harnessRoot, "package.json"), join(sourceRoot, "package.json"));
    writeFileSync(join(sourceRoot, "core/opencode/plugin/._entry-gate.ts"), Buffer.from([0, 1, 2, 3]));

    const stale = join(target, ".opencode/plugin/._stale-plugin.ts");
    mkdirSync(dirname(stale), { recursive: true });
    writeFileSync(stale, Buffer.from([0, 1, 2, 3]));

    const result = spawnSync(
      "node",
      [vendorCoreScript, "--source", sourceRoot, "--target", target, "--runtime", "opencode"],
      { encoding: "utf8", stdio: "pipe" },
    );
    assert.equal(result.status, 0, `vendor failed: ${result.stderr || result.stdout}`);
    assert.equal(existsSync(join(target, ".opencode/plugin/._entry-gate.ts")), false);
    assert.equal(existsSync(stale), false);
    const manifest = JSON.parse(readFileSync(join(target, ".opencode/.harness-owned-files.json"), "utf8"));
    assert.equal(manifest.files.some((file) => file.split("/").some((part) => part.startsWith("._"))), false);
    assert.ok(existsSync(join(target, ".opencode/plugin/entry-gate.ts")), "the real plugin remains vendored");
  } finally {
    rmSync(sourceRoot, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("re-vendoring onto an already-vendored project deletes retired plugin files (no zombie auto-load)", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vendor-oc-retired-"));
  try {
    const staleResolver = join(tempDir, ".opencode/plugin/command-resolver.ts");
    const staleLib = join(tempDir, ".opencode/plugin/lib/command-resolver.mjs");
    const staleMarkGate = join(tempDir, ".opencode/plugin/lib/mark-gate.mjs");
    const staleAutonomyController = join(tempDir, ".opencode/plugin/autonomy-controller.ts");
    const staleAutonomyControllerLib = join(tempDir, ".opencode/plugin/lib/autonomy-controller.mjs");
    const projectSibling = join(tempDir, ".opencode/plugin/lib/project-owned-marker.mjs");
    mkdirSync(dirname(staleResolver), { recursive: true });
    mkdirSync(dirname(staleLib), { recursive: true });
    writeFileSync(staleResolver, "// stale plugin from a prior vendor\n", "utf8");
    writeFileSync(staleLib, "// stale lib from a prior vendor\n", "utf8");
    writeFileSync(staleMarkGate, "// stale shell marker from a prior vendor\n", "utf8");
    writeFileSync(staleAutonomyController, "// stale automatic continuation plugin\n", "utf8");
    writeFileSync(staleAutonomyControllerLib, "// stale automatic continuation helper\n", "utf8");
    writeFileSync(projectSibling, "export const projectOwned = true;\n", "utf8");

    const result = spawnSync(
      "node",
      [vendorCoreScript, "--source", harnessRoot, "--target", tempDir, "--runtime", "opencode"],
      { encoding: "utf8", stdio: "pipe" },
    );
    assert.equal(result.status, 0, `vendor failed: ${result.stderr || result.stdout}`);

    assert.ok(!existsSync(staleResolver), "retired plugin file must be deleted on re-vendor");
    assert.ok(!existsSync(staleLib), "retired plugin lib must be deleted on re-vendor");
    assert.ok(!existsSync(staleMarkGate), "retired mark-gate helper must be deleted on re-vendor");
    assert.ok(!existsSync(staleAutonomyController), "retired automatic continuation plugin must be deleted on re-vendor");
    assert.ok(!existsSync(staleAutonomyControllerLib), "retired automatic continuation helper must be deleted on re-vendor");
    assert.ok(existsSync(projectSibling), "exact retirement must preserve project-owned siblings");
    // A live harness plugin planted the same run must survive untouched (only the exact
    // retired paths are pruned — this is not a directory wipe).
    assert.ok(existsSync(join(tempDir, ".opencode/plugin/entry-gate.ts")));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("re-vendoring removes the retired harvest guard closure and preserves plugin siblings", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vendor-oc-retired-harvest-"));
  const retired = ["plugin/harvest-guard.ts", "plugin/lib/harvest-findings.mjs"];
  const sibling = join(tempDir, ".opencode/plugin/project-owned-harvest-sibling.ts");
  try {
    for (const relativePath of retired) {
      const stale = join(tempDir, ".opencode", relativePath);
      mkdirSync(dirname(stale), { recursive: true });
      writeFileSync(stale, "// stale harvest ceremony\n", "utf8");
    }
    writeFileSync(sibling, "export const projectOwned = true;\n", "utf8");

    const result = spawnSync(
      "node",
      [vendorCoreScript, "--source", harnessRoot, "--target", tempDir, "--runtime", "opencode"],
      { encoding: "utf8", stdio: "pipe" },
    );
    assert.equal(result.status, 0, `vendor failed: ${result.stderr || result.stdout}`);

    for (const relativePath of retired) {
      assert.equal(existsSync(join(tempDir, ".opencode", relativePath)), false, `retired path remains: ${relativePath}`);
      assert.ok(OC_RETIRED_FILES.includes(relativePath), `retired path must be declared: ${relativePath}`);
    }
    assert.equal(existsSync(sibling), true, "exact-path pruning must preserve project-owned siblings");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("re-vendoring removes the retired catalog-health helper and preserves lib siblings", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vendor-oc-retired-catalog-health-"));
  const retired = "plugin/lib/agent-catalog-health.mjs";
  const stale = join(tempDir, ".opencode", retired);
  const sibling = join(tempDir, ".opencode/plugin/lib/project-owned-catalog-sibling.mjs");
  try {
    mkdirSync(dirname(stale), { recursive: true });
    writeFileSync(stale, "// stale catalog-health advisory\n", "utf8");
    writeFileSync(sibling, "export const projectOwned = true;\n", "utf8");

    const result = spawnSync(
      "node",
      [vendorCoreScript, "--source", harnessRoot, "--target", tempDir, "--runtime", "opencode"],
      { encoding: "utf8", stdio: "pipe" },
    );
    assert.equal(result.status, 0, `vendor failed: ${result.stderr || result.stdout}`);
    assert.equal(existsSync(stale), false, "retired catalog-health helper remains vendored");
    assert.ok(OC_RETIRED_FILES.includes(retired), "retired catalog-health helper must be declared");
    assert.equal(existsSync(sibling), true, "exact-path pruning must preserve project-owned lib siblings");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("re-vendoring removes ceremony sidecar helpers and preserves lib siblings", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vendor-oc-retired-ceremony-sidecars-"));
  const retired = [
    "plugin/lib/ceremony-binding.mjs",
    "plugin/lib/ceremony-transition.mjs",
  ];
  const sibling = join(tempDir, ".opencode/plugin/lib/project-owned-ceremony-facts.mjs");
  try {
    for (const relativePath of retired) {
      const stale = join(tempDir, ".opencode", relativePath);
      mkdirSync(dirname(stale), { recursive: true });
      writeFileSync(stale, "// stale ceremony sidecar helper\n", "utf8");
    }
    writeFileSync(sibling, "export const projectOwned = true;\n", "utf8");

    const result = spawnSync(
      "node",
      [vendorCoreScript, "--source", harnessRoot, "--target", tempDir, "--runtime", "opencode"],
      { encoding: "utf8", stdio: "pipe" },
    );
    assert.equal(result.status, 0, `vendor failed: ${result.stderr || result.stdout}`);
    for (const relativePath of retired) {
      assert.equal(existsSync(join(tempDir, ".opencode", relativePath)), false, `retired path remains: ${relativePath}`);
      assert.ok(OC_RETIRED_FILES.includes(relativePath), `retired path must be declared: ${relativePath}`);
    }
    assert.equal(existsSync(sibling), true, "exact-path pruning must preserve project-owned lib siblings");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("re-vendoring moves the factual runtime closure into framework-owned lib, sweeps only old paths, and preserves a project sibling", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vendor-oc-closure-10-"));
  const closure = [
    "gate-state.mjs",
    "entry-decide.mjs",
    "dispatch-scope.mjs",
    "hand-records.mjs",
    "obs-emit.mjs",
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

test("re-vendoring prunes the retired planner fallback module and agent without touching siblings", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vendor-oc-retired-planner-fallback-"));
  const retired = ["lib/planner-fallback-config.mjs", "agents/planner-fallback.md"];
  const siblings = [
    join(tempDir, ".opencode", "lib", "project-owned-planner-sibling.mjs"),
    join(tempDir, ".opencode", "agents", "project-owned-planner-sibling.md"),
  ];
  try {
    for (const relativePath of retired) {
      const stale = join(tempDir, ".opencode", relativePath);
      mkdirSync(dirname(stale), { recursive: true });
      writeFileSync(stale, "// stale planner fallback\n", "utf8");
    }
    for (const sibling of siblings) {
      mkdirSync(dirname(sibling), { recursive: true });
      writeFileSync(sibling, "project-owned\n", "utf8");
    }
    const result = spawnSync(
      "node",
      [vendorCoreScript, "--source", harnessRoot, "--target", tempDir, "--runtime", "opencode"],
      { encoding: "utf8", stdio: "pipe" },
    );
    assert.equal(result.status, 0, `vendor failed: ${result.stderr || result.stdout}`);
    for (const relativePath of retired) {
      assert.equal(existsSync(join(tempDir, ".opencode", relativePath)), false, `retired path remains: ${relativePath}`);
      assert.ok(OC_RETIRED_FILES.includes(relativePath), `retired path must be declared: ${relativePath}`);
    }
    for (const sibling of siblings) assert.equal(existsSync(sibling), true, `sibling must survive: ${sibling}`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("re-vendoring removes every retired second-eye path and preserves per-directory siblings", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vendor-oc-retired-second-eye-"));
  const retired = [
    "plugin/lib/second-eye-authority.mjs",
    "plugin/lib/second-eye-authority.test.mjs",
    "plugin/second-eye-coordinator.ts",
    "plugin/second-eye-coordinator.test.mjs",
    "skills/orchestrating-delivery/second-eye-runtime.mjs",
    "skills/orchestrating-delivery/second-eye-runtime.test.mjs",
    "plugin/lib/loop-decide.mjs",
    "plugin/lib/plan-and-loop-decide.test.mjs",
    "plugin/review-guard.ts",
    "plugin/lib/review-accounting.test.mjs",
    "plugin/lib/adversary-nudge.mjs",
    "plugin/lib/adversary-nudge.test.mjs",
    "plugin/lib/revise-nudge.mjs",
    "plugin/lib/revise-nudge.test.mjs",
    "plugin/lib/review-restart.mjs",
    "skills/orchestrating-delivery/skill-plan-review-budget.test.mjs",
    "skills/orchestrating-delivery/skill-primary-failure-cap.test.mjs",
    "shared/lib/agent-retry.mjs",
    "shared/lib/agent-retry.test.mjs",
    "shared/lib/agent-retry-call.mjs",
    "shared/lib/agent-retry-call.test.mjs",
    "plugin/ceremony-coordinator.ts",
    "plugin/ceremony-coordinator.test.mjs",
    "skills/orchestrating-delivery/ceremony-runtime.mjs",
    "skills/orchestrating-delivery/ceremony-runtime.test.mjs",
  ];
  try {
    const siblings = [
      join(tempDir, ".opencode", "plugin", "lib", "project-owned-second-eye-sibling.mjs"),
      join(tempDir, ".opencode", "plugin", "project-owned-second-eye-sibling.ts"),
      join(
        tempDir,
        ".opencode",
        "skills",
        "orchestrating-delivery",
        "project-owned-second-eye-sibling.mjs",
      ),
    ];
    for (const sibling of siblings) {
      mkdirSync(dirname(sibling), { recursive: true });
      writeFileSync(sibling, "export const projectOwned = true;\n", "utf8");
    }
    for (const rel of retired) {
      const stale = join(tempDir, ".opencode", rel);
      mkdirSync(dirname(stale), { recursive: true });
      writeFileSync(stale, "// stale second-eye runtime\n", "utf8");
    }

    const result = spawnSync(
      "node",
      [vendorCoreScript, "--source", harnessRoot, "--target", tempDir, "--runtime", "opencode"],
      { encoding: "utf8", stdio: "pipe" },
    );
    assert.equal(result.status, 0, `vendor failed: ${result.stderr || result.stdout}`);

    for (const rel of retired) {
      assert.ok(!existsSync(join(tempDir, ".opencode", rel)), `retired second-eye path must be swept: ${rel}`);
      assert.ok(OC_RETIRED_FILES.includes(rel), `retired path must be declared: ${rel}`);
    }
    for (const sibling of siblings) {
      assert.ok(existsSync(sibling), "exact-path sweep must preserve a project-owned second-eye sibling");
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("re-vendoring removes retired review-engine paths and preserves per-directory siblings", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vendor-oc-retired-review-engine-"));
  const retired = [
    "plugin/lib/loop-decide.mjs",
    "plugin/lib/plan-and-loop-decide.test.mjs",
    "plugin/review-guard.ts",
    "plugin/lib/review-accounting.test.mjs",
    "plugin/lib/adversary-nudge.mjs",
    "plugin/lib/adversary-nudge.test.mjs",
    "plugin/lib/revise-nudge.mjs",
    "plugin/lib/revise-nudge.test.mjs",
    "plugin/lib/review-restart.mjs",
    "skills/orchestrating-delivery/skill-plan-review-budget.test.mjs",
    "skills/orchestrating-delivery/skill-primary-failure-cap.test.mjs",
  ];
  const siblings = [
    join(tempDir, ".opencode", "plugin", "project-owned-review-sibling.ts"),
    join(tempDir, ".opencode", "plugin", "lib", "project-owned-review-sibling.mjs"),
    join(tempDir, ".opencode", "skills", "orchestrating-delivery", "project-owned-review-sibling.mjs"),
    join(tempDir, ".opencode", "shared", "lib", "project-owned-sibling.mjs"),
  ];
  try {
    for (const sibling of siblings) {
      mkdirSync(dirname(sibling), { recursive: true });
      writeFileSync(sibling, "export const projectOwned = true;\n", "utf8");
    }
    for (const relativePath of retired) {
      const stale = join(tempDir, ".opencode", relativePath);
      mkdirSync(dirname(stale), { recursive: true });
      writeFileSync(stale, "// stale OC-only review engine\n", "utf8");
    }
    const result = spawnSync(
      "node",
      [vendorCoreScript, "--source", harnessRoot, "--target", tempDir, "--runtime", "opencode"],
      { encoding: "utf8", stdio: "pipe" },
    );
    assert.equal(result.status, 0, `vendor failed: ${result.stderr || result.stdout}`);
    for (const relativePath of retired) {
      assert.equal(existsSync(join(tempDir, ".opencode", relativePath)), false, `retired path remains: ${relativePath}`);
      assert.ok(OC_RETIRED_FILES.includes(relativePath), `retired path must be declared: ${relativePath}`);
    }
    for (const sibling of siblings) assert.equal(existsSync(sibling), true, `sibling must survive: ${sibling}`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("re-vendoring removes retired ceremony paths and preserves per-directory siblings", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vendor-oc-retired-ceremony-"));
  const retired = [
    "plugin/ceremony-coordinator.ts",
    "plugin/ceremony-coordinator.test.mjs",
    "skills/orchestrating-delivery/ceremony-runtime.mjs",
    "skills/orchestrating-delivery/ceremony-runtime.test.mjs",
  ];
  const siblings = [
    join(tempDir, ".opencode", "plugin", "project-owned-ceremony-sibling.ts"),
    join(tempDir, ".opencode", "skills", "orchestrating-delivery", "project-owned-ceremony-sibling.mjs"),
  ];
  try {
    for (const sibling of siblings) {
      mkdirSync(dirname(sibling), { recursive: true });
      writeFileSync(sibling, "export const projectOwned = true;\n", "utf8");
    }
    for (const relativePath of retired) {
      const stale = join(tempDir, ".opencode", relativePath);
      mkdirSync(dirname(stale), { recursive: true });
      writeFileSync(stale, "// stale ceremony API\n", "utf8");
    }
    const result = spawnSync(
      "node",
      [vendorCoreScript, "--source", harnessRoot, "--target", tempDir, "--runtime", "opencode"],
      { encoding: "utf8", stdio: "pipe" },
    );
    assert.equal(result.status, 0, `vendor failed: ${result.stderr || result.stdout}`);
    for (const relativePath of retired) {
      assert.equal(existsSync(join(tempDir, ".opencode", relativePath)), false, `retired path remains: ${relativePath}`);
      assert.ok(OC_RETIRED_FILES.includes(relativePath), `retired path must be declared: ${relativePath}`);
    }
    for (const sibling of siblings) assert.equal(existsSync(sibling), true, `sibling must survive: ${sibling}`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("re-vendoring removes the retired scope composition module and preserves its lib sibling", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vendor-oc-retired-scope-composition-"));
  const retired = "plugin/lib/scope-runtime-composition.mjs";
  const sibling = join(tempDir, ".opencode", "plugin", "lib", "project-owned-scope-sibling.mjs");
  try {
    const stale = join(tempDir, ".opencode", retired);
    mkdirSync(dirname(stale), { recursive: true });
    writeFileSync(stale, "// stale composition registry\n", "utf8");
    writeFileSync(sibling, "export const projectOwned = true;\n", "utf8");
    const result = spawnSync("node", [vendorCoreScript, "--source", harnessRoot, "--target", tempDir, "--runtime", "opencode"], { encoding: "utf8", stdio: "pipe" });
    assert.equal(result.status, 0, `vendor failed: ${result.stderr || result.stdout}`);
    assert.equal(existsSync(stale), false);
    assert.equal(existsSync(sibling), true);
    assert.ok(OC_RETIRED_FILES.includes(retired));
  } finally { rmSync(tempDir, { recursive: true, force: true }); }
});

test("re-vendoring sweeps retired local state artifacts and preserves siblings", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vendor-oc-cleanup-sweep-"));
  const stateDir = join(tempDir, ".opencode", "plans", ".state", "ses-local");
  const sentinel = join(stateDir, "active-dispatch-cleanup-pending.json");
  const sibling = join(stateDir, "keep.json");
  const receipt = join(stateDir, "ceremony", "spec-adversary-primary.json");
  const ceremonySibling = join(stateDir, "ceremony", "keep.json");
  try {
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(dirname(receipt), { recursive: true });
    writeFileSync(sentinel, "{}");
    writeFileSync(sibling, "{}");
    writeFileSync(receipt, '{"result":"legacy"}');
    writeFileSync(ceremonySibling, "{}");
    const result = spawnSync("node", [vendorCoreScript, "--source", harnessRoot, "--target", tempDir, "--runtime", "opencode"], { encoding: "utf8", stdio: "pipe" });
    assert.equal(result.status, 0, `vendor failed: ${result.stderr || result.stdout}`);
    assert.equal(existsSync(sentinel), false);
    assert.equal(existsSync(receipt), false);
    assert.equal(existsSync(sibling), true);
    assert.equal(existsSync(ceremonySibling), true);
  } finally { rmSync(tempDir, { recursive: true, force: true }); }
});

test("re-vendoring sweeps retired orphan paths and preserves lib/plugin siblings", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vendor-oc-retired-orphans-"));
  const retired = ["plugin/lib/bound-plan.mjs", "plugin/lib/bound-plan.test.mjs", "plugin/lib/obs-test-isolation.mjs", "plugin/lib/obs-test-isolation.test.mjs", "plugin/eyes-permission-lockdown.test.mjs", "skills/orchestrating-delivery/skill-regate-stop-predicate.test.mjs", "skills/orchestrating-delivery/skill-regate-stagnation-ceiling.test.mjs", "skills/orchestrating-delivery/skill-regate-deadlock-escape.test.mjs"];
  const siblings = [join(tempDir, ".opencode", "plugin", "lib", "project-owned-lib.mjs"), join(tempDir, ".opencode", "plugin", "project-owned-plugin.ts"), join(tempDir, ".opencode", "skills", "orchestrating-delivery", "project-owned-skill.md")];
  try {
    for (const file of [...retired.map((rel) => join(tempDir, ".opencode", rel)), ...siblings]) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, "// stale or project sibling\n"); }
    const result = spawnSync("node", [vendorCoreScript, "--source", harnessRoot, "--target", tempDir, "--runtime", "opencode"], { encoding: "utf8", stdio: "pipe" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    for (const rel of retired) { assert.equal(existsSync(join(tempDir, ".opencode", rel)), false); assert.ok(OC_RETIRED_FILES.includes(rel)); }
    for (const sibling of siblings) assert.equal(existsSync(sibling), true);
  } finally { rmSync(tempDir, { recursive: true, force: true }); }
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
    "plugin/lib/mark-gate.mjs",
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
    "lib/plan-hash.mjs",
    "plugin/lib/planner-fallback-config.mjs",
    "lib/planner-fallback-config.mjs",
    "agents/planner-fallback.md",
    "plugin/lib/roles.mjs",
    "plugin/lib/task-dispatch-identity.mjs",
    "plugin/lib/second-eye-authority.mjs",
    "plugin/lib/second-eye-authority.test.mjs",
    "plugin/second-eye-coordinator.ts",
    "plugin/second-eye-coordinator.test.mjs",
    "skills/orchestrating-delivery/second-eye-runtime.mjs",
    "skills/orchestrating-delivery/second-eye-runtime.test.mjs",
    "plugin/lib/loop-decide.mjs",
    "plugin/lib/plan-and-loop-decide.test.mjs",
    "plugin/review-guard.ts",
    "plugin/lib/review-accounting.test.mjs",
    "plugin/lib/adversary-nudge.mjs",
    "plugin/lib/adversary-nudge.test.mjs",
    "plugin/lib/revise-nudge.mjs",
    "plugin/lib/revise-nudge.test.mjs",
    "plugin/lib/review-restart.mjs",
    "skills/orchestrating-delivery/skill-plan-review-budget.test.mjs",
    "skills/orchestrating-delivery/skill-primary-failure-cap.test.mjs",
    "shared/lib/agent-retry.mjs",
    "shared/lib/agent-retry.test.mjs",
    "shared/lib/agent-retry-call.mjs",
    "shared/lib/agent-retry-call.test.mjs",
    "plugin/lib/bound-plan.mjs",
    "plugin/lib/bound-plan.test.mjs",
    "plugin/lib/obs-test-isolation.mjs",
    "plugin/lib/obs-test-isolation.test.mjs",
    "plugin/eyes-permission-lockdown.test.mjs",
    "skills/orchestrating-delivery/skill-regate-stop-predicate.test.mjs",
    "skills/orchestrating-delivery/skill-regate-stagnation-ceiling.test.mjs",
    "skills/orchestrating-delivery/skill-regate-deadlock-escape.test.mjs",
    "plugin/lib/ceremony-binding.mjs",
    "plugin/lib/ceremony-transition.mjs",
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

});

test("retired review-engine files are pruned from a fresh vendor", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vendor-oc-predeclared-retired-"));
  try {
    const result = spawnSync(
      "node",
      [vendorCoreScript, "--source", harnessRoot, "--target", tempDir, "--runtime", "opencode"],
      { encoding: "utf8", stdio: "pipe" },
    );
    assert.equal(result.status, 0, `vendor failed: ${result.stderr || result.stdout}`);
    assert.ok(!existsSync(join(tempDir, ".opencode/plugin/loop-guard.ts")));
    assert.ok(!existsSync(join(tempDir, ".opencode/plugin/lib/dual-merge.mjs")));
    assert.ok(!existsSync(join(tempDir, ".opencode/plugin/review-guard.ts")));
    assert.ok(!existsSync(join(tempDir, ".opencode/plugin/lib/adversary-nudge.mjs")));
    assert.ok(!existsSync(join(tempDir, ".opencode/plugin/lib/revise-nudge.mjs")));
    assert.ok(!existsSync(join(tempDir, ".opencode/plugin/lib/marker-seal.mjs")));
    assert.ok(!existsSync(join(tempDir, ".opencode/plugin/lib/mark-gate.mjs")));
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
    const planGate = readFileSync(join(tempDir, ".opencode/plugin/plan-gate.ts"), "utf8");
    assert.match(planGate, /import\("\.\.\/lib\/task-dispatch-identity\.mjs"\)/);
    assert.ok(!planGate.includes("/Users/"), "vendored plan gate imports must be relative, not home paths");
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
    const physicalTempDir = realpathSync(tempDir);
    assert.equal(resolveProjectTarget(undefined, tempDir), physicalTempDir);
    assert.equal(resolveProjectTarget(tempDir, "/unused"), physicalTempDir);
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

test("harnessOcPluginFiles lists observability carriers but not the retired autonomy controller", () => {
  const files = harnessOcPluginFiles();
  assert.ok(files.includes("./.opencode/plugin/obs-eye.ts"));
  assert.ok(files.includes("./.opencode/plugin/agent-idle-nudge.ts"));
  assert.equal(files.includes("./.opencode/plugin/autonomy-controller.ts"), false);
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

/** @description Collapse single-element pretty arrays onto one line (Biome/Prettier short-array style). */
function biomeInlineShortArrays(prettyJson) {
  return prettyJson.replace(/\[\n\s*("[^"\n]*")\n\s*\]/g, "[$1]");
}

test("writeOpencodeConfig (issue #441 ac-1.1/ac-1.2): clean plugin[] is byte-identical no-op with status unchanged", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vendor-oc-441-noop-"));
  try {
    const oc = join(harnessRoot, "core/opencode");
    assert.equal(writeOpencodeConfig(oc, tempDir, "v0.50.0"), "created");

    const dest = join(tempDir, "opencode.json");
    const before = readFileSync(dest, "utf8");
    const status = writeOpencodeConfig(oc, tempDir, "v0.50.0");

    assert.equal(status, "unchanged", "ac-1.2: no-op must return a distinct unchanged status");
    assert.equal(readFileSync(dest, "utf8"), before, "ac-1.1: file must stay byte-identical");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("writeOpencodeConfig (issue #441 ac-1.3): Biome-style inline arrays survive a no-op re-sync", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vendor-oc-441-biome-"));
  try {
    const oc = join(harnessRoot, "core/opencode");
    assert.equal(writeOpencodeConfig(oc, tempDir, "v0.50.0"), "created");

    const dest = join(tempDir, "opencode.json");
    const obj = JSON.parse(readFileSync(dest, "utf8"));
    // Guarantee a short array the formatter would keep inline, even if the example drops it later.
    obj.instructions = ["AGENTS.md"];
    const biomeFormatted = `${biomeInlineShortArrays(JSON.stringify(obj, null, 2))}\n`;
    assert.match(biomeFormatted, /"instructions": \["AGENTS.md"\]/, "fixture must carry an inline array");
    writeFileSync(dest, biomeFormatted);

    const before = readFileSync(dest, "utf8");
    const status = writeOpencodeConfig(oc, tempDir, "v0.50.0");

    assert.equal(status, "unchanged");
    assert.equal(readFileSync(dest, "utf8"), before, "ac-1.3: project formatting must not be destroyed");
    assert.match(before, /"instructions": \["AGENTS.md"\]/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("writeOpencodeConfig (issue #441 ac-1.4): still strips harness autoload plugin paths on real mutation", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vendor-oc-441-strip-"));
  try {
    const oc = join(harnessRoot, "core/opencode");
    writeFileSync(
      join(tempDir, "opencode.json"),
      `${JSON.stringify(
        {
          model: "project/model",
          instructions: ["AGENTS.md"],
          plugin: [
            "project-plugin",
            "./local/plugin.ts",
            "./.opencode/plugin/entry-gate.ts",
            ".opencode/plugin/planner-recovery.ts",
          ],
        },
        null,
        2,
      )}\n`,
    );

    const before = readFileSync(join(tempDir, "opencode.json"), "utf8");
    const status = writeOpencodeConfig(oc, tempDir, "v0.50.0");

    assert.match(status, /updated existing/, "ac-1.4: real plugin strip must still report update");
    assert.notEqual(status, "unchanged");
    const after = readFileSync(join(tempDir, "opencode.json"), "utf8");
    assert.notEqual(after, before, "ac-1.4: file must be rewritten when autoload paths remain");
    const config = JSON.parse(after);
    assert.deepEqual(config.plugin, ["project-plugin", "./local/plugin.ts"]);
    assert.equal(config.plugin.some((p) => String(p).includes(".opencode/plugin/")), false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("writeOpencodeConfig preserves Biome-formatted project fields when a real harness plugin migration changes the config", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "vendor-oc-preserve-project-format-"));
  try {
    const oc = join(harnessRoot, "core/opencode");
    assert.equal(writeOpencodeConfig(oc, tempDir, "v0.50.0"), "created");

    const dest = join(tempDir, "opencode.json");
    const config = JSON.parse(readFileSync(dest, "utf8"));
    config.instructions = ["AGENTS.md"];
    config.plugin = ["./.opencode/plugin/entry-gate.ts"];
    writeFileSync(dest, `${biomeInlineShortArrays(JSON.stringify(config, null, 2))}\n`);

    const status = writeOpencodeConfig(oc, tempDir, "v0.50.0");
    const after = readFileSync(dest, "utf8");

    assert.match(status, /updated existing/);
    assert.match(
      after,
      /"instructions": \["AGENTS.md"\]/,
      "an unrelated project field must retain the formatter's inline-array layout",
    );
    assert.deepEqual(JSON.parse(after).plugin, []);
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
    legacyConfig.instructions = ["AGENTS.md"];
    legacyConfig.project_note = 'the words "permission" and "plugin" here are project data';
    writeFileSync(
      join(tempDir, "opencode.json"),
      `${biomeInlineShortArrays(JSON.stringify(legacyConfig, null, 2))}\n`,
    );

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
    const migratedRaw = readFileSync(join(tempDir, "opencode.json"), "utf8");
    assert.match(migratedRaw, /"instructions": \["AGENTS.md"\]/, "a permission migration must not reformat an unrelated project array");
    assert.match(
      migratedRaw,
      /"project_note": "the words \\"permission\\" and \\"plugin\\" here are project data"/,
      "quoted harness field names inside project data must not confuse the top-level replacement",
    );

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
