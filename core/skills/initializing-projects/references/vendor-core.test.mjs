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
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isFrameworkCopyIncluded } from "./vendor-core.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve paths relative to the test location
const vendorCoreScript = join(__dirname, "vendor-core.mjs");
const harnessRoot = join(__dirname, "../../../..");

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
