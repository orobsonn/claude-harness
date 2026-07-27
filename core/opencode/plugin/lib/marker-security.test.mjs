/** @description Separate-process regressions for private marker authority and byte-neutral observability. */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateCeremonyBinding } from "./ceremony-binding.mjs";
import { sealedMarkerRecord } from "./marker-seal.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const markerPath = path.join(here, "mark-gate.mjs");
const removedIssuerPath = path.join(here, "marker-capability.mjs");
const removedNativePath = path.join(here, "..", "..", "tools", "lib", "mark-native.mjs");
const authorityPath = path.join(here, "..", "marker-authority.ts");

test("ceremony marker for another session or feature is rejected", () => {
  const record = sealedMarkerRecord({
    sessionId: "ses-a",
    featureId: "feature-a",
    operation: "brainstormed",
    payload: true,
  });
  const base = {
    session_id: "ses-a",
    feature_id: "feature-a",
    brainstormed: true,
    marker_seals: [record],
    brainstormed_binding: { session_id: "ses-a", feature_id: "feature-a", operation: "brainstormed", seal: record.seal },
  };
  assert.equal(validateCeremonyBinding(base, { sessionId: "ses-a", featureId: "feature-a", required: ["brainstormed"] }).ok, true);
  assert.match(validateCeremonyBinding(base, { sessionId: "ses-b", featureId: "feature-a", required: ["brainstormed"] }).reason, /session/);
  const foreign = { ...base, brainstormed_binding: { ...base.brainstormed_binding, feature_id: "feature-b" } };
  assert.match(validateCeremonyBinding(foreign, { sessionId: "ses-a", featureId: "feature-a", required: ["brainstormed"] }).reason, /not bound/);
});

test("separate shell cannot import an issuer or privileged mutator and state stays byte-identical", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marker-import-"));
  try {
    const statePath = path.join(root, ".opencode", "plans", ".state", "ses-a", "gate-state.json");
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const bytes = '{\n  "session_id": "ses-a",\n  "feature_id": "feature-a",\n  "classified": true\n}\n';
    fs.writeFileSync(statePath, bytes);
    const script = `
      const paths = ${JSON.stringify([pathToFileURL(removedIssuerPath).href, pathToFileURL(removedNativePath).href])};
      for (const p of paths) {
        try { await import(p); process.exit(20); }
        catch (error) { if (error?.code !== "ERR_MODULE_NOT_FOUND") process.exit(21); }
      }
      const marker = await import(${JSON.stringify(pathToFileURL(markerPath).href)});
      if (typeof marker.withMarkerCapability === "function" || typeof marker.stampBrainstormed === "function") process.exit(22);
    `;
    const attempted = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
    assert.equal(attempted.status, 0, attempted.stderr || attempted.stdout);
    assert.equal(fs.readFileSync(statePath, "utf8"), bytes);

    const privileged = spawnSync(process.execPath, [markerPath, "brainstormed", "--root", root, "--session", "ses-a", "--feature", "feature-a"], { encoding: "utf8" });
    assert.notEqual(privileged.status, 0);
    assert.equal(fs.readFileSync(statePath, "utf8"), bytes);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("observability-only CLI leaves privileged state byte and semantically unchanged", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marker-observe-"));
  try {
    const statePath = path.join(root, ".opencode", "plans", ".state", "ses-a", "gate-state.json");
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const bytes = '{\n  "session_id": "ses-a",\n  "feature_id": "feature-a"\n}\n';
    fs.writeFileSync(statePath, bytes);
    const result = spawnSync(process.execPath, [markerPath, "final-review-done"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, HARNESS_OBSERVABILITY_RUN_PATH: "" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(statePath, "utf8"), bytes);
    assert.deepEqual(JSON.parse(fs.readFileSync(statePath, "utf8")), JSON.parse(bytes));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// #475: the bash-decide.mjs regex layer that used to deny `node <marker-authority.ts>` /
// import one-liners is gone (decideBashForge removed). The real boundary was always host-side:
// marker-authority.ts's `mark.execute()` only accepts args that went through the args-identity
// WeakMap populated by its own `tool.execute.before` closure, which only the OpenCode host can
// invoke (`tool`/`tool.schema` are ambient globals the host provides — a bare `node`/import
// subprocess never has them, so it can only load declarations, never run the privileged path).
// This test asserts that invariant directly: importing marker-authority.ts standalone is inert
// and never mutates gate-state, independent of any bash-layer pattern-match.
test("importing marker-authority.ts standalone is inert and never mutates gate-state (#475)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "marker-authority-import-"));
  try {
    const statePath = path.join(root, ".opencode", "plans", ".state", "ses-a", "gate-state.json");
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const bytes = '{\n  "session_id": "ses-a",\n  "feature_id": "feature-a"\n}\n';
    fs.writeFileSync(statePath, bytes);
    for (const script of [
      `try { await import(${JSON.stringify(pathToFileURL(authorityPath).href)}); } catch { /* .ts import support varies by Node build — either outcome is fine, nothing must be written */ }`,
    ]) {
      const attempted = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
      assert.equal(attempted.signal, null, "must not crash the process");
    }
    assert.equal(
      fs.readFileSync(statePath, "utf8"),
      bytes,
      "importing marker-authority.ts standalone must never mutate gate-state",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
