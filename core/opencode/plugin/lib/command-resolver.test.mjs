/** @description Closed registry, canonical target, package proof, and FD-pinned execution tests. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DENIED_CLASS,
  VITEST_REGISTRY_ID,
  denialFingerprint,
  inheritedFdPath,
  normalizeTestPath,
  openLocalVitest,
  registeredEquivalent,
  runPinnedVitest,
  selectLockedTest,
} from "./command-resolver.mjs";

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "resolver-343-"));
  fs.mkdirSync(path.join(root, "tests"), { recursive: true });
  fs.writeFileSync(path.join(root, "tests", "a.test.ts"), "test");
  const packageDir = path.join(root, "node_modules", "vitest");
  const binDir = path.join(root, "node_modules", ".bin");
  fs.mkdirSync(packageDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name: "vitest", version: "3.2.4", bin: { vitest: "./vitest.mjs" } }));
  fs.writeFileSync(path.join(packageDir, "vitest.mjs"), "process.stdout.write('SAFE:' + JSON.stringify(process.argv.slice(2)))\n");
  fs.symlinkSync("../vitest/vitest.mjs", path.join(binDir, "vitest"));
  return { root, packageDir, binDir, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("registry accepts only exact Vitest equivalents and canonical target", () => {
  for (const command of ["npx vitest run tests/a.test.ts", "npx --no-install vitest run tests/a.test.ts", "npm exec vitest -- run tests/a.test.ts", "pnpm dlx vitest run tests/a.test.ts", "bunx vitest run tests/a.test.ts"]) {
    assert.deepEqual(registeredEquivalent(DENIED_CLASS.PACKAGE_LAUNCHER, command, "tests/a.test.ts"), { registry_id: VITEST_REGISTRY_ID, test_path: "tests/a.test.ts" });
  }
  assert.deepEqual(registeredEquivalent(DENIED_CLASS.INTERPRETER, "node node_modules/vitest/vitest.mjs run tests/a.test.ts", "tests/a.test.ts"), { registry_id: VITEST_REGISTRY_ID, test_path: "tests/a.test.ts" });
  for (const value of ["-x.test.ts", "../a.test.ts", "./tests/a.test.ts", "tests//a.test.ts", "tests/*.test.ts", "tests\\a.test.ts", "tests/a.test.ts --run", "tests/"]) assert.equal(normalizeTestPath(value), null, value);
  assert.equal(registeredEquivalent(DENIED_CLASS.INTERPRETER, "python tests/a.test.ts", "tests/a.test.ts"), null);
});

test("target matches one canonical locked path; duplicate assertions deduplicate and scope fallback rejects", () => {
  const run = project();
  try {
    assert.equal(selectLockedTest({ locked_tests: [{ path: "tests/a.test.ts" }], scope_paths: ["other/**"] }, "tests/a.test.ts", run.root).ok, true);
    assert.equal(selectLockedTest({ locked_tests: [], scope_paths: ["tests/**"] }, "tests/a.test.ts", run.root).ok, false);
    assert.equal(selectLockedTest({ locked_tests: [{ path: "tests/a.test.ts", assertion: "one" }, { path: "tests/a.test.ts", assertion: "two" }] }, "tests/a.test.ts", run.root).ok, true);
    assert.equal(selectLockedTest({ locked_tests: [{ path: "tests/a.test.ts" }, { path: "./tests/a.test.ts" }] }, "tests/a.test.ts", run.root).ok, false);
    fs.mkdirSync(path.join(run.root, "tests", "dir.test.ts"));
    assert.equal(selectLockedTest({ locked_tests: [{ path: "tests/dir.test.ts" }] }, "tests/dir.test.ts", run.root).ok, false);
  } finally { run.cleanup(); }
});

test("known fingerprint includes exact path while no-equivalent remains denied-class-wide", () => {
  const base = { sessionId: "s", featureId: "f", taskId: "t", deniedClass: "package_launcher", registryId: VITEST_REGISTRY_ID, testPath: "tests/a.test.ts" };
  assert.equal(denialFingerprint(base), denialFingerprint({ ...base, command: "different" }));
  assert.notEqual(denialFingerprint(base), denialFingerprint({ ...base, testPath: "tests/b.test.ts" }));
  const none = { sessionId: "s", featureId: "f", taskId: "t", deniedClass: "shell_source", registryId: "", testPath: "tests/a.test.ts" };
  assert.equal(denialFingerprint(none), denialFingerprint({ ...none, command: "source other", testPath: "tests/b.test.ts" }));
});

test("FD execution path is closed to supported POSIX primitives", () => {
  assert.equal(inheritedFdPath("linux"), "/proc/self/fd/3");
  assert.equal(inheritedFdPath("darwin"), "/dev/fd/3");
  assert.equal(inheritedFdPath("win32"), null);
});

test("package proof uses declared package entry and ignores an evil .bin wrapper", () => {
  const run = project();
  try {
    const opened = openLocalVitest(run.root);
    assert.equal(opened.ok, true, opened.reason);
    if (opened.ok) fs.closeSync(opened.fd);
    fs.unlinkSync(path.join(run.binDir, "vitest"));
    fs.writeFileSync(path.join(run.root, "outside.mjs"), "evil");
    fs.symlinkSync(path.join(run.root, "outside.mjs"), path.join(run.binDir, "vitest"));
    const wrapperIgnored = openLocalVitest(run.root);
    assert.equal(wrapperIgnored.ok, true, wrapperIgnored.reason);
    if (wrapperIgnored.ok) fs.closeSync(wrapperIgnored.fd);
  } finally { run.cleanup(); }
});

test("swap between identity stat and open is detected by inode comparison", () => {
  const run = project();
  try {
    const entry = path.join(run.packageDir, "vitest.mjs");
    let swapped = false;
    const io = new Proxy(fs, {
      get(target, property) {
        if (property === "openSync") return (...values) => {
          if (!swapped && values[0] === entry) {
            swapped = true;
            fs.renameSync(entry, `${entry}.safe`);
            fs.writeFileSync(entry, "evil");
          }
          return fs.openSync(...values);
        };
        return target[property];
      },
    });
    assert.equal(openLocalVitest(run.root, io).ok, false);
  } finally { run.cleanup(); }
});

test("missing declared entry and package symlink escape reject", () => {
  const run = project();
  try {
    fs.writeFileSync(path.join(run.packageDir, "package.json"), JSON.stringify({ name: "vitest", version: "3.2.4", bin: { vitest: "./missing.mjs" } }));
    assert.equal(openLocalVitest(run.root).ok, false);
  } finally { run.cleanup(); }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "resolver-escape-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "resolver-package-outside-"));
  try {
    fs.mkdirSync(path.join(root, "node_modules", ".bin"), { recursive: true });
    fs.writeFileSync(path.join(outside, "package.json"), JSON.stringify({ name: "vitest", version: "1.0.0", bin: { vitest: "vitest.mjs" } }));
    fs.writeFileSync(path.join(outside, "vitest.mjs"), "evil");
    fs.symlinkSync(outside, path.join(root, "node_modules", "vitest"));
    fs.symlinkSync(path.join(outside, "vitest.mjs"), path.join(root, "node_modules", ".bin", "vitest"));
    assert.equal(openLocalVitest(root).ok, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
});

test("pnpm-style node_modules/vitest symlink resolves package entry without trusting wrapper", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "resolver-pnpm-"));
  try {
    const packageDir = path.join(root, "node_modules", ".pnpm", "vitest@3.2.4", "node_modules", "vitest");
    fs.mkdirSync(packageDir, { recursive: true });
    fs.mkdirSync(path.join(root, "node_modules", ".bin"), { recursive: true });
    fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name: "vitest", version: "3.2.4", bin: { vitest: "./vitest.mjs" } }));
    fs.writeFileSync(path.join(packageDir, "vitest.mjs"), "process.exit(0)\n");
    fs.symlinkSync(path.relative(path.join(root, "node_modules"), packageDir), path.join(root, "node_modules", "vitest"));
    fs.writeFileSync(path.join(root, "node_modules", ".bin", "vitest"), "evil wrapper");
    const opened = openLocalVitest(root);
    assert.equal(opened.ok, true, opened.reason);
    assert.equal(opened.entry, path.join(packageDir, "vitest.mjs"));
    if (opened.ok) fs.closeSync(opened.fd);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("FD pin executes the opened safe inode after pathname swap", () => {
  const run = project();
  try {
    const entry = path.join(run.packageDir, "vitest.mjs");
    const result = runPinnedVitest(run.root, "tests/a.test.ts", {
      beforeSpawn() {
        fs.renameSync(entry, `${entry}.safe`);
        fs.writeFileSync(entry, "process.stdout.write('EVIL')\n");
      },
    });
    assert.equal(result.status, "passed", result.stderr);
    assert.equal(result.stdout, 'SAFE:["run","tests/a.test.ts"]');
  } finally { run.cleanup(); }
});
