/**
 * @description Regressions for host-owned Pi review evidence. These tests exercise real Git
 * index/worktree state, canonical plan/spec bytes, structured native completion and the shared
 * gate-state lock. A review may authorize a gate only when its report is accepted and its exact
 * input snapshot is still current.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let subject = {};
try {
  subject = await import("./pi-review-evidence.mjs");
} catch (error) {
  if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
}

const SESSION = "ses-review-evidence";
const FEATURE = "feature-review-evidence";
const TASK = "task-one";
const ROLES = ["harness-adversary", "harness-compliance", "harness-security"];

function api(name, args) {
  assert.equal(typeof subject[name], "function", `pi-review-evidence.mjs must export ${name}`);
  return subject[name](args);
}

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "pi-review-evidence-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, ["init", "-q"]);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "feature.ts"), "export const value = 'A';\n");
  writeFileSync(join(root, ".gitignore"), ".pi/harness/state/\nnode_modules/\n.env\n.dev.vars\n");
  mkdirSync(join(root, ".pi", "harness", "plans", FEATURE), { recursive: true });
  writeFileSync(
    join(root, ".pi", "harness", "plans", FEATURE, "execution-plan.json"),
    JSON.stringify({ feature_id: FEATURE, tasks: [{ id: TASK, scope_paths: ["src/feature.ts"] }] }, null, 2),
  );
  writeFileSync(join(root, ".pi", "harness", "plans", FEATURE, "spec.md"), "# Accepted behavior\n");
  mkdirSync(join(root, ".pi", "harness", "state", SESSION), { recursive: true });
  writeFileSync(
    join(root, ".pi", "harness", "state", SESSION, "gate-state.json"),
    JSON.stringify({ session_id: SESSION, feature_id: FEATURE, classified: true, mode: "FULL" }),
  );
  git(root, ["add", ".gitignore", "src", ".pi/harness/plans"]);
  execFileSync(
    "git",
    ["-c", "user.name=Pi Review", "-c", "user.email=pi-review@example.test", "commit", "-q", "-m", "fixture"],
    { cwd: root },
  );
  return root;
}

function capture(root, overrides = {}) {
  const captured = api("capturePiReviewInput", {
    projectRoot: root,
    sessionId: SESSION,
    featureId: FEATURE,
    phase: "final",
    ...overrides,
  });
  assert.equal(captured?.ok, true, captured?.reason);
  assert.equal(typeof captured.snapshot?.input_digest, "string");
  assert.match(captured.snapshot.input_digest, /^[0-9a-f]{64}$/);
  return captured.snapshot;
}

function nativeResult(text, { status = "completed", agentId = "agent-review" } = {}) {
  return {
    content: [{ type: "text", text }],
    details: { status, agentId },
  };
}

function nativeRecord(result, { status = "completed", id = "agent-review", type = "harness-adversary", pendingQuestion } = {}) {
  return {
    id,
    type,
    description: "review",
    status,
    isBackground: false,
    result,
    ...(pendingQuestion ? { pendingQuestion } : {}),
    toolUses: 1,
    turnCount: 1,
    startedAt: 1,
    completedAt: 2,
    lifetimeUsage: { input: 1, output: 1, cacheWrite: 0 },
    compactionCount: 0,
  };
}

function wrappedResult(body, options = {}) {
  const agentId = options.agentId ?? "agent-review";
  return nativeResult(`Agent completed in 1s (1 tool uses).\nAgent ID: ${agentId}\n\n${body}`, options);
}

function parseAccepted(role, snapshot, overrides = {}) {
  const suffix = overrides.suffix ?? role.replace("harness-", "");
  const agentId = `agent-${suffix}`;
  const { suffix: _suffix, ...parseOverrides } = overrides;
  const parsed = api("parsePiReviewCompletion", {
    role,
    result: wrappedResult('{"issues":[]}', { agentId }),
    isError: false,
    nativeRecord: nativeRecord('{"issues":[]}', { id: agentId, type: role }),
    snapshotStart: snapshot,
    snapshotEnd: snapshot,
    ...parseOverrides,
  });
  assert.equal(parsed?.ok, true, parsed?.reason);
  assert.equal(parsed.completion?.accepted, true);
  assert.equal(parsed.completion?.agent_id, agentId, "the pure parse carries the validated native agent identity");
  assert.match(parsed.completion?.report_digest ?? "", /^[0-9a-f]{64}$/);
  return parsed.completion;
}

function binding(role, suffix = role.replace("harness-", "")) {
  return {
    dispatchCallId: `call-${suffix}`,
    childSessionId: `child-${suffix}`,
    agentId: `agent-${suffix}`,
  };
}

test("capturePiReviewInput changes for HEAD, staged, unstaged, relevant untracked, plan and spec inputs", async (t) => {
  const mutations = [
    ["HEAD", (root) => {
      writeFileSync(join(root, "src", "feature.ts"), "export const value = 'HEAD-B';\n");
      git(root, ["add", "src/feature.ts"]);
      execFileSync("git", ["-c", "user.name=Pi Review", "-c", "user.email=pi-review@example.test", "commit", "-q", "-m", "head changed"], { cwd: root });
    }],
    ["staged index", (root) => {
      writeFileSync(join(root, "src", "feature.ts"), "export const value = 'INDEX-B';\n");
      git(root, ["add", "src/feature.ts"]);
    }],
    ["unstaged worktree", (root) => writeFileSync(join(root, "src", "feature.ts"), "export const value = 'WORKTREE-B';\n")],
    ["relevant untracked", (root) => writeFileSync(join(root, "src", "new.ts"), "export const newValue = true;\n")],
    ["canonical plan", (root) => writeFileSync(join(root, ".pi", "harness", "plans", FEATURE, "execution-plan.json"), JSON.stringify({ feature_id: FEATURE, tasks: [{ id: TASK }, { id: "task-two" }] }))],
    ["canonical spec", (root) => writeFileSync(join(root, ".pi", "harness", "plans", FEATURE, "spec.md"), "# Changed behavior\n")],
  ];
  for (const [label, mutate] of mutations) {
    await t.test(label, (st) => {
      const root = fixture(st);
      const before = capture(root);
      mutate(root);
      const after = capture(root);
      assert.notEqual(after.input_digest, before.input_digest, `${label} must invalidate the review snapshot`);
    });
  }
});

test("capturePiReviewInput sees an index change even when the combined HEAD diff is net-zero", (t) => {
  const root = fixture(t);
  const before = capture(root);
  const original = readFileSync(join(root, "src", "feature.ts"), "utf8");
  writeFileSync(join(root, "src", "feature.ts"), "export const value = 'STAGED-B';\n");
  git(root, ["add", "src/feature.ts"]);
  writeFileSync(join(root, "src", "feature.ts"), original);
  assert.equal(git(root, ["diff", "--name-only", "HEAD"]), "", "combined diff alone misses the staged preimage");
  assert.equal(git(root, ["diff", "--cached", "--name-only"]), "src/feature.ts");
  assert.notEqual(capture(root).input_digest, before.input_digest, "the index and worktree must be captured separately");
});

test("review inputs include executable mode even when file contents stay identical", (t) => {
  const root = fixture(t);
  git(root, ["config", "core.filemode", "true"]);
  const file = join(root, "src", "feature.ts");
  chmodSync(file, 0o644);
  const before = capture(root);
  chmodSync(file, 0o755);
  assert.match(git(root, ["diff", "--summary"]), /100644 => 100755/);
  assert.notEqual(capture(root).input_digest, before.input_digest);
});

test("review capture names an unignored nested repository and explains recovery", (t) => {
  const root = fixture(t);
  const nested = join(root, "scratch");
  mkdirSync(nested);
  git(nested, ["init", "-q"]);
  const result = api("capturePiReviewInput", { projectRoot: root, sessionId: SESSION, featureId: FEATURE, phase: "final" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /nested.*scratch.*ignore.*outside/i);
});

test("review capture rejects gitlinks rather than approving uncaptured submodule contents", (t) => {
  const root = fixture(t);
  const oid = git(root, ["rev-parse", "HEAD"]);
  git(root, ["update-index", "--add", "--cacheinfo", `160000,${oid},sub`]);
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "sub", "file.txt"), "synthetic submodule contents");
  const result = subject.capturePiReviewInput({ projectRoot: root, sessionId: SESSION, featureId: FEATURE, phase: "final" });
  assert.equal(result.ok, false, "a gitlink is unsupported until its nested input can be captured reliably");
  assert.match(result.reason, /submodule|gitlink/i);
});

test("tracked and untracked symlinks capture link text without reading an external target", async (t) => {
  for (const tracked of [true, false]) await t.test(tracked ? "tracked" : "untracked", (st) => {
    const root = fixture(st);
    const outside = mkdtempSync(join(tmpdir(), "pi-review-synthetic-target-"));
    st.after(() => rmSync(outside, { recursive: true, force: true }));
    const target = join(outside, "fixture.txt");
    writeFileSync(target, "synthetic external A");
    const link = join(root, "linked.txt");
    symlinkSync(target, link);
    if (tracked) git(root, ["add", "linked.txt"]);
    const before = capture(root);
    writeFileSync(target, "synthetic external B");
    assert.equal(capture(root).input_digest, before.input_digest, "external bytes are not repository review inputs");
    unlinkSync(target);
    assert.equal(capture(root).input_digest, before.input_digest, "even a dangling link must not read its target");
    unlinkSync(link);
    symlinkSync(join(outside, "different.txt"), link);
    assert.notEqual(capture(root).input_digest, before.input_digest, "the actual link text is part of the review");
  });
});

test("canonical review plan and spec reject symlink files and directory ancestry", async (t) => {
  for (const leaf of ["execution-plan.json", "spec.md", "parent-directory"]) await t.test(leaf, (st) => {
    const root = fixture(st);
    const outside = mkdtempSync(join(tmpdir(), "pi-review-canonical-target-"));
    st.after(() => rmSync(outside, { recursive: true, force: true }));
    const planDirectory = join(root, ".pi", "harness", "plans", FEATURE);
    const source = leaf === "parent-directory" ? planDirectory : join(planDirectory, leaf);
    const destination = join(outside, leaf);
    renameSync(source, destination);
    symlinkSync(destination, source);
    const result = subject.capturePiReviewInput({ projectRoot: root, sessionId: SESSION, featureId: FEATURE, phase: "final" });
    assert.equal(result.ok, false, "canonical evidence must be a regular file under regular in-root directories");
    assert.match(result.reason, /symlink|symbolic|canonical|regular/i);
  });
});

test("capturePiReviewInput excludes volatile harness state, ignored dependencies and secret families", (t) => {
  const root = fixture(t);
  const secret = "synthetic-token-DO-NOT-CAPTURE";
  mkdirSync(join(root, ".pi", "agent"), { recursive: true });
  writeFileSync(join(root, ".env"), "TOKEN=synthetic-placeholder-before\n");
  writeFileSync(join(root, ".pi", "agent", "auth.json"), '{"token":"synthetic-placeholder-before"}\n');
  git(root, ["add", "-f", ".env", ".pi/agent/auth.json"]);
  execFileSync("git", ["-c", "user.name=Pi Review", "-c", "user.email=pi-review@example.test", "commit", "-q", "-m", "synthetic secret fixtures"], { cwd: root });
  const before = capture(root);
  writeFileSync(join(root, ".pi", "harness", "state", SESSION, "gate-state.json"), JSON.stringify({ volatile: secret }));
  mkdirSync(join(root, "node_modules", "package"), { recursive: true });
  writeFileSync(join(root, "node_modules", "package", "index.js"), secret);
  writeFileSync(join(root, ".env"), `TOKEN=${secret}\n`);
  writeFileSync(join(root, ".pi", "agent", "auth.json"), `{"token":"${secret}"}\n`);
  const after = capture(root);
  assert.equal(after.input_digest, before.input_digest, "host state and ignored secret/dependency files are not review inputs");
  assert.doesNotMatch(JSON.stringify(after), /synthetic-token|\.env|auth\.json|node_modules|gate-state\.json/);
});

test("parsePiReviewCompletion accepts only a completed canonical no-findings report on an unchanged snapshot", (t) => {
  const snapshot = capture(fixture(t));
  for (const role of ROLES) {
    const agentId = `agent-${role.replace("harness-", "")}`;
    const parsed = api("parsePiReviewCompletion", {
      role,
      result: wrappedResult("```json\n{\"issues\":[]}\n```", { agentId }),
      isError: false,
      nativeRecord: nativeRecord("```json\n{\"issues\":[]}\n```", { id: agentId, type: role }),
      snapshotStart: snapshot,
      snapshotEnd: snapshot,
    });
    assert.equal(parsed?.ok, true, `${role}: ${parsed?.reason}`);
    assert.deepEqual(parsed.completion.report, { issues: [] });
    assert.equal(parsed.completion.accepted, true);
  }
});

test("parsePiReviewCompletion rejects native error, abort/turn-limit, malformed prose and reported findings", (t) => {
  const snapshot = capture(fixture(t));
  const finding = {
    description: "Sibling evidence can be overwritten.",
    category: "race",
    severity: "high",
    scope: "core/pi/extensions/harness-entry-gate.ts",
    evidence: "completion reducer reads outside the lock",
    fix_hint: "Move the complete read-modify-write under the gate-state lock.",
  };
  const cases = [
    ["native error", wrappedResult('{"issues":[]}'), true, nativeRecord('{"issues":[]}')],
    ["aborted native status despite positive prose", wrappedResult('{"issues":[]}', { status: "aborted" }), false, nativeRecord('{"issues":[]}', { status: "aborted" })],
    ["turn-limit native status despite positive prose", wrappedResult('{"issues":[]}', { status: "steered" }), false, nativeRecord('{"issues":[]}', { status: "steered" })],
    ["completed positive prose without canonical report", wrappedResult("Looks good, approved."), false, nativeRecord("Looks good, approved.")],
    ["completed canonical negative report", wrappedResult(JSON.stringify({ issues: [finding] })), false, nativeRecord(JSON.stringify({ issues: [finding] }))],
    ["accepted JSON followed by contradictory failure", wrappedResult('{"issues":[]}\nStatus: FAIL'), false, nativeRecord('{"issues":[]}\nStatus: FAIL')],
    ["accepted JSON with unresolved native question", wrappedResult('{"issues":[]}'), false, nativeRecord('{"issues":[]}', { pendingQuestion: "Should I inspect the remaining file?" })],
    ["wrapper agent id differs from native record", wrappedResult('{"issues":[]}', { agentId: "agent-wrapper" }), false, nativeRecord('{"issues":[]}', { id: "agent-record" })],
    ["native record role differs from requested review role", wrappedResult('{"issues":[]}', { agentId: "agent-review" }), false, nativeRecord('{"issues":[]}', { type: "harness-compliance" })],
  ];
  for (const [label, result, isError, record] of cases) {
    const parsed = api("parsePiReviewCompletion", {
      role: "harness-adversary",
      result,
      isError,
      nativeRecord: record,
      snapshotStart: snapshot,
      snapshotEnd: snapshot,
    });
    assert.equal(parsed?.ok, false, label);
    assert.equal(typeof parsed?.reason, "string", `${label} must explain why it cannot approve`);
  }
});

test("parsePiReviewCompletion rejects any review-input drift after dispatch", (t) => {
  const root = fixture(t);
  const started = capture(root);
  writeFileSync(join(root, "src", "feature.ts"), "export const value = 'DRIFT';\n");
  const ended = capture(root);
  const parsed = api("parsePiReviewCompletion", {
    role: "harness-adversary",
    result: wrappedResult('{"issues":[]}'),
    isError: false,
    nativeRecord: nativeRecord('{"issues":[]}'),
    snapshotStart: started,
    snapshotEnd: ended,
  });
  assert.equal(parsed?.ok, false);
  assert.match(parsed?.reason ?? "", /input|snapshot|changed|drift/i);
});

test("recordPiReviewReceipt preserves inverted sibling completions and denies divergent replay", (t) => {
  const root = fixture(t);
  const snapshot = capture(root);
  const completions = Object.fromEntries(ROLES.map((role) => [role, parseAccepted(role, snapshot)]));
  for (const role of [...ROLES].reverse()) {
    const recorded = api("recordPiReviewReceipt", {
      projectRoot: root,
      sessionId: SESSION,
      completion: completions[role],
      binding: binding(role),
    });
    assert.equal(recorded?.ok, true, recorded?.reason);
  }
  const statePath = join(root, ".pi", "harness", "state", SESSION, "gate-state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  assert.deepEqual(Object.keys(state.final_review_evidence).sort(), ["adversary", "compliance", "security"]);
  for (const role of ROLES) {
    const key = role.replace("harness-", "");
    assert.equal(state.final_review_evidence[key].role, role);
    assert.equal(state.final_review_evidence[key].status, "completed");
    assert.equal(state.final_review_evidence[key].accepted, true);
    assert.equal(state.final_review_evidence[key].input_digest, snapshot.input_digest);
    assert.deepEqual(state.final_review_evidence[key].report, { issues: [] });
  }

  const replay = api("recordPiReviewReceipt", {
    projectRoot: root,
    sessionId: SESSION,
    completion: completions["harness-adversary"],
    binding: { ...binding("harness-adversary"), agentId: "different-agent" },
  });
  assert.equal(replay?.ok, false, "one native call id cannot be rebound to another child result");
  assert.equal(JSON.parse(readFileSync(statePath, "utf8")).final_review_evidence.adversary.agent_id, "agent-adversary");
});

test("recordPiReviewReceipt serializes three actual concurrent process writers without losing siblings", async (t) => {
  const root = fixture(t);
  const snapshot = capture(root);
  const moduleUrl = new URL("./pi-review-evidence.mjs", import.meta.url).href;
  const worker = `
    const { recordPiReviewReceipt } = await import(process.env.PI_REVIEW_MODULE_URL);
    const payload = JSON.parse(process.env.PI_REVIEW_PAYLOAD);
    const result = recordPiReviewReceipt(payload);
    if (!result?.ok) throw new Error(result?.reason ?? "receipt write failed");
  `;
  const runs = ROLES.map((role) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", worker], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PI_REVIEW_MODULE_URL: moduleUrl,
        PI_REVIEW_PAYLOAD: JSON.stringify({
          projectRoot: root,
          sessionId: SESSION,
          completion: parseAccepted(role, snapshot, { suffix: `concurrent-${role.replace("harness-", "")}` }),
          binding: binding(role, `concurrent-${role.replace("harness-", "")}`),
        }),
      },
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr || `child exited ${code}`)));
  }));
  await Promise.all(runs);
  const state = JSON.parse(readFileSync(join(root, ".pi", "harness", "state", SESSION, "gate-state.json"), "utf8"));
  assert.deepEqual(Object.keys(state.final_review_evidence).sort(), ["adversary", "compliance", "security"]);
});

test("recordPiReviewReceipt requires exact host binding and missingPiReviewRoles retries only absent current roles", (t) => {
  const root = fixture(t);
  const snapshot = capture(root);
  const adversary = parseAccepted("harness-adversary", snapshot);
  for (const invalid of [
    undefined,
    { dispatchCallId: "", childSessionId: "child", agentId: "agent" },
    { dispatchCallId: "call", childSessionId: "", agentId: "agent" },
    { dispatchCallId: "call", childSessionId: "child", agentId: "" },
  ]) {
    const result = api("recordPiReviewReceipt", {
      projectRoot: root,
      sessionId: SESSION,
      completion: adversary,
      binding: invalid,
    });
    assert.equal(result?.ok, false, "host binding is mandatory at persistence");
  }
  const mismatchedAgent = api("recordPiReviewReceipt", {
    projectRoot: root,
    sessionId: SESSION,
    completion: adversary,
    binding: { ...binding("harness-adversary"), agentId: "agent-from-another-native-record" },
  });
  assert.equal(mismatchedAgent?.ok, false, "the persistence binding must match the agent identity validated by parse");
  assert.equal(api("recordPiReviewReceipt", {
    projectRoot: root,
    sessionId: SESSION,
    completion: adversary,
    binding: binding("harness-adversary"),
  })?.ok, true);
  const compliance = parseAccepted("harness-compliance", snapshot);
  assert.equal(api("recordPiReviewReceipt", {
    projectRoot: root,
    sessionId: SESSION,
    completion: compliance,
    binding: binding("harness-compliance"),
  })?.ok, true);

  assert.deepEqual(api("missingPiReviewRoles", {
    projectRoot: root,
    sessionId: SESSION,
    featureId: FEATURE,
    phase: "final",
    roles: ROLES,
  }), ["harness-security"], "valid siblings are reused and only the missing role retries");

  writeFileSync(join(root, "src", "feature.ts"), "export const value = 'NEW INPUT';\n");
  assert.deepEqual(api("missingPiReviewRoles", {
    projectRoot: root,
    sessionId: SESSION,
    featureId: FEATURE,
    phase: "final",
    roles: ROLES,
  }), ROLES, "an input change invalidates the whole matching review batch");
});

test("task implementation receipts preserve the existing task adversary gate-state field", (t) => {
  const root = fixture(t);
  const taskSnapshot = capture(root, { phase: "task", taskId: TASK });
  const taskCompletion = parseAccepted("harness-adversary", taskSnapshot, { suffix: "task-adversary" });
  assert.equal(api("recordPiReviewReceipt", {
    projectRoot: root,
    sessionId: SESSION,
    completion: taskCompletion,
    binding: binding("harness-adversary", "task-adversary"),
  })?.ok, true);
  const state = JSON.parse(readFileSync(join(root, ".pi", "harness", "state", SESSION, "gate-state.json"), "utf8"));
  assert.equal(state.task_adversary_evidence[`${FEATURE}/${TASK}`].task_id, TASK);
});
