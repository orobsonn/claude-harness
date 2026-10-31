import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { revalidatedTaskFidelity } from "./task-reconciliation.mjs";

test("a no-write inspection retains a proven ancestral oracle after the committed product advances", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ancestral-oracle-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q"); git("config", "user.name", "Harness"); git("config", "user.email", "harness@example.invalid");
  fs.writeFileSync(path.join(root, "oracle.test.js"), "// frozen behavior\n");
  git("add", "oracle.test.js"); git("commit", "-qm", "freeze");
  const freeze = git("rev-parse", "HEAD");
  fs.writeFileSync(path.join(root, "product.js"), "export const imported = true;\n");
  git("add", "product.js"); git("commit", "-qm", "advance product without changing oracle");
  const head = git("rev-parse", "HEAD");
  const hand = { writtenBy: "host-hand-finished", agent: "harness-test-author", featureId: "feature", taskId: "task-2",
    sessionId: "session", producerCallId: "inspect", freezeCommitSha: head, outcome: "DONE",
    touchedPaths: [], scopeViolations: [], frozenViolations: [] };
  const input = { root, head, taskId: "task-2", featureId: "feature", sessionId: "session", authorCallId: "inspect", hand,
    state: { session_id: "session", feature_id: "feature", fidelity_pass: [`feature/task-2@${freeze}`] },
    prior: { ok: true, freezeSha: freeze } };
  assert.equal(revalidatedTaskFidelity(input), true);
  assert.equal(revalidatedTaskFidelity({ ...input, prior: { ok: false, freezeSha: freeze } }), false);
  assert.equal(revalidatedTaskFidelity({ ...input, hand: { ...hand, touchedPaths: ["oracle.test.js"] } }), false);
  assert.equal(revalidatedTaskFidelity({ ...input, state: { ...input.state, fidelity_pass: [] } }), false);
  fs.writeFileSync(path.join(root, "product.js"), "// uncommitted drift\n");
  assert.equal(revalidatedTaskFidelity(input), false);
});
