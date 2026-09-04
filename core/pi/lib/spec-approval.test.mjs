import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { approvePiSpec, readPiSpecApproval, writePiSpecDraft } from "./spec-approval.mjs";
import { piGateStatePath } from "./pi-paths.mjs";

const SESSION = "spec-session";
const FEATURE = "spec-feature";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-spec-approval-"));
  const statePath = piGateStatePath({ projectRoot: root, sessionId: SESSION });
  fs.mkdirSync(path.dirname(statePath.path), { recursive: true });
  fs.writeFileSync(statePath.path, JSON.stringify({ session_id: SESSION, feature_id: FEATURE, classified: true, mode: "FULL" }));
  return {
    root,
    close: () => fs.rmSync(root, { recursive: true, force: true }),
    state: () => JSON.parse(fs.readFileSync(statePath.path, "utf8")),
    writeState: (state) => fs.writeFileSync(statePath.path, JSON.stringify(state)),
  };
}

test("only the parent can persist a spec draft and its hash invalidates prior ceremony evidence", () => {
  const f = fixture();
  try {
    const child = writePiSpecDraft({ content: "# Spec\n" }, { projectRoot: f.root, sessionId: SESSION, isChild: true });
    assert.equal(child.ok, false);
    assert.match(child.reason, /parent/);

    f.writeState({ ...f.state(), brainstormed: true, adversary_fired: true, reviewed_spec_sha256: "stale" });
    const written = writePiSpecDraft({ content: "# Spec\nA\n" }, { projectRoot: f.root, sessionId: SESSION });
    assert.equal(written.ok, true, written.reason);
    const state = f.state();
    assert.equal(state.spec_status, "draft");
    assert.match(state.spec_sha256, /^[a-f0-9]{64}$/);
    assert.equal(state.brainstormed, undefined);
    assert.equal(state.adversary_fired, undefined);
    assert.equal(state.reviewed_spec_sha256, undefined);
  } finally { f.close(); }
});

test("headless seals the same adversarially reviewed draft without an operator click", async () => {
  const f = fixture();
  try {
    const draft = writePiSpecDraft({ content: "# Spec\nA\n" }, { projectRoot: f.root, sessionId: SESSION });
    f.writeState({ ...f.state(), adversary_fired: true, adversary_spec_sha256: draft.sha256 });
    const result = await approvePiSpec({ projectRoot: f.root, sessionId: SESSION, mode: "rpc" });
    assert.equal(result.ok, true, result.reason);
    assert.equal(f.state().spec_status, "adversary-reviewed");
  } finally { f.close(); }
});

test("a review seal binds exactly the adversarially reviewed spec hash; a later edit makes it unusable", async () => {
  const f = fixture();
  try {
    const draft = writePiSpecDraft({ content: "# Spec\nA\n" }, { projectRoot: f.root, sessionId: SESSION });
    f.writeState({ ...f.state(), adversary_fired: true, adversary_spec_sha256: draft.sha256 });
    const approved = await approvePiSpec({ projectRoot: f.root, sessionId: SESSION, mode: "tui" });
    assert.equal(approved.ok, true, approved.reason);
    assert.equal(readPiSpecApproval({ projectRoot: f.root, sessionId: SESSION, featureId: FEATURE }).ok, true);

    const specPath = path.join(f.root, ".pi", "harness", "plans", FEATURE, "spec.md");
    fs.writeFileSync(specPath, "# Spec\nmutated\n");
    const stale = readPiSpecApproval({ projectRoot: f.root, sessionId: SESSION, featureId: FEATURE });
    assert.equal(stale.ok, false);
    assert.equal(stale.reason, "reviewed spec hash no longer matches canonical spec");
  } finally { f.close(); }
});

test("approval refuses a draft not reviewed by the current adversary hash", async () => {
  const f = fixture();
  try {
    writePiSpecDraft({ content: "# Spec\nA\n" }, { projectRoot: f.root, sessionId: SESSION });
    const result = await approvePiSpec({ projectRoot: f.root, sessionId: SESSION, mode: "tui", confirm: async () => true });
    assert.equal(result.ok, false);
    assert.equal(result.code, "ADVERSARY_REVIEW_REQUIRED");
  } finally { f.close(); }
});
