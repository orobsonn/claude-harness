/** @description Finalization accepts only validated Pi review receipts, not native completion alone. */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkCurrentMemoryReviews } from "./memory-cycle.mjs";

let capturePiReviewInput;
try {
  ({ capturePiReviewInput } = await import("./pi-review-evidence.mjs"));
} catch (error) {
  if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
}

const SESSION = "ses-memory-review-evidence";
const FEATURE = "feature-memory-review-evidence";
const EMPTY_REPORT = { issues: [] };
const REPORT_DIGEST = createHash("sha256").update(JSON.stringify(EMPTY_REPORT)).digest("hex");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "pi-memory-review-evidence-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(join(root, ".gitignore"), ".pi/harness/state/\n.pi/harness/plans/\n");
  writeFileSync(join(root, "product.txt"), "reviewed product\n");
  mkdirSync(join(root, ".pi", "harness", "plans", FEATURE), { recursive: true });
  writeFileSync(
    join(root, ".pi", "harness", "plans", FEATURE, "execution-plan.json"),
    JSON.stringify({ feature_id: FEATURE, tasks: [{ id: "task-one", scope_paths: ["product.txt"] }] }, null, 2),
  );
  writeFileSync(join(root, ".pi", "harness", "plans", FEATURE, "spec.md"), "# Reviewed behavior\n");
  execFileSync("git", ["add", ".gitignore", "product.txt"], { cwd: root });
  execFileSync(
    "git",
    ["-c", "user.name=Pi Memory", "-c", "user.email=pi-memory@example.test", "commit", "-q", "-m", "fixture"],
    { cwd: root },
  );
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  mkdirSync(join(root, ".pi", "harness", "state", SESSION), { recursive: true });
  return { root, head };
}

function currentInput(root) {
  assert.equal(typeof capturePiReviewInput, "function", "pi-review-evidence must provide the production snapshot helper");
  const captured = capturePiReviewInput({ projectRoot: root, sessionId: SESSION, featureId: FEATURE, phase: "final" });
  assert.equal(captured?.ok, true, captured?.reason);
  return captured.snapshot;
}

function receipt(role, head, extra = {}) {
  const key = role.replace("harness-", "");
  return {
    written_by: "host-subagent-completion",
    parent_session_id: SESSION,
    feature_id: FEATURE,
    role,
    dispatch_call_id: `call-${key}`,
    child_session_id: `child-${key}`,
    agent_id: `agent-${key}`,
    status: "completed",
    reviewed_head_sha: head,
    ...extra,
  };
}

function seed(root, head, fields = {}) {
  writeFileSync(
    join(root, ".pi", "harness", "state", SESSION, "gate-state.json"),
    JSON.stringify({
      session_id: SESSION,
      feature_id: FEATURE,
      final_review_done: true,
      final_review_evidence: {
        adversary: receipt("harness-adversary", head, fields),
        compliance: receipt("harness-compliance", head, fields),
      },
    }, null, 2),
  );
}

test("checkCurrentMemoryReviews rejects completed current-HEAD receipts without accepted report evidence", (t) => {
  const { root, head } = fixture(t);
  seed(root, head);
  assert.throws(
    () => checkCurrentMemoryReviews(root, SESSION),
    /both host-owned final reviews|accepted|report|evidence/i,
  );
});

test("checkCurrentMemoryReviews accepts both exact current receipts with canonical report digests", (t) => {
  const { root, head } = fixture(t);
  const snapshot = currentInput(root);
  seed(root, head, {
    accepted: true,
    input_digest: snapshot.input_digest,
    report_digest: REPORT_DIGEST,
    report: EMPTY_REPORT,
  });
  assert.deepEqual(checkCurrentMemoryReviews(root, SESSION), { head, featureId: FEATURE });
});

test("finalization preserves the canonical plan's mandatory security review", (t) => {
  const { root, head } = fixture(t);
  const planPath = join(root, ".pi/harness/plans", FEATURE, "execution-plan.json");
  const plan = JSON.parse(readFileSync(planPath, "utf8"));
  writeFileSync(planPath, JSON.stringify({ ...plan, final_review: { compliance: true, adversary: true, security: true } }));
  const fields = { accepted: true, input_digest: currentInput(root).input_digest, report_digest: REPORT_DIGEST, report: EMPTY_REPORT };
  seed(root, head, fields);
  assert.throws(() => checkCurrentMemoryReviews(root, SESSION), /security/i);
  const statePath = join(root, ".pi/harness/state", SESSION, "gate-state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  state.final_review_evidence.security = receipt("harness-security", head, fields);
  writeFileSync(statePath, JSON.stringify(state));
  assert.deepEqual(checkCurrentMemoryReviews(root, SESSION), { head, featureId: FEATURE });
});

test("checkCurrentMemoryReviews rejects ignored canonical plan/spec drift on the same clean HEAD", async (t) => {
  for (const [label, relativePath, content] of [
    ["plan", ["execution-plan.json"], JSON.stringify({ feature_id: FEATURE, tasks: [{ id: "task-one" }, { id: "task-two" }] })],
    ["spec", ["spec.md"], "# Changed reviewed behavior\n"],
  ]) {
    await t.test(label, (st) => {
      const { root, head } = fixture(st);
      const snapshot = currentInput(root);
      seed(root, head, {
        accepted: true,
        input_digest: snapshot.input_digest,
        report_digest: REPORT_DIGEST,
        report: EMPTY_REPORT,
      });
      writeFileSync(join(root, ".pi", "harness", "plans", FEATURE, ...relativePath), content);
      assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), head);
      assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }), "");
      assert.throws(
        () => checkCurrentMemoryReviews(root, SESSION),
        /both host-owned final reviews|current|input|snapshot|evidence/i,
      );
    });
  }
});
