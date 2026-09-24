/**
 * @description Testes travados de pi-state-records: hand-records e dispatch-records com raiz
 * `.pi/harness/state/`. Espelha os casos de core/opencode/lib/hand-records.test.mjs e
 * dispatch-scope.test.mjs, provando que só o prefixo de diretório muda — digest, schema,
 * fail-closed e reason strings continuam idênticos à lane OC.
 */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  bindPiChildSession,
  claimActivePiDispatch,
  claimPiDispatchForRuntime,
  listPiHandRecordsForFeature,
  piDispatchRecordPath,
  readPiBoundDispatchForChild,
  readPiDispatchRecord,
  removePiDispatchRecord,
  writePiHandRecord,
} from "./pi-state-records.mjs";
import { piHandRecordPath } from "./pi-paths.mjs";
import harnessDispatch from "../extensions/harness-dispatch.ts";

const MODEL_STRATEGY = { hand_tiers: { low: "openai/gpt-5.6-luna", medium: "openai/gpt-5.6-luna", high: "openai/gpt-5.6-terra" }, planner: "openai/planner", "plan-reviewer": "openai/reviewer", compliance: "openai/compliance", adversary: "openai/adversary", security: "openai/security", shipper: "openai/shipper", harvester: "openai/harvester" };

/** @description Cria um projeto temporário; remove tudo no close. */
function tempProject(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { root, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** @description Projeto Pi com plano estável válido + gate-state classificado FULL. */
function planFixture() {
  const { root, close } = tempProject("pi-state-records-");
  const sessionId = "ses-pi-scope";
  const featureId = "feat-pi-scope";
  const tasks = [{
    id: "task-1",
    scope_paths: ["src/a.ts"],
    criterion_refs: ["#ac-1"],
    locked_tests: [{ id: "lt-1", path: "tests/a.test.mjs", assertion: "Given task, When complete, Then observable a" }],
    title: "Implement task-1",
    description: "Implement task-1.",
    depends_on: [],
    severity: "medium",
    complexity: "medium",
    resolved_judgments: { scope: "fixed" },
    adversarial: { enabled: false, focus: [] },
  }];
  const plan = {
    feature_id: featureId, mode: "full", model_strategy: MODEL_STRATEGY,
    final_review: { compliance: true, adversary: true },
    demo: { type: "smoke", scenarios_from_refs: ["#uj-1"] },
    tasks,
  };
  fs.mkdirSync(path.join(root, ".pi", "harness", "plans", featureId), { recursive: true });
  fs.writeFileSync(path.join(root, ".pi", "harness", "plans", featureId, "execution-plan.json"), JSON.stringify(plan));
  const stateDir = path.join(root, ".pi", "harness", "state", sessionId);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "gate-state.json"), JSON.stringify({ session_id: sessionId, feature_id: featureId, classified: true, mode: "FULL" }));
  return { root, sessionId, featureId, close };
}

test("materialized test-author dispatch inherits canonical complexity before route and persists it", () => {
  const f = planFixture();
  try {
    let dispatch;
    harnessDispatch({ on: (name, fn) => { if (name === "tool_call") dispatch = fn; } });
    const planPath = path.join(f.root, ".pi/harness/plans", f.featureId, "execution-plan.json");
    const plan = JSON.parse(fs.readFileSync(planPath));
    for (const complexity of ["low", "medium", "high", "max"]) {
      plan.tasks[0].complexity = complexity;
      fs.writeFileSync(planPath, JSON.stringify(plan));
      const model = "openai-codex/gpt-6-sol";
      const input = { subagent_type: "harness-test-author", prompt: '[HARNESS_TASK_CONTEXT]{"task_id":"task-1"}[/HARNESS_TASK_CONTEXT]', model, thinking: "high" };
      assert.equal(dispatch({ toolName: "subagent", input }, { cwd: f.root, sessionManager: { getSessionId: () => f.sessionId } }), undefined);
      assert.equal(input.complexity, complexity);
      const claim = claimActivePiDispatch(f.root, { sessionId: f.sessionId, callId: `author-${complexity}`, role: input.subagent_type, taskId: "task-1" });
      assert.equal(claim.ok, true, claim.reason);
      assert.equal(claim.claim.complexity, complexity);
      const reread = readPiDispatchRecord(f.root, { parentSessionId: f.sessionId, callId: `author-${complexity}` });
      assert.equal(reread.record.complexity, complexity);
    }
  } finally { f.close(); }
});

const FIX_REVIEWED_SHA = "abc123abc123abc123abc123abc123abc123abcd";

/** @description Projeto Pi em fix mode: sem plano, com gate-state LIGHT e arquivos reais de escopo. */
function fixModeFixture() {
  const { root, close } = tempProject("pi-state-records-fix-");
  const sessionId = "ses-pi-fix";
  const featureId = "feat-pi-fix";
  fs.mkdirSync(path.join(root, "src", "dir"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "a.ts"), "a\n");
  fs.symlinkSync("a.ts", path.join(root, "src", "link.ts"));
  const stateDir = path.join(root, ".pi", "harness", "state", sessionId);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "gate-state.json"), JSON.stringify({ session_id: sessionId, feature_id: featureId, classified: true, mode: "LIGHT" }));
  return { root, sessionId, featureId, close };
}

/** @description Envelope de autoridade de fix mode idêntico ao da lane OC. */
function fixModeEnv(scopePaths) {
  return {
    HARNESS_FIX_MODE: "1",
    HARNESS_FIX_SCOPE_JSON: JSON.stringify({ version: 1, reviewed_sha: FIX_REVIEWED_SHA, scope_paths: scopePaths }),
  };
}

test("hand-record grava sob .pi/harness/state e volta por listPiHandRecordsForFeature", () => {
  const p = tempProject("pi-hand-records-");
  try {
    const roots = { projectRoot: p.root, sessionId: "ses-a", featureId: "feat-f" };
    const record = { featureId: "feat-f", taskId: "task-1", sessionId: "ses-a", outcome: "DONE", freezeCommitSha: "abc123", producerCallId: "call-1", writtenBy: "host-hand-finished" };
    const written = writePiHandRecord({ roots, taskId: "task-1", record });
    assert.equal(written.ok, true, written.reason);
    assert.equal(
      written.path,
      path.join(p.root, ".pi", "harness", "state", "hand-records", "feat-f", "ses-a", "task-1.json"),
    );
    assert.equal(fs.existsSync(written.path), true);

    const listed = listPiHandRecordsForFeature(p.root, "feat-f");
    assert.equal(listed.length, 1);
    assert.equal(listed[0].sessionId, "ses-a");
    assert.equal(listed[0].taskId, "task-1");
    assert.equal(listed[0].record.outcome, "DONE");
    assert.equal(listed[0].identityError, undefined);
  } finally { p.close(); }
});

test("listPiHandRecordsForFeature agrega várias sessões da mesma feature", () => {
  const p = tempProject("pi-hand-records-multi-");
  try {
    for (const [sessionId, taskId] of [["ses-a", "task-1"], ["ses-b", "task-ship"]]) {
      const resolved = piHandRecordPath({ projectRoot: p.root, sessionId, featureId: "feat-f" }, taskId);
      assert.equal(resolved.ok, true);
      fs.mkdirSync(path.dirname(resolved.path), { recursive: true });
      fs.writeFileSync(resolved.path, JSON.stringify({ outcome: "BLOCKED" }), "utf8");
    }
    const listed = listPiHandRecordsForFeature(p.root, "feat-f");
    assert.equal(listed.length, 2);
    assert.ok(listed.some((r) => r.sessionId === "ses-a" && r.taskId === "task-1"));
    assert.ok(listed.some((r) => r.sessionId === "ses-b" && r.taskId === "task-ship"));
  } finally { p.close(); }
});

test("diretório inexistente e featureId inseguro devolvem [] sem lançar", () => {
  const p = tempProject("pi-hand-records-empty-");
  try {
    assert.doesNotThrow(() => {
      assert.deepEqual(listPiHandRecordsForFeature(p.root, "no-such-feature"), []);
      assert.deepEqual(listPiHandRecordsForFeature(p.root, "../../../tmp"), []);
      assert.deepEqual(listPiHandRecordsForFeature("", "feat-f"), []);
    });
  } finally { p.close(); }
});

test("hand-record capture-eligible forjado carrega a identityError da lane OC", () => {
  const p = tempProject("pi-hand-records-identity-");
  try {
    const resolved = piHandRecordPath({ projectRoot: p.root, sessionId: "ses-a", featureId: "feat-f" }, "task-1");
    fs.mkdirSync(path.dirname(resolved.path), { recursive: true });
    fs.writeFileSync(resolved.path, JSON.stringify({ outcome: "DONE", writtenBy: "model-prose", featureId: "feat-f", taskId: "task-1", sessionId: "ses-a" }), "utf8");
    const listed = listPiHandRecordsForFeature(p.root, "feat-f");
    assert.equal(listed.length, 1);
    assert.equal(listed[0].identityError, "hand-record writtenBy is not a host adapter");
  } finally { p.close(); }
});

test("writePiHandRecord recusa identidade fora da raiz sem tocar disco", () => {
  const p = tempProject("pi-hand-records-unsafe-");
  try {
    assert.deepEqual(
      writePiHandRecord({ roots: { projectRoot: p.root, sessionId: "ses-a", featureId: "../escape" }, taskId: "task-1", record: {} }),
      { ok: false, reason: "invalid featureId" },
    );
    assert.deepEqual(
      writePiHandRecord({ roots: { projectRoot: p.root, sessionId: "../escape", featureId: "feat-f" }, taskId: "task-1", record: {} }),
      { ok: false, reason: "invalid sessionId" },
    );
    assert.deepEqual(
      writePiHandRecord({ roots: { projectRoot: p.root, sessionId: "ses-a", featureId: "feat-f" }, taskId: "../escape", record: {} }),
      { ok: false, reason: "invalid taskId" },
    );
    assert.equal(fs.existsSync(path.join(p.root, ".pi")), false);
  } finally { p.close(); }
});

test("piDispatchRecordPath usa o mesmo digest sha256 do OC sob a raiz do Pi", () => {
  const p = tempProject("pi-dispatch-path-");
  try {
    const digest = crypto.createHash("sha256").update("call-1").digest("hex");
    const resolved = piDispatchRecordPath(p.root, "ses-a", "call-1");
    assert.equal(resolved.ok, true, resolved.reason);
    assert.equal(
      resolved.path,
      path.join(fs.realpathSync(p.root), ".pi", "harness", "state", "ses-a", "dispatch-records", `${digest}.json`),
    );
  } finally { p.close(); }
});

test("piDispatchRecordPath rejeita sessão fora da raiz e call vazio", () => {
  const p = tempProject("pi-dispatch-path-unsafe-");
  try {
    for (const parent of ["../escape", "a/b", "", "..", null]) {
      assert.deepEqual(
        piDispatchRecordPath(p.root, parent, "call-1"),
        { ok: false, reason: "exact parent session and dispatch call required" },
      );
    }
    assert.deepEqual(
      piDispatchRecordPath(p.root, "ses-a", ""),
      { ok: false, reason: "exact parent session and dispatch call required" },
    );
    assert.deepEqual(
      piDispatchRecordPath(path.join(p.root, "no-such-root"), "ses-a", "call-1"),
      { ok: false, reason: "project root unreadable" },
    );
  } finally { p.close(); }
});

test("dispatch-record do plano estável: claim -> read -> remove", () => {
  const f = planFixture();
  try {
    const claim = claimActivePiDispatch(f.root, {
      sessionId: f.sessionId, callId: "call-1", role: "harness-executor", taskId: "task-1", now: 1_000,
    });
    assert.equal(claim.ok, true, claim.reason);
    assert.equal(claim.claim.feature_id, f.featureId);
    assert.equal(claim.claim.role, "harness-executor");
    assert.equal(claim.claim.child_session_id, null);
    assert.deepEqual(claim.claim.scope_paths, ["src/a.ts"]);
    assert.deepEqual(claim.claim.allowed_writes, []);
    assert.deepEqual(claim.claim.frozen_paths, ["tests/a.test.mjs"]);
    assert.equal(claim.claim.claimed_at, "1970-01-01T00:00:01.000Z");
    assert.match(claim.claim.plan_hash, /^[0-9a-f]{64}$/);

    const onDisk = piDispatchRecordPath(f.root, f.sessionId, "call-1");
    assert.equal(fs.existsSync(onDisk.path), true);

    const read = readPiDispatchRecord(f.root, { parentSessionId: f.sessionId, callId: "call-1" });
    assert.equal(read.ok, true, read.reason);
    assert.deepEqual(read.record, claim.claim);

    const replay = claimActivePiDispatch(f.root, {
      sessionId: f.sessionId, callId: "call-1", role: "harness-executor", taskId: "task-1", now: 2_000,
    });
    assert.equal(replay.ok, true, replay.reason);
    assert.equal(replay.claim.claimed_at, "1970-01-01T00:00:01.000Z");

    const removed = removePiDispatchRecord(f.root, { sessionId: f.sessionId, callId: "call-1" });
    assert.deepEqual(removed, { ok: true, removed: true });
    assert.equal(fs.existsSync(onDisk.path), false);
    assert.deepEqual(
      readPiDispatchRecord(f.root, { parentSessionId: f.sessionId, callId: "call-1" }),
      { ok: false, absent: true, reason: "dispatch record absent" },
    );
  } finally { f.close(); }
});

test("claim recusa papel que não é mão escritora e task fora do plano", () => {
  const f = planFixture();
  try {
    assert.deepEqual(
      claimActivePiDispatch(f.root, { sessionId: f.sessionId, callId: "c", role: "harness-planner", taskId: "task-1" }),
      { ok: false, reason: "runtime session, task, or writing role invalid" },
    );
    assert.deepEqual(
      claimActivePiDispatch(f.root, { sessionId: "../escape", callId: "c", role: "harness-executor", taskId: "task-1" }),
      { ok: false, reason: "runtime session, task, or writing role invalid" },
    );
    assert.deepEqual(
      claimActivePiDispatch(f.root, { sessionId: f.sessionId, callId: "c", role: "harness-executor", taskId: "task-404" }),
      { ok: false, reason: "canonical task id missing or ambiguous in stable plan" },
    );
    assert.deepEqual(
      claimActivePiDispatch(f.root, { sessionId: "ses-unknown", callId: "c", role: "harness-executor", taskId: "task-1" }),
      { ok: false, reason: "gate-state missing" },
    );
  } finally { f.close(); }
});

test("bindPiChildSession liga só à chamada nomeada e recusa a segunda filha", () => {
  const f = planFixture();
  try {
    assert.equal(claimActivePiDispatch(f.root, {
      sessionId: f.sessionId, callId: "call-1", role: "harness-executor", taskId: "task-1", now: 1_000,
    }).ok, true);

    const bound = bindPiChildSession(f.root, {
      parentSessionId: f.sessionId, childSessionId: "ses-pi-child", role: "harness-executor", callId: "call-1",
    });
    assert.equal(bound.ok, true, bound.reason);
    assert.deepEqual(bound.binding, { parentSessionId: f.sessionId, childSessionId: "ses-pi-child", callId: "call-1", role: "harness-executor" });

    const recovered = readPiBoundDispatchForChild(f.root, "ses-pi-child");
    assert.equal(recovered.ok, true, recovered.reason);
    assert.equal(recovered.callId, "call-1");
    assert.equal(recovered.parentSessionId, f.sessionId);

    assert.deepEqual(
      bindPiChildSession(f.root, { parentSessionId: f.sessionId, childSessionId: "ses-pi-other", role: "harness-executor", callId: "call-1" }),
      { ok: false, reason: "dispatch already bound to another child session" },
    );
    assert.deepEqual(
      bindPiChildSession(f.root, { parentSessionId: f.sessionId, childSessionId: f.sessionId, role: "harness-executor", callId: "call-1" }),
      { ok: false, reason: "exact parent, child, call, and writing role required" },
    );
  } finally { f.close(); }
});

test("fix mode claima o escopo revisado do host com raiz Pi e recusa papel errado", () => {
  const f = fixModeFixture();
  try {
    const env = fixModeEnv(["src/a.ts"]);
    const claim = claimPiDispatchForRuntime(f.root, {
      sessionId: f.sessionId, callId: "fix-call", role: "harness-sniper", taskId: "fix-task", featureId: f.featureId, now: 1_000,
    }, { env, isAncestorFn: () => true });
    assert.equal(claim.ok, true, claim.reason);
    assert.equal(claim.reviewedSha, FIX_REVIEWED_SHA);
    assert.deepEqual(claim.claim.scope_paths, ["src/a.ts"]);
    assert.equal(claim.claim.claimed_at, "1970-01-01T00:00:01.000Z");

    assert.deepEqual(
      claimPiDispatchForRuntime(f.root, {
        sessionId: f.sessionId, callId: "fix-call-2", role: "harness-executor", taskId: "fix-task", featureId: f.featureId,
      }, { env, isAncestorFn: () => true }),
      { ok: false, reason: "fix-mode dispatch requires sniper role" },
    );
    assert.deepEqual(
      claimPiDispatchForRuntime(f.root, {
        sessionId: f.sessionId, callId: "fix-call-3", role: "harness-sniper", taskId: "fix-task", featureId: f.featureId,
      }, { env: fixModeEnv(["src/dir"]), isAncestorFn: () => true }),
      { ok: false, reason: "fix-mode scope must name exact files" },
    );
    assert.deepEqual(
      claimPiDispatchForRuntime(f.root, {
        sessionId: f.sessionId, callId: "fix-call-5", role: "harness-sniper", taskId: "fix-task", featureId: f.featureId,
      }, { env: fixModeEnv(["src/link.ts"]), isAncestorFn: () => true }),
      { ok: false, reason: "fix-mode scope is not canonical" },
    );
    assert.deepEqual(
      claimPiDispatchForRuntime(f.root, {
        sessionId: f.sessionId, callId: "fix-call-4", role: "harness-sniper", taskId: "fix-task", featureId: f.featureId,
      }, { env, isAncestorFn: () => false }),
      { ok: false, reason: "fix-mode reviewed sha is not an ancestor of HEAD" },
    );
  } finally { f.close(); }
});

/** @description Projeto Pi com tasks arbitrárias no plano estável (espelha fixture() do OC). */
function planFixtureWith(tasks) {
  const { root, close } = tempProject("pi-state-records-tasks-");
  const sessionId = "ses-pi-scope";
  const featureId = "feat-pi-scope";
  const normalized = tasks.map((task) => ({
    title: `Implement ${task.id}`, description: `Implement ${task.id}.`, depends_on: [], severity: "medium",
    complexity: "medium", resolved_judgments: { scope: "fixed" }, adversarial: { enabled: false, focus: [] }, ...task,
  }));
  const plan = {
    feature_id: featureId, mode: "full", model_strategy: MODEL_STRATEGY,
    final_review: { compliance: true, adversary: true },
    demo: { type: "smoke", scenarios_from_refs: ["#uj-1"] }, tasks: normalized,
  };
  fs.mkdirSync(path.join(root, ".pi", "harness", "plans", featureId), { recursive: true });
  fs.writeFileSync(path.join(root, ".pi", "harness", "plans", featureId, "execution-plan.json"), JSON.stringify(plan));
  const stateDir = path.join(root, ".pi", "harness", "state", sessionId);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "gate-state.json"), JSON.stringify({ session_id: sessionId, feature_id: featureId, classified: true, mode: "FULL" }));
  return { root, sessionId, featureId, close };
}

/** @description Caminho on-disk do dispatch-record da chamada, sob a raiz real do projeto. */
function recordPathOf(f, callId) {
  return path.join(
    fs.realpathSync(f.root), ".pi", "harness", "state", f.sessionId, "dispatch-records",
    `${crypto.createHash("sha256").update(callId).digest("hex")}.json`,
  );
}

/** @description Raiz de estado do Pi do fixture. */
function stateRootOf(f) {
  return path.join(f.root, ".pi", "harness", "state");
}

test("registro presente só é lido quando o schema inteiro é canônico (mesma matriz do OC)", () => {
  const f = planFixture();
  try {
    assert.equal(claimActivePiDispatch(f.root, { sessionId: f.sessionId, callId: "schema", role: "harness-executor", taskId: "task-1" }).ok, true);
    const target = recordPathOf(f, "schema");
    const valid = JSON.parse(fs.readFileSync(target, "utf8"));
    const malformed = [
      { ...valid, feature_id: "" },
      { ...valid, feature_id: "Not-Kebab" },
      { ...valid, task_id: "../task" },
      { ...valid, role: "harness-planner" },
      { ...valid, role: "planner" },
      { ...valid, plan_hash: "not-a-sha256" },
      { ...valid, child_session_id: "../other" },
      { ...valid, claimed_at: "not-an-iso-timestamp" },
      { ...valid, scope_paths: ["src/a.ts", 7] },
      { ...valid, allowed_writes: [null] },
      { ...valid, scope_paths: [] },
      { ...valid, scope_paths: ["src/a.ts", "src/a.ts"] },
      { ...valid, scope_paths: ["src/../outside.ts"] },
    ];
    for (const record of malformed) {
      fs.writeFileSync(target, JSON.stringify(record));
      const read = readPiDispatchRecord(f.root, { parentSessionId: f.sessionId, callId: "schema" });
      assert.equal(read.ok, false, JSON.stringify(record));
      assert.equal(read.conflict, true, JSON.stringify(record));
      assert.equal(read.reason, "dispatch record schema conflict", JSON.stringify(record));
    }
  } finally { f.close(); }
});

test("bind falha fechado quando a varredura de irmãos sob .pi/harness/state falta com a verdade", (t) => {
  // dispatch-records que é arquivo, nome de hash não-canônico, pai que discorda do diretório,
  // e alias de symlink de sessão — todos negam com a MESMA reason do OC.
  const cases = [
    ["dispatch-records não é diretório", (f) => {
      const broken = path.join(stateRootOf(f), "broken-session");
      fs.mkdirSync(broken, { recursive: true });
      fs.writeFileSync(path.join(broken, "dispatch-records"), "not-a-directory");
    }],
    ["nome de arquivo não é o sha256 do call id", (f) => {
      const records = path.join(stateRootOf(f), "other-session", "dispatch-records");
      fs.mkdirSync(records, { recursive: true });
      fs.writeFileSync(path.join(records, "bad-name.json"), JSON.stringify({
        parent_session_id: "other-session", dispatch_call_id: "other-call", child_session_id: null,
        feature_id: "feat-pi-scope", task_id: "task-1", role: "harness-executor", scope_paths: ["src/a.ts"],
        allowed_writes: [], plan_hash: "a".repeat(64), claimed_at: "2026-08-01T00:00:00.000Z",
      }));
    }],
    ["parent_session_id discorda do diretório de sessão", (f) => {
      const records = path.join(stateRootOf(f), "other-session", "dispatch-records");
      fs.mkdirSync(records, { recursive: true });
      const otherCall = "other-call";
      fs.writeFileSync(path.join(records, `${crypto.createHash("sha256").update(otherCall).digest("hex")}.json`), JSON.stringify({
        parent_session_id: "wrong-session", dispatch_call_id: otherCall, child_session_id: null,
        feature_id: "feat-pi-scope", task_id: "task-1", role: "harness-executor", scope_paths: ["src/a.ts"],
        allowed_writes: [], plan_hash: "a".repeat(64), claimed_at: "2026-08-01T00:00:00.000Z",
      }));
    }],
    ["diretório de sessão é symlink", (f) => {
      const stateRoot = stateRootOf(f);
      const realSession = path.join(stateRoot, "real-session");
      fs.mkdirSync(realSession, { recursive: true });
      fs.symlinkSync(realSession, path.join(stateRoot, "session-alias"), "dir");
    }],
  ];
  for (const [label, corrupt] of cases) {
    const f = planFixture();
    try {
      assert.equal(claimActivePiDispatch(f.root, { sessionId: f.sessionId, callId: "wanted", role: "harness-executor", taskId: "task-1" }).ok, true);
      try { corrupt(f); } catch { t.skip("symlinks indisponíveis"); return; }
      const result = bindPiChildSession(f.root, { parentSessionId: f.sessionId, childSessionId: "ses-pi-child", role: "harness-executor", callId: "wanted" });
      assert.equal(result.ok, false, label);
      assert.equal(result.reason, "dispatch sibling scan failed", label);
      assert.equal(JSON.parse(fs.readFileSync(recordPathOf(f, "wanted"), "utf8")).child_session_id, null, label);
    } finally { f.close(); }
  }
});

test("raiz de estado symlinkada é rejeitada e alias da raiz do projeto canonicaliza", (t) => {
  const f = planFixture();
  const external = fs.mkdtempSync(path.join(os.tmpdir(), "pi-state-records-ext-"));
  const alias = `${f.root}-alias`;
  try {
    try {
      fs.symlinkSync(f.root, alias, "dir");
      assert.equal(claimActivePiDispatch(alias, { sessionId: f.sessionId, callId: "alias", role: "harness-executor", taskId: "task-1" }).ok, true);
      // Bind pelo alias é idempotente e byte-estável com o bind pela raiz real.
      assert.equal(bindPiChildSession(f.root, { parentSessionId: f.sessionId, childSessionId: "ses-pi-child", role: "harness-executor", callId: "alias" }).ok, true);
      const before = fs.readFileSync(recordPathOf(f, "alias"));
      assert.equal(bindPiChildSession(alias, { parentSessionId: f.sessionId, childSessionId: "ses-pi-child", role: "harness-executor", callId: "alias" }).ok, true);
      assert.deepEqual(fs.readFileSync(recordPathOf(f, "alias")), before);
      // Agora `.pi` vira symlink pra fora da raiz: todo claim morre.
      fs.cpSync(path.join(f.root, ".pi"), path.join(external, ".pi"), { recursive: true });
      fs.rmSync(path.join(f.root, ".pi"), { recursive: true, force: true });
      fs.symlinkSync(path.join(external, ".pi"), path.join(f.root, ".pi"), "dir");
    } catch { t.skip("symlinks indisponíveis"); return; }
    assert.deepEqual(
      claimActivePiDispatch(f.root, { sessionId: f.sessionId, callId: "escape", role: "harness-executor", taskId: "task-1" }),
      { ok: false, reason: "dispatch lifecycle lock path escapes project root" },
    );
  } finally {
    try { fs.unlinkSync(alias); } catch { /* indisponível */ }
    fs.rmSync(external, { recursive: true, force: true });
    f.close();
  }
});

test("frozen_paths vêm do plano estável e test-author escreve só o teste travado", () => {
  const f = planFixtureWith([{
    id: "task-1", scope_paths: ["src/", "tests/"], criterion_refs: ["#ac-1"],
    locked_tests: [{ id: "lt-1", path: "tests/a.test.mjs", fixture_paths: ["tests/fixtures/a.json"], assertion: "a" }],
  }]);
  try {
    const executor = claimActivePiDispatch(f.root, { sessionId: f.sessionId, callId: "executor-frozen", role: "harness-executor", taskId: "task-1" });
    assert.equal(executor.ok, true, executor.reason);
    assert.deepEqual(executor.claim.frozen_paths, ["tests/a.test.mjs", "tests/fixtures/a.json"]);

    const testAuthor = claimActivePiDispatch(f.root, { sessionId: f.sessionId, callId: "test-author-frozen", role: "harness-test-author", taskId: "task-1" });
    assert.equal(testAuthor.ok, true, testAuthor.reason);
    assert.deepEqual(testAuthor.claim.scope_paths, ["tests/a.test.mjs", "tests/fixtures/a.json"]);
    assert.deepEqual(testAuthor.claim.allowed_writes, []);
    assert.deepEqual(testAuthor.claim.frozen_paths, []);
  } finally { f.close(); }
});

test("claim recusa plano alterado após a política canônica no_tests", () => {
  const f = planFixtureWith([{
    id: "task-1", scope_paths: ["src/a.ts"], criterion_refs: ["#ac-1"], locked_tests: [], no_tests: true,
  }]);
  try {
    const planPath = path.join(f.root, ".pi", "harness", "plans", f.featureId, "execution-plan.json");
    const expectedPlanHash = crypto.createHash("sha256").update(fs.readFileSync(planPath)).digest("hex");
    const changed = JSON.parse(fs.readFileSync(planPath, "utf8"));
    delete changed.tasks[0].no_tests;
    changed.tasks[0].locked_tests = [{ id: "lt-1", path: "tests/a.test.mjs", assertion: "observable" }];
    fs.writeFileSync(planPath, JSON.stringify(changed));

    assert.deepEqual(
      claimActivePiDispatch(f.root, {
        sessionId: f.sessionId,
        callId: "changed-no-tests-policy",
        role: "harness-executor",
        taskId: "task-1",
        expectedPlanHash,
      }),
      { ok: false, reason: "canonical task changed since policy check" },
    );
  } finally { f.close(); }
});

test("limpeza de uma chamada ausente não remove o registro irmão", () => {
  const f = planFixture();
  try {
    assert.equal(claimActivePiDispatch(f.root, { sessionId: f.sessionId, callId: "right", role: "harness-executor", taskId: "task-1" }).ok, true);
    const before = fs.readFileSync(recordPathOf(f, "right"));
    assert.deepEqual(removePiDispatchRecord(f.root, { sessionId: f.sessionId, callId: "wrong" }), { ok: true, removed: true });
    assert.deepEqual(fs.readFileSync(recordPathOf(f, "right")), before);
  } finally { f.close(); }
});

test("mesma chamada com task ou papel diferente nega o replay", () => {
  const f = planFixtureWith([
    { id: "left", scope_paths: ["src/left.ts"], criterion_refs: ["#left"], locked_tests: [{ id: "l", path: "tests/left.test.mjs", assertion: "left" }] },
    { id: "right", scope_paths: ["src/right.ts"], criterion_refs: ["#right"], locked_tests: [{ id: "r", path: "tests/right.test.mjs", assertion: "right" }] },
  ]);
  try {
    assert.equal(claimActivePiDispatch(f.root, { sessionId: f.sessionId, callId: "same", role: "harness-executor", taskId: "left" }).ok, true);
    for (const args of [
      { role: "harness-executor", taskId: "right" },
      { role: "harness-sniper", taskId: "left" },
      { role: "executor", taskId: "left" },
    ]) {
      assert.deepEqual(
        claimActivePiDispatch(f.root, { sessionId: f.sessionId, callId: "same", ...args }),
        { ok: false, conflict: true, reason: "same dispatch call replay conflicts with canonical scope" },
        JSON.stringify(args),
      );
    }
  } finally { f.close(); }
});
