/** @description The plugin owns the canonical execution-plan.json: it writes what it hashed,
 * refuses without destroying a good plan, and binds without the orchestrator retyping anything.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readPlannerArtifact,
  reconcilePlannerStateFromDisk,
  semanticPlanHash,
  prepareCanonicalPlan,
  preparedPlanMatchesArtifacts,
  writeBoundPlanSnapshot,
  writeCanonicalPlan,
} from "./planner-artifact.mjs";
import { claimPlannerAttempt, completePlannerAttempt } from "./planner-state.mjs";
import { gateStatePath } from "../../shared/lib/path-helpers.mjs";

const SESSION = "ses-canonical-write";
const FEATURE = "canonical-write";
const MODEL_STRATEGY = {
  hand_tiers: { low: "gemma4", medium: "glm-5.2", high: "kimi-k2.7-code" },
  planner: "openai/planner", "plan-reviewer": "openai/reviewer", compliance: "openai/compliance",
  adversary: "openai/adversary", security: "openai/security", shipper: "openai/shipper", harvester: "openai/harvester",
};

function plan(overrides = {}) {
  return {
    feature_id: FEATURE,
    kind: "full",
    mode: "full",
    model_strategy: MODEL_STRATEGY,
    tasks: [{
      id: "task-1",
      severity: "medium",
      complexity: "medium",
      scope_paths: ["src/a.ts"],
      criterion_refs: ["#ac-1"],
      depends_on: [],
      locked_tests: [{ id: "lt-1", path: "src/a.test.ts", assertion: "Given a, When b, Then c" }],
    }],
    ...overrides,
  };
}

function root() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "oc-canonical-plan-"));
}

function planPath(dir) {
  return path.join(dir, ".opencode", "plans", `${SESSION}-${FEATURE}`, "execution-plan.json");
}

function seedUsableBinding(dir) {
  const prepared = prepareCanonicalPlan(dir, SESSION, FEATURE, plan(), { expectedModelStrategy: MODEL_STRATEGY });
  assert.equal(prepared.ok, true);
  const snapshot = writeBoundPlanSnapshot(dir, SESSION, {
    valid: true, semanticHash: prepared.semanticHash, plan: prepared.plan, raw: prepared.raw,
  });
  assert.equal(snapshot.ok, true);
  assert.equal(writeCanonicalPlan(dir, SESSION, FEATURE, prepared.plan, { prepared }).ok, true);
  const artifact = readPlannerArtifact(dir, SESSION, FEATURE);
  const sp = gateStatePath({ projectRoot: dir, runtime: "opencode", sessionId: SESSION });
  fs.mkdirSync(path.dirname(sp.path), { recursive: true });
  const binding = {
    session_id: SESSION,
    feature_id: FEATURE,
    semantic_hash: artifact.semanticHash,
    file_hash: artifact.fileHash,
    fingerprint: artifact.fingerprint,
    snapshot_path: snapshot.relativePath,
    snapshot_hash: snapshot.snapshot.semanticHash,
    snapshot_file_hash: snapshot.snapshot.fileHash,
  };
  fs.writeFileSync(sp.path, JSON.stringify({
    session_id: SESSION,
    feature_id: FEATURE,
    planner_status: "usable",
    planner_plan_binding: binding,
  }));
  return { statePath: sp.path, binding };
}

test("writes the returned plan at the canonical path and it reads back valid", () => {
  const dir = root();
  const written = writeCanonicalPlan(dir, SESSION, FEATURE, plan(), { requireExpectedModelStrategy: false });
  assert.equal(written.ok, true);
  assert.equal(written.path, planPath(dir));
  const artifact = readPlannerArtifact(dir, SESSION, FEATURE);
  assert.equal(artifact.valid, true);
  assert.equal(artifact.semanticHash, semanticPlanHash(plan()));
});

test("snapshot and canonical artifact use the exact same staged bytes", () => {
  const dir = root();
  const prepared = prepareCanonicalPlan(dir, SESSION, FEATURE, plan(), { expectedModelStrategy: MODEL_STRATEGY });
  assert.equal(prepared.ok, true);
  const snapshot = writeBoundPlanSnapshot(dir, SESSION, {
    valid: true, semanticHash: prepared.semanticHash, plan: prepared.plan, raw: prepared.raw,
  });
  assert.equal(snapshot.ok, true);
  const written = writeCanonicalPlan(dir, SESSION, FEATURE, prepared.plan, { prepared });
  assert.equal(written.ok, true);
  assert.equal(snapshot.snapshot.fileHash, written.fileHash);
  assert.deepEqual(fs.readFileSync(path.join(dir, snapshot.relativePath)), fs.readFileSync(planPath(dir)));
});

test("a failed snapshot rename cleans its temp so a same-pid retry can publish", () => {
  const dir = root();
  const prepared = prepareCanonicalPlan(dir, SESSION, FEATURE, plan(), { expectedModelStrategy: MODEL_STRATEGY });
  assert.equal(prepared.ok, true);
  const originalRename = fs.renameSync;
  let failOnce = true;
  fs.renameSync = (from, to) => {
    if (failOnce && String(to).includes(`${path.sep}bound-plans${path.sep}`)) {
      failOnce = false;
      throw new Error("simulated snapshot rename failure");
    }
    return originalRename(from, to);
  };
  try {
    const first = writeBoundPlanSnapshot(dir, SESSION, {
      valid: true, semanticHash: prepared.semanticHash, plan: prepared.plan, raw: prepared.raw,
    });
    assert.equal(first.ok, false);
    const snapshotDir = path.join(dir, ".opencode", "plans", ".state", SESSION, "bound-plans");
    assert.deepEqual(fs.readdirSync(snapshotDir).filter((name) => name.endsWith(".tmp")), []);
  } finally {
    fs.renameSync = originalRename;
  }
  const second = writeBoundPlanSnapshot(dir, SESSION, {
    valid: true, semanticHash: prepared.semanticHash, plan: prepared.plan, raw: prepared.raw,
  });
  assert.equal(second.ok, true);
});

test("a semantically equal reserialization is not accepted as the prepared authoritative bytes", () => {
  const dir = root();
  const prepared = prepareCanonicalPlan(dir, SESSION, FEATURE, plan(), { expectedModelStrategy: MODEL_STRATEGY });
  assert.equal(prepared.ok, true);
  const reserialized = { ...prepared, raw: Buffer.from(`${JSON.stringify(prepared.plan)}\n`), authoritative: true };
  const snapshot = writeBoundPlanSnapshot(dir, SESSION, { valid: true, semanticHash: reserialized.semanticHash, plan: reserialized.plan, raw: reserialized.raw });
  assert.equal(snapshot.ok, true);
  const written = writeCanonicalPlan(dir, SESSION, FEATURE, reserialized.plan, { prepared: reserialized });
  assert.equal(written.ok, true);
  const artifact = readPlannerArtifact(dir, SESSION, FEATURE);
  assert.equal(preparedPlanMatchesArtifacts(prepared, artifact, snapshot.snapshot), false);
});

test("a wrong-feature plan is refused and the existing canonical plan survives", () => {
  const dir = root();
  assert.equal(writeCanonicalPlan(dir, SESSION, FEATURE, plan(), { requireExpectedModelStrategy: false }).ok, true);
  const before = fs.readFileSync(planPath(dir), "utf8");

  const refused = writeCanonicalPlan(dir, SESSION, FEATURE, plan({ feature_id: "other-feature" }), { requireExpectedModelStrategy: false });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /feature_id/);
  assert.equal(fs.readFileSync(planPath(dir), "utf8"), before);
});

test("a structurally invalid plan is refused and the existing canonical plan survives", () => {
  const dir = root();
  assert.equal(writeCanonicalPlan(dir, SESSION, FEATURE, plan(), { requireExpectedModelStrategy: false }).ok, true);
  const before = fs.readFileSync(planPath(dir), "utf8");

  const refused = writeCanonicalPlan(dir, SESSION, FEATURE, plan({ tasks: [{}] }), { requireExpectedModelStrategy: false });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /structural validation/);
  assert.equal(fs.readFileSync(planPath(dir), "utf8"), before);
  assert.equal(fs.readdirSync(path.dirname(planPath(dir))).filter((f) => f.endsWith(".tmp")).length, 0);
});

test("reconciliation does not self-bind an unbound canonical plan", () => {
  const dir = root();
  const sp = gateStatePath({ projectRoot: dir, runtime: "opencode", sessionId: SESSION });
  assert.equal(sp.ok, true);
  fs.mkdirSync(path.dirname(sp.path), { recursive: true });
  fs.writeFileSync(sp.path, JSON.stringify({ session_id: SESSION, feature_id: FEATURE }));

  const returned = plan();
  const claimed = claimPlannerAttempt(
    { session_id: SESSION, feature_id: FEATURE },
    {
      role: "planner",
      callId: "call-1",
      token: "token-1",
      sessionId: SESSION,
      featureId: FEATURE,
      model: "openai/planner",
      baselinePlan: { exists: false, fingerprint: "missing" },
      now: 1,
    },
  );
  assert.equal(claimed.ok, true);
  const completed = completePlannerAttempt(claimed.state, {
    callId: "call-1",
    token: "token-1",
    resultKind: "usable_plan",
    planHash: semanticPlanHash(returned),
    now: 2,
  });
  assert.equal(completed.state.planner_status, "plan_pending_write");

  // A downstream reader only verifies already-bound state; it cannot adopt pending bytes.
  assert.equal(writeCanonicalPlan(dir, SESSION, FEATURE, returned, { requireExpectedModelStrategy: false }).ok, true);
  fs.writeFileSync(sp.path, JSON.stringify(completed.state));
  const reconciled = reconcilePlannerStateFromDisk(dir, SESSION);

  assert.equal(reconciled.ok, true);
  assert.equal(reconciled.state.planner_status, "plan_pending_write");
  assert.equal(reconciled.state.planner_plan_binding, undefined);
});

test("a paraphrased plan cannot bind — the hash gate still holds against hand-editing", () => {
  const dir = root();
  const sp = gateStatePath({ projectRoot: dir, runtime: "opencode", sessionId: SESSION });
  fs.mkdirSync(path.dirname(sp.path), { recursive: true });

  const returned = plan();
  const paraphrased = plan({
    tasks: [{ ...returned.tasks[0], locked_tests: [{ id: "lt-1", path: "src/a.test.ts", assertion: "a works" }] }],
  });
  assert.equal(writeCanonicalPlan(dir, SESSION, FEATURE, paraphrased, { requireExpectedModelStrategy: false }).ok, true);
  fs.writeFileSync(sp.path, JSON.stringify({
    session_id: SESSION,
    feature_id: FEATURE,
    planner_status: "plan_pending_write",
    planner_active_attempt: {
      call_id: "call-1",
      token: "token-1",
      role: "planner",
      session_id: SESSION,
      feature_id: FEATURE,
      status: "plan_returned",
      returned_plan_hash: semanticPlanHash(returned),
      baseline_plan: { exists: false, fingerprint: "missing" },
    },
  }));

  const reconciled = reconcilePlannerStateFromDisk(dir, SESSION);
  assert.equal(reconciled.ok, true);
  assert.notEqual(reconciled.state.planner_status, "usable");
});

test("reconciliation rejects every non-exact snapshot_path spelling", () => {
  for (const mutate of [
    (dir, binding) => path.resolve(dir, binding.snapshot_path),
    (_dir, binding) => binding.snapshot_path.replace("bound-plans/", "bound-plans/./"),
    (_dir, binding) => binding.snapshot_path.replace("bound-plans/", "bound-plans/x/../"),
    (_dir, binding) => binding.snapshot_path.replaceAll("/", "\\"),
    (_dir, binding) => binding.snapshot_path.replace(`/${SESSION}/`, "/ses-other/"),
    () => null,
    () => 42,
  ]) {
    const dir = root();
    const seeded = seedUsableBinding(dir);
    const state = JSON.parse(fs.readFileSync(seeded.statePath, "utf8"));
    state.planner_plan_binding.snapshot_path = mutate(dir, seeded.binding);
    fs.writeFileSync(seeded.statePath, JSON.stringify(state));
    const reconciled = reconcilePlannerStateFromDisk(dir, SESSION);
    assert.equal(reconciled.ok, true);
    assert.equal(reconciled.state.planner_status, "plan_invalid");
    assert.match(reconciled.state.planner_binding_error, /snapshot path/);
  }
});

test("reconciliation keeps an approved binding usable when only filesystem metadata changes", () => {
  const dir = root();
  const seeded = seedUsableBinding(dir);
  const canonical = planPath(dir);
  const before = readPlannerArtifact(dir, SESSION, FEATURE);
  assert.equal(before.exists, true, "seeded canonical plan is readable");

  fs.chmodSync(canonical, 0o600);

  const after = readPlannerArtifact(dir, SESSION, FEATURE);
  assert.equal(after.fileHash, before.fileHash, "the canonical bytes did not change");
  assert.notEqual(after.fingerprint, before.fingerprint, "the filesystem metadata changed");

  const reconciled = reconcilePlannerStateFromDisk(dir, SESSION);
  assert.equal(reconciled.ok, true);
  assert.equal(reconciled.state.planner_status, "usable");
  assert.equal(reconciled.state.planner_binding_error, undefined);
  assert.equal(JSON.parse(fs.readFileSync(seeded.statePath, "utf8")).planner_status, "usable");
});
