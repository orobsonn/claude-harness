/** @description Finalization accepts only validated Pi review receipts, not native completion alone. */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyHarvest, beginHarvest, checkCurrentMemoryReviews, checkMemoryShipperReady, completeHarvest, classifyMemoryShipmentTransition } from "./memory-cycle.mjs";
import { missingPiReviewRoles } from "./pi-review-evidence.mjs";
import * as memoryCycle from "./memory-cycle.mjs";

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

// Sanitized boundary from #208/#210: after final eyes and harvest, another run
// appended memory and merged product. The PR conflicts only in MEMORY.md.
function parallelDelivery(t, { productConflict = false, memoryConflict = true, beforeFinalReview = false } = {}) {
  const { root } = fixture(t);
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("config", "user.name", "Pi fixture");
  git("config", "user.email", "fixture@example.test");
  writeFileSync(join(root, "MEMORY.md"), "# Verified knowledge\n\nExisting entry.\n");
  git("add", "MEMORY.md"); git("commit", "-qm", "docs: base memory");
  git("branch", "parallel-main");
  writeFileSync(join(root, "MEMORY.md"), "# Verified knowledge\n\nExisting entry.\nLocal learning.\n");
  if (productConflict) writeFileSync(join(root, "product.txt"), "local product\n");
  git("add", "MEMORY.md", "product.txt"); git("commit", "-qm", "docs: local harvest");
  const expected_head = git("rev-parse", "HEAD");
  git("checkout", "-q", "parallel-main");
  if (memoryConflict) writeFileSync(join(root, "MEMORY.md"), "# Verified knowledge\n\nExisting entry.\nUpstream learning.\n");
  writeFileSync(join(root, "product.txt"), "upstream product\n");
  git("add", "MEMORY.md", "product.txt"); git("commit", "-qm", "feat: parallel delivery");
  const base_sha = git("rev-parse", "HEAD");
  git("checkout", "-q", "--detach", expected_head);
  if (beforeFinalReview) {
    writeFileSync(join(root, ".pi/harness/state", SESSION, "gate-state.json"),
      JSON.stringify({ session_id: SESSION, feature_id: FEATURE }));
  } else {
    seed(root, expected_head, { accepted: true, input_digest: currentInput(root).input_digest,
      report_digest: REPORT_DIGEST, report: EMPTY_REPORT });
    completeHarvest(beginHarvest(root, SESSION), '[HARNESS_HARVEST_RESULT]{"changes":[]}[/HARNESS_HARVEST_RESULT]', "native-harvester");
    assert.ok(checkMemoryShipperReady(root, SESSION));
  }
  return { root, git, expected_head, base_sha };
}

test("parallel finalization reconciles memory on the host, preserves receipts and requires current final eyes", (t) => {
  const { root, git, ...input } = parallelDelivery(t);
  assert.equal(typeof memoryCycle.reconcileMemoryDelivery, "function", "global delivery reconciliation is missing");
  const statePath = join(root, ".pi/harness/state", SESSION, "gate-state.json");
  const stateBefore = readFileSync(statePath, "utf8");
  const preview = memoryCycle.reconcileMemoryDelivery(root, SESSION, input);
  assert.equal(preview.applied, false);
  assert.deepEqual(preview.conflicts.map((x) => x.path), ["MEMORY.md"]);
  assert.equal(git("status", "--porcelain"), "");
  const conflict = preview.conflicts[0];
  const block = conflict.content.match(/^<<<<<<<[^\n]*\n[\s\S]*?^>>>>>>>[^\n]*\n/m)?.[0];
  assert.ok(block);
  const resolution = { path: "MEMORY.md", before_sha256: conflict.sha256,
    patch: { old_text: block, new_text: "Local learning.\nUpstream learning.\n" } };
  const merged = memoryCycle.reconcileMemoryDelivery(root, SESSION, { ...input, resolutions: [resolution] });
  assert.equal(merged.applied, true);
  assert.deepEqual(git("rev-list", "--parents", "-1", "HEAD").split(" ").slice(1), [input.expected_head, input.base_sha]);
  assert.equal(git("status", "--porcelain"), "");
  assert.equal(readFileSync(join(root, "MEMORY.md"), "utf8"), "# Verified knowledge\n\nExisting entry.\nLocal learning.\nUpstream learning.\n");
  assert.equal(readFileSync(join(root, "product.txt"), "utf8"), "upstream product\n");
  assert.equal(readFileSync(statePath, "utf8"), stateBefore, "do not forge or rewrite reviews/tasks");
  assert.deepEqual(missingPiReviewRoles({ projectRoot: root, sessionId: SESSION, featureId: FEATURE,
    phase: "final", roles: ["harness-adversary", "harness-compliance"] }), ["harness-adversary", "harness-compliance"]);
  assert.throws(() => beginHarvest(root, SESSION), /review|evidence/i);
  assert.throws(() => checkMemoryShipperReady(root, SESSION), /review|harvest|changed/i);
  seed(root, merged.head, { accepted: true, input_digest: currentInput(root).input_digest,
    report_digest: REPORT_DIGEST, report: EMPTY_REPORT });
  completeHarvest(beginHarvest(root, SESSION), '[HARNESS_HARVEST_RESULT]{"changes":[]}[/HARNESS_HARVEST_RESULT]', "native-harvester-new-base");
  assert.equal(checkMemoryShipperReady(root, SESSION).head, merged.head);
});

for (const memoryConflict of [false, true]) test(`host can reconcile before first final review without manufacturing approval (memory conflict: ${memoryConflict})`, (t) => {
  const { root, git, ...input } = parallelDelivery(t, { memoryConflict, beforeFinalReview: true });
  const statePath = join(root, ".pi/harness/state", SESSION, "gate-state.json");
  const stateBefore = readFileSync(statePath, "utf8");
  assert.equal(memoryCycle.finalizationStarted(root, SESSION), false);
  const preview = memoryCycle.reconcileMemoryDelivery(root, SESSION, input);
  assert.equal(git("rev-parse", "HEAD"), input.expected_head);
  assert.equal(git("status", "--porcelain"), "");
  const resolutions = preview.conflicts.map((entry) => ({ path: entry.path, before_sha256: entry.sha256,
    patch: { old_text: entry.content.match(/^<<<<<<<[^\n]*\n[\s\S]*?^>>>>>>>[^\n]*\n/m)[0],
      new_text: "Local learning.\nUpstream learning.\n" } }));
  const merged = memoryCycle.reconcileMemoryDelivery(root, SESSION, { ...input, resolutions });
  assert.equal(merged.applied, true);
  assert.equal(readFileSync(join(root, "product.txt"), "utf8"), "upstream product\n");
  assert.equal(readFileSync(statePath, "utf8"), stateBefore);
  assert.equal(memoryCycle.finalizationStarted(root, SESSION), false, "a merge must not open finalization or approve eyes");
  assert.deepEqual(missingPiReviewRoles({ projectRoot: root, sessionId: SESSION, featureId: FEATURE,
    phase: "final", roles: ["harness-adversary", "harness-compliance"] }), ["harness-adversary", "harness-compliance"]);
  assert.throws(() => beginHarvest(root, SESSION), /review|evidence/i);
  assert.throws(() => checkMemoryShipperReady(root, SESSION), /review|harvest|changed/i);
});

test("clean delivery merge requires explicit application and does not invent a memory patch or writer", (t) => {
  const { root, git, ...input } = parallelDelivery(t, { memoryConflict: false });
  const preview = memoryCycle.reconcileMemoryDelivery(root, SESSION, input);
  assert.deepEqual(preview.conflicts, []);
  assert.equal(git("rev-parse", "HEAD"), input.expected_head);
  const merged = memoryCycle.reconcileMemoryDelivery(root, SESSION, { ...input, resolutions: [] });
  assert.equal(merged.applied, true);
  assert.equal(readFileSync(join(root, "product.txt"), "utf8"), "upstream product\n");
  assert.equal(memoryCycle.reconcileMemoryDelivery(root, SESSION, { ...input, expected_head: merged.head, resolutions: [] }).already_incorporated, true);
});

test("clean base integration accepts the first durable note created by another run", (t) => {
  const { root, git, ...input } = parallelDelivery(t, { memoryConflict: false });
  git("checkout", "-q", "parallel-main");
  writeFileSync(join(root, "CONTEXT.md"), "Verified upstream domain vocabulary.\n");
  git("add", "CONTEXT.md"); git("commit", "-qm", "docs: first domain note");
  const base_sha = git("rev-parse", "HEAD");
  git("checkout", "-q", "--detach", input.expected_head);
  const merged = memoryCycle.reconcileMemoryDelivery(root, SESSION, { ...input, base_sha, resolutions: [] });
  assert.equal(merged.applied, true);
  assert.equal(readFileSync(join(root, "CONTEXT.md"), "utf8"), "Verified upstream domain vocabulary.\n");
});

test("delivery reconciliation rejects unsafe proposals and paths before mutation", async (t) => {
  for (const variant of ["task-parent", "dirty", "stale-hash", "full-replace", "secret", "runtime", "symlink", "executable", "delete"])
    await t.test(variant, (st) => {
      const { root, git, ...input } = parallelDelivery(st);
      const statePath = join(root, ".pi/harness/state", SESSION, "gate-state.json");
      let params = input;
      if (variant === "task-parent") {
        const state = JSON.parse(readFileSync(statePath, "utf8"));
        state.task_run = { task_id: "task-one" };
        writeFileSync(statePath, JSON.stringify(state));
      } else if (variant === "dirty") writeFileSync(join(root, "product.txt"), "operator WIP\n");
      else if (["stale-hash", "full-replace"].includes(variant)) {
        const entry = memoryCycle.reconcileMemoryDelivery(root, SESSION, input).conflicts[0];
        params = { ...input, resolutions: [{ path: entry.path, before_sha256: variant === "stale-hash" ? "0".repeat(64) : entry.sha256,
          patch: { old_text: entry.content, new_text: "replacement" }, ...(variant === "full-replace" ? { content: "replacement" } : {}) }] };
      } else {
        git("checkout", "-q", "parallel-main");
        if (["symlink", "delete"].includes(variant)) {
          git("rm", "MEMORY.md");
          if (variant === "symlink") symlinkSync("product.txt", join(root, "MEMORY.md"));
        } else if (variant === "executable") chmodSync(join(root, "MEMORY.md"), 0o755);
        else {
          const file = variant === "secret" ? ".env" : ".pi/harness/state/foreign-session.json";
          if (variant === "runtime") mkdirSync(join(root, ".pi/harness/state"), { recursive: true });
          writeFileSync(join(root, file), "fixture, no secrets\n");
          git("add", "-f", "--", file);
        }
        if (variant !== "delete") git("add", "-A", "--", "MEMORY.md");
        git("commit", "-qm", "fixture: unsafe upstream");
        params = { ...input, base_sha: git("rev-parse", "HEAD") };
        git("checkout", "-q", "--detach", input.expected_head);
      }
      const status = git("status", "--porcelain");
      assert.throws(() => memoryCycle.reconcileMemoryDelivery(root, SESSION, params), /global parent|Commit|stale|replacement|secrets|runtime|regular|memory/i);
      assert.equal(git("rev-parse", "HEAD"), input.expected_head);
      assert.equal(git("status", "--porcelain"), status);
    });
});

test("global reconcile refuses mixed product conflicts and stale heads without dirtying the worktree", (t) => {
  const { root, git, ...input } = parallelDelivery(t, { productConflict: true });
  assert.equal(typeof memoryCycle.reconcileMemoryDelivery, "function");
  assert.throws(() => memoryCycle.reconcileMemoryDelivery(root, SESSION, input), /product|outside.*memory/i);
  assert.throws(() => memoryCycle.reconcileMemoryDelivery(root, SESSION, { ...input, expected_head: "0".repeat(40) }), /HEAD|stale/i);
  assert.equal(git("rev-parse", "HEAD"), input.expected_head);
  assert.equal(git("status", "--porcelain"), "");
});

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
