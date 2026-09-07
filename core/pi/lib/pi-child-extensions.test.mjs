import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { materializeRuntime } from "../bin/pi-harness.mjs";
import {
  piChildResourceSettings,
  verifyPiChildBoundResources,
} from "./pi-child-extensions.mjs";

const PACKAGE_ROOT = resolve(import.meta.dirname, "../../..");

test("child resources are the deterministic policy, fidelity, scope and package-skill closure", () => {
  assert.deepEqual(piChildResourceSettings(PACKAGE_ROOT), {
    extensions: [
      join(PACKAGE_ROOT, "core/pi/extensions/harness-policy.ts"),
      join(PACKAGE_ROOT, "core/pi/extensions/harness-entry-gate.ts"),
      join(PACKAGE_ROOT, "core/pi/extensions/harness-plan-write-gate.ts"),
    ],
    skills: [
      join(PACKAGE_ROOT, "core/codex/skills"),
      join(PACKAGE_ROOT, "core/pi/skills"),
    ],
  });
});

test("launcher preserves operator extensions and skills while adding its child resources", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-child-settings-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtimeDir = join(root, "runtime");
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(join(runtimeDir, "settings.json"), JSON.stringify({
    defaultProvider: "openai-codex",
    defaultModel: "gpt-5.6-sol",
    extensions: ["/operator/permission.ts"],
    skills: ["/operator/skills"],
    retained: true,
  }));

  materializeRuntime(PACKAGE_ROOT, runtimeDir);

  const settings = JSON.parse(readFileSync(join(runtimeDir, "settings.json"), "utf8"));
  assert.deepEqual(
    { extensions: settings.extensions, skills: settings.skills, retained: settings.retained },
    {
      extensions: ["/operator/permission.ts", ...piChildResourceSettings(PACKAGE_ROOT).extensions],
      skills: ["/operator/skills", ...piChildResourceSettings(PACKAGE_ROOT).skills],
      retained: true,
    },
  );
  const first = readFileSync(join(runtimeDir, "settings.json"), "utf8");
  materializeRuntime(PACKAGE_ROOT, runtimeDir);
  assert.equal(readFileSync(join(runtimeDir, "settings.json"), "utf8"), first);
});

test("package upgrades replace only the exact previously managed child resource paths", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-child-resources-upgrade-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtimeDir = join(root, "runtime");
  mkdirSync(runtimeDir, { recursive: true });
  const settingsPath = join(runtimeDir, "settings.json");
  const custom = "/operator/harness-policy.ts";
  writeFileSync(settingsPath, JSON.stringify({ extensions: [custom], skills: ["/operator/skills"] }));
  materializeRuntime(PACKAGE_ROOT, runtimeDir);
  const nextPackage = join(root, "next-package");
  mkdirSync(join(nextPackage, "core/pi/extensions"), { recursive: true });
  cpSync(join(PACKAGE_ROOT, "core/pi/runtime"), join(nextPackage, "core/pi/runtime"), { recursive: true });
  materializeRuntime(nextPackage, runtimeDir);
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  const required = piChildResourceSettings(nextPackage);
  assert.deepEqual(settings.extensions, [custom, ...required.extensions]);
  assert.deepEqual(settings.skills, ["/operator/skills", ...required.skills]);
  assert.deepEqual(settings.harnessChildResources, { version: 1, ...required });
});

test("invalid operator resource arrays fail before settings are rewritten", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-child-resources-invalid-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [index, invalid] of [
    { extensions: "/operator/permission.ts" },
    { skills: [null] },
    { extensions: [], harnessChildResources: { version: 9, extensions: [], skills: [] } },
  ].entries()) {
    const runtimeDir = join(root, String(index));
    mkdirSync(runtimeDir, { recursive: true });
    const settingsPath = join(runtimeDir, "settings.json");
    const bytes = JSON.stringify(invalid);
    writeFileSync(settingsPath, bytes);
    assert.throws(() => materializeRuntime(PACKAGE_ROOT, runtimeDir), /harness-child-resources/);
    assert.equal(readFileSync(settingsPath, "utf8"), bytes);
  }
});

test("bound verification uses real module identity and fails closed on missing or failed rails", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-child-bound-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const extensions = ["harness-policy.ts", "harness-entry-gate.ts", "harness-plan-write-gate.ts"]
    .map((name) => join(root, "core/pi/extensions", name));
  const skillRoots = [join(root, "core/codex/skills"), join(root, "core/pi/skills")];
  for (const path of extensions) {
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, "export default () => {};\n");
  }
  for (const [index, dir] of skillRoots.entries()) {
    const skill = join(dir, `required-${index}`, "SKILL.md");
    mkdirSync(resolve(skill, ".."), { recursive: true });
    writeFileSync(skill, `---\nname: required-${index}\ndescription: fixture\n---\n`);
  }
  const payload = {
    extensions: {
      resolvedPaths: extensions.map((path) => realpathSync(path)),
      errors: [],
    },
    skills: {
      filePaths: skillRoots.map((dir, index) => realpathSync(join(dir, `required-${index}`, "SKILL.md"))),
      diagnostics: [],
    },
  };

  assert.deepEqual(verifyPiChildBoundResources(root, payload), { ok: true });
  assert.match(verifyPiChildBoundResources(root, {
    ...payload,
    extensions: { ...payload.extensions, resolvedPaths: payload.extensions.resolvedPaths.slice(1) },
  }).reason, /missing.*harness-policy/i);
  assert.match(verifyPiChildBoundResources(root, {
    ...payload,
    extensions: { ...payload.extensions, errors: [{ path: extensions[0], error: "fixture failure" }] },
  }).reason, /failed.*fixture failure/i);
  assert.match(verifyPiChildBoundResources(root, {
    ...payload,
    skills: { ...payload.skills, diagnostics: [{ type: "error", message: "bad skill" }] },
  }).reason, /skill.*bad skill/i);
});
