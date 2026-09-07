import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

test("launcher refreshes child resource allowlists in its private settings", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-child-settings-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtimeDir = join(root, "runtime");
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(join(runtimeDir, "settings.json"), JSON.stringify({
    defaultProvider: "openai-codex",
    defaultModel: "gpt-5.6-sol",
    extensions: ["/stale/unsafe-extension.ts"],
    skills: ["/stale/skill"],
    retained: true,
  }));

  materializeRuntime(PACKAGE_ROOT, runtimeDir);

  const settings = JSON.parse(readFileSync(join(runtimeDir, "settings.json"), "utf8"));
  assert.deepEqual(
    { extensions: settings.extensions, skills: settings.skills, retained: settings.retained },
    { ...piChildResourceSettings(PACKAGE_ROOT), retained: true },
  );
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
