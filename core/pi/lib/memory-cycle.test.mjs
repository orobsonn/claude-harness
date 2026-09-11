/** @description Finalization accepts only validated Pi review receipts, not native completion alone. */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyHarvest, beginHarvest, checkCurrentMemoryReviews, checkMemoryShipperReady, completeHarvest, classifyMemoryShipmentTransition } from "./memory-cycle.mjs";
import { missingPiReviewRoles } from "./pi-review-evidence.mjs";

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
    phase: "final",
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

function reviewedHarvest(root, head) {
  seed(root, head, { accepted: true, input_digest: currentInput(root).input_digest,
    report_digest: REPORT_DIGEST, report: EMPTY_REPORT });
  const snapshot = beginHarvest(root, SESSION);
  completeHarvest(snapshot, '[HARNESS_HARVEST_RESULT]{"changes":[{"path":"MEMORY.md","before_sha256":null,"append":"Verified after final corrections.\\n","evidence":"final eyes and tests","invalidation":"contract changes"}]}[/HARNESS_HARVEST_RESULT]', "harvester-after-eyes");
  applyHarvest(root, SESSION);
  execFileSync("git", ["add", "MEMORY.md"], { cwd: root });
  execFileSync("git", ["-c", "user.name=Pi Memory", "-c", "user.email=pi-memory@example.test", "commit", "-qm", "docs: harvest reviewed outcome"], { cwd: root });
  const memoryHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  assert.notEqual(memoryHead, head);
  assert.deepEqual(checkMemoryShipperReady(root, SESSION), { head: memoryHead, featureId: FEATURE });
}

test("harvest waits for final eyes; product changes still require current review", (t) => {
  const { root, head } = fixture(t);
  seed(root, head);
  assert.throws(() => beginHarvest(root, SESSION), /review|evidence/i);
  reviewedHarvest(root, head);
  writeFileSync(join(root, "product.txt"), "unreviewed product\n");
  execFileSync("git", ["add", "product.txt"], { cwd: root });
  execFileSync("git", ["-c", "user.name=Pi Memory", "-c", "user.email=pi-memory@example.test", "commit", "-qm", "feat: unreviewed change"], { cwd: root });
  assert.throws(() => checkMemoryShipperReady(root, SESSION), /review|input|harvest/i);
});

test("post-harvest review status survives restart but never supersedes a newer negative", (t) => {
  const { root, head } = fixture(t);
  reviewedHarvest(root, head);
  const args = { projectRoot: root, sessionId: SESSION, featureId: FEATURE, phase: "final", roles: ["harness-adversary", "harness-compliance"] };
  assert.deepEqual(missingPiReviewRoles(args), []);
  const statePath = join(root, ".pi/harness/state", SESSION, "gate-state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  state.final_review_evidence.adversary.accepted = false;
  writeFileSync(statePath, JSON.stringify(state));
  assert.deepEqual(missingPiReviewRoles(args), ["harness-adversary"]);
  assert.throws(() => checkMemoryShipperReady(root, SESSION), /adversary/);
  const moduleUrl = new URL("./pi-review-evidence.mjs", import.meta.url).href;
  const restarted = execFileSync(process.execPath, ["--input-type=module", "-e",
    `import { missingPiReviewRoles } from ${JSON.stringify(moduleUrl)}; process.stdout.write(JSON.stringify(missingPiReviewRoles(${JSON.stringify(args)})));`], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(restarted), ["harness-adversary"]);
  const current = currentInput(root);
  state.final_review_evidence.adversary = receipt("harness-adversary", current.head_sha,
    { accepted: true, input_digest: current.input_digest, report: EMPTY_REPORT, report_digest: REPORT_DIGEST });
  writeFileSync(statePath, JSON.stringify(state));
  assert.deepEqual(missingPiReviewRoles(args), []);
  assert.equal(checkMemoryShipperReady(root, SESSION).head, current.head_sha);
});

test("harvest cannot hide spec or executable-mode drift after an authorized append", async (t) => {
  for (const change of ["spec", "mode"]) await t.test(change, (st) => {
    const { root, head } = fixture(st);
    reviewedHarvest(root, head);
    if (change === "spec") writeFileSync(join(root, ".pi/harness/plans", FEATURE, "spec.md"), "unreviewed contract\n");
    else {
      chmodSync(join(root, "MEMORY.md"), 0o755);
      execFileSync("git", ["add", "MEMORY.md"], { cwd: root });
      execFileSync("git", ["-c", "user.name=Pi Memory", "-c", "user.email=pi-memory@example.test", "commit", "-qm", "docs: unauthorized mode"], { cwd: root });
    }
    assert.throws(() => checkMemoryShipperReady(root, SESSION), /review|input|harvest/);
  });
});

test("harvest never hides unproposed durable files when Git reports clean", async (t) => {
  for (const change of ["no-op-mode", "append-hidden-content", "append-hidden-head"]) await t.test(change, (st) => {
    const { root } = fixture(st);
    for (const file of ["MEMORY.md", "CONTEXT.md"]) writeFileSync(join(root, file), "original durable evidence\n");
    execFileSync("git", ["add", "MEMORY.md", "CONTEXT.md"], { cwd: root });
    const commit = () => execFileSync("git", ["-c", "user.name=Pi Memory", "-c", "user.email=pi-memory@example.test", "commit", "-qm", "docs: memory"], { cwd: root });
    commit();
    const current = currentInput(root);
    seed(root, current.head_sha, { accepted: true, input_digest: current.input_digest, report_digest: REPORT_DIGEST, report: EMPTY_REPORT });
    const changes = change === "no-op-mode" ? [] : [{ path: "MEMORY.md", before_sha256: createHash("sha256").update("original durable evidence\n").digest("hex"), append: "verified addition\n", evidence: "reviewed", invalidation: "contract changes" }];
    completeHarvest(beginHarvest(root, SESSION), `[HARNESS_HARVEST_RESULT]${JSON.stringify({ changes })}[/HARNESS_HARVEST_RESULT]`, "harvester");
    if (changes.length) {
      applyHarvest(root, SESSION);
      execFileSync("git", ["add", "MEMORY.md"], { cwd: root });
      commit();
    }
    assert.ok(checkMemoryShipperReady(root, SESSION));
    if (change === "no-op-mode") {
      execFileSync("git", ["config", "core.fileMode", "false"], { cwd: root });
      chmodSync(join(root, "MEMORY.md"), 0o755);
    } else if (change === "append-hidden-content") {
      execFileSync("git", ["update-index", "--assume-unchanged", "CONTEXT.md"], { cwd: root });
      writeFileSync(join(root, "CONTEXT.md"), "unreviewed durable evidence\n");
    } else {
      const authorized = readFileSync(join(root, "MEMORY.md"), "utf8");
      writeFileSync(join(root, "MEMORY.md"), "unapproved committed content\n");
      execFileSync("git", ["add", "MEMORY.md"], { cwd: root });
      commit();
      execFileSync("git", ["update-index", "--assume-unchanged", "MEMORY.md"], { cwd: root });
      writeFileSync(join(root, "MEMORY.md"), authorized);
    }
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }), "");
    assert.throws(() => checkMemoryShipperReady(root, SESSION), /review|input/);
    assert.deepEqual(missingPiReviewRoles({ projectRoot: root, sessionId: SESSION, featureId: FEATURE, phase: "final",
      roles: ["harness-adversary", "harness-compliance"] }), ["harness-adversary", "harness-compliance"]);
  });
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

test("shipment distingue preparação, merge e publicação da release", () => {
  const reviewed = "a".repeat(40);
  const functionalMerge = "b".repeat(40);
  const releaseHead = "c".repeat(40);
  const releaseMerge = "d".repeat(40);
  const prepared = {
    head: releaseHead,
    release: { ok: true, phase: "pre-merge", version: "1.2.4", branch: "chore/release-1.2.4", baseSha: functionalMerge },
  };
  assert.deepEqual(
    classifyMemoryShipmentTransition(
      { head: reviewed },
      prepared,
      { ok: true, headSha: reviewed, mergeSha: functionalMerge },
    ),
    { ok: true, phase: "release-prepared" },
  );

  const merged = {
    head: releaseMerge,
    release: {
      ok: true,
      phase: "post-merge",
      version: "1.2.4",
      releaseBranch: "chore/release-1.2.4",
      releaseHeadSha: releaseHead,
      baseSha: functionalMerge,
      publication: { ok: false },
    },
  };
  assert.deepEqual(classifyMemoryShipmentTransition({ head: releaseHead, release: prepared.release }, merged), { ok: true, phase: "merged" });
  assert.deepEqual(
    classifyMemoryShipmentTransition(
      { head: releaseMerge, release: merged.release },
      { ...merged, release: { ...merged.release, publication: { ok: true } } },
    ),
    { ok: true, phase: "published" },
  );
  assert.deepEqual(
    classifyMemoryShipmentTransition(
      { head: reviewed },
      { ...merged, release: { ...merged.release, baseSha: functionalMerge, publication: { ok: true } } },
      { ok: true, headSha: reviewed, mergeSha: functionalMerge },
    ),
    { ok: true, phase: "published" },
  );
});

test("shipment rejeita preparo sem squash funcional exato e troca de release", () => {
  const reviewed = "a".repeat(40);
  const prepared = { head: "c".repeat(40), release: { ok: true, phase: "pre-merge", version: "1.2.4", branch: "chore/release-1.2.4", baseSha: "b".repeat(40) } };
  assert.equal(classifyMemoryShipmentTransition({ head: reviewed }, prepared, null).ok, false);
  assert.equal(classifyMemoryShipmentTransition({ head: reviewed }, prepared, { ok: true, headSha: reviewed, mergeSha: "f".repeat(40) }).ok, false);
  assert.equal(classifyMemoryShipmentTransition(
    { head: prepared.head, release: prepared.release },
    { head: "d".repeat(40), release: { ok: true, phase: "post-merge", version: "1.2.5", releaseBranch: prepared.release.branch, releaseHeadSha: prepared.head, baseSha: prepared.release.baseSha } },
  ).ok, false);
});
