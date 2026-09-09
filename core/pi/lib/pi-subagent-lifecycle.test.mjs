import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as overlay from "./pi-auth-path-patch.mjs";

const NATIVE = fileURLToPath(new URL("../../../node_modules/@gotgenes/pi-subagents/", import.meta.url));
const MODULES = fileURLToPath(new URL("../../../node_modules/", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./fixtures/pi-subagent-lifecycle.fixture.mjs", import.meta.url));

test("lifecycle overlay is idempotent and refuses unexpected versions, original bytes and altered patched bytes", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-lifecycle-integrity-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const apply = overlay.applyPiSubagentsLifecyclePatch;
  assert.equal(typeof apply, "function", "the sealed compatibility overlay must expose the native lifecycle patch");
  for (const change of ["version", "original", "patched", "none"]) {
    const packageRoot = join(root, change);
    cpSync(NATIVE, packageRoot, { recursive: true });
    const manifestPath = join(packageRoot, "package.json");
    const lifecyclePath = join(packageRoot, "src/lifecycle/subagent-session.ts");
    if (change === "version") {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      writeFileSync(manifestPath, JSON.stringify({ ...manifest, version: "21.99.0" }));
    }
    if (change === "original") appendFileSync(lifecyclePath, "\n// unexpected original bytes\n");
    if (change === "patched" || change === "none") {
      apply(manifestPath);
      const once = readFileSync(lifecyclePath, "utf8");
      apply(manifestPath);
      assert.equal(readFileSync(lifecyclePath, "utf8"), once, "repeat application must preserve the verified patch");
    }
    if (change === "patched") appendFileSync(lifecyclePath, "\n// tampered after patch\n");
    if (change !== "none") assert.throws(() => apply(manifestPath), /version|requires|unexpected|altered/i, change);
  }
});

function observe(packageRoot, scenario) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [FIXTURE, packageRoot, scenario], { timeout: 15_000 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(`${scenario}: ${error.message}\n${stderr}`));
      try { resolve(JSON.parse(stdout.trim().split("\n").at(-1))); } catch (error) { reject(error); }
    });
  });
}

test("pinned native child creation failures and early parent abort settle without leaked sessions or child work", { timeout: 70_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-lifecycle-overlay-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packageRoot = join(root, "plugin");
  cpSync(NATIVE, packageRoot, { recursive: true, filter: (path) => path === NATIVE || !path.slice(NATIVE.length).split("/").includes("node_modules") });
  symlinkSync(MODULES, join(packageRoot, "node_modules"), "dir");
  // Before the overlay exists, exercise unchanged native behavior, so RED measures the
  // actual lost cancellation/disposal rather than an absent import or a mock implementation.
  if (typeof overlay.applyPiSubagentsLifecyclePatch === "function") {
    overlay.applyPiSubagentsLifecyclePatch(join(packageRoot, "package.json"));
  }
  const observations = [];
  for (const scenario of ["binder-throw", "bound-throw", "abort-on-created", "abort-in-preflight"]) {
    const result = await observe(packageRoot, scenario);
    observations.push({
      scenario, created: result.counts.created, disposed: result.counts.disposed,
      model: result.counts.childModelCalls, tools: result.counts.childToolUses, settled: result.toolSettled,
    });
    if (scenario === "abort-in-preflight") assert.equal(result.preflightEntered, true);
    if (scenario.startsWith("abort-")) assert.equal(result.parentSignalAborted, true);
  }
  assert.deepEqual(observations, ["binder-throw", "bound-throw", "abort-on-created", "abort-in-preflight"].map((scenario) => ({
    scenario, created: 1, disposed: 1, model: 0, tools: 0, settled: true,
  })));
  const normal = await observe(packageRoot, "ordinary");
  assert.deepEqual({ ...normal.counts, settled: normal.toolSettled, status: normal.toolStatus }, {
    created: 1, bound: 1, completed: 1, disposed: 1, childModelCalls: 2, childToolUses: 1,
    settled: true, status: "completed",
  }, "the shared overlay must preserve ordinary initial child execution");
  assert.deepEqual(normal.boundResources?.extensions, { resolvedPaths: [], errors: [] });
  assert.ok(Array.isArray(normal.boundResources?.skills?.filePaths));
  assert.deepEqual(normal.boundResources?.skills?.diagnostics, []);
});
