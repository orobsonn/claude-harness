import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";

import {
  buildJevFidelityState,
  finishJevFidelityShadow,
  JEV_API_KEY_ENV,
  JEV_MODEL,
  JEV_SHADOW_ENV,
  startJevFidelityShadow,
  summarizeJevFidelityRecords,
  testApi,
} from "./jev-fidelity-shadow.mjs";

const SESSION = "ses-jev-shadow";

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-jev-shadow-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const evidence = path.join(root, ".pi", "harness", "state", SESSION, "evidence");
  const packetDir = path.join(evidence, "review-packets", "00000000-0000-4000-8000-000000000001");
  fs.mkdirSync(packetDir, { recursive: true });
  const output = path.join(evidence, "00000000-0000-4000-8000-000000000002.log");
  fs.writeFileSync(output, "1 test passed; password=super-secret-value\n");
  const packet = {
    status: "available",
    snapshot_path: path.join(packetDir, "snapshot.json"),
    diff_path: path.join(packetDir, "review.diff"),
    command_evidence_path: path.join(packetDir, "command-evidence.json"),
  };
  fs.writeFileSync(packet.snapshot_path, JSON.stringify({
    baseline: { status: "available", sha: "a".repeat(40) },
    status: [{ code: "??", path: "test/new.test.mjs" }],
    untracked_paths: ["test/new.test.mjs"],
  }));
  fs.writeFileSync(packet.diff_path, "+ assert.equal(actual, expected)\n+ const token = 'apikey_abcdefghijklmnopqrstuvwxyz123456';\n");
  fs.writeFileSync(packet.command_evidence_path, JSON.stringify({
    exact_current: [{
      command: "node --test test/new.test.mjs",
      original_status: { kind: "success", is_error: false, exit_code: 0 },
      freshness: "exact-current",
      output_path: output,
    }],
    supplied: [],
    supplied_unavailable: [],
  }));
  const prompt = [
    "Review only this task.",
    "[HARNESS_CANONICAL_TASK]",
    JSON.stringify({ id: "t1", description: "Reject a stale receipt and accept a fresh one." }),
    "[/HARNESS_CANONICAL_TASK]",
    "[HARNESS_REVIEW_EVIDENCE]",
    JSON.stringify(packet),
    "[/HARNESS_REVIEW_EVIDENCE]",
  ].join("\n");
  return { root, packet, prompt };
}

async function waitFor(file) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (fs.existsSync(file)) return;
    await wait(10);
  }
  throw new Error(`timed out waiting for ${file}`);
}

test("builds bounded structured state from the host review packet and redacts secrets", (t) => {
  const f = fixture(t);
  const built = buildJevFidelityState({ projectRoot: f.root, sessionId: SESSION, prompt: f.prompt });
  assert.equal(built.ok, true);
  assert.equal(built.state.obligation.id, "t1");
  assert.match(built.state.representation.exact_review_diff, /assert\.equal/);
  assert.match(built.state.representation.exact_review_diff, /REDACTED/);
  assert.doesNotMatch(JSON.stringify(built.state), /super-secret-value|apikey_abcdefghijklmnopqrstuvwxyz/);
  assert.equal(built.state.execution.runs[0].original_status.exit_code, 0);
  assert.match(built.sha256, /^[0-9a-f]{64}$/);
});

test("rejects a forged packet outside the host evidence directory", (t) => {
  const f = fixture(t);
  const forged = f.prompt.replace(f.packet.diff_path, "/etc/passwd");
  assert.deepEqual(
    buildJevFidelityState({ projectRoot: f.root, sessionId: SESSION, prompt: forged }),
    { ok: false, reason: "review-packet-invalid" },
  );
});

test("shadow records prediction and native verdict without gaining authority", async (t) => {
  const f = fixture(t);
  let request;
  const fetchImpl = async (_url, init) => {
    request = init;
    return new Response(JSON.stringify({
      model: JEV_MODEL,
      answers: {
        fidelity_verdict: {
          type: "choice",
          choice: "APPROVE",
          probabilities: { APPROVE: 0.96, REVISE: 0.03, BLOCKED: 0.01 },
          confidence: 0.94,
        },
      },
      usage: { input_tokens: 123, output_tokens: 12 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const started = startJevFidelityShadow({
    projectRoot: f.root,
    sessionId: SESSION,
    callId: "call-1",
    dispatch: { subagent_type: "harness-test-reviewer", task_id: "t1", prompt: f.prompt },
    env: { [JEV_SHADOW_ENV]: "1", [JEV_API_KEY_ENV]: "test-key" },
    fetchImpl,
  });
  assert.equal(started, true);
  finishJevFidelityShadow({
    projectRoot: f.root,
    sessionId: SESSION,
    callId: "call-1",
    responseText: "Native evidence.\nVerdict: APPROVE",
  });
  const summaryPath = path.join(f.root, ".pi", "harness", "observability", "jev-fidelity-shadow-summary.json");
  await waitFor(summaryPath);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
    if (summary.paired_reviews === 1) break;
    await wait(10);
  }
  const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
  assert.equal(summary.mode, "shadow-only");
  assert.equal(summary.authority, "none");
  assert.equal(summary.paired_reviews, 1);
  assert.equal(summary.exact_matches, 1);
  assert.equal(summary.false_approves, 0);
  assert.equal(request.headers.authorization, "Bearer test-key");
  const events = fs.readFileSync(summaryPath.replace("-summary.json", ".jsonl"), "utf8");
  assert.doesNotMatch(events, /test-key|assert\.equal|Reject a stale receipt/);
});

test("disabled shadow does not create observability artifacts", (t) => {
  const f = fixture(t);
  const started = startJevFidelityShadow({
    projectRoot: f.root,
    sessionId: SESSION,
    callId: "call-disabled",
    dispatch: { subagent_type: "harness-test-reviewer", prompt: f.prompt },
    env: { [JEV_API_KEY_ENV]: "unused" },
    fetchImpl: () => { throw new Error("must not run"); },
  });
  assert.equal(started, false);
  assert.equal(fs.existsSync(path.join(f.root, ".pi", "harness", "observability")), false);
});

test("shadow refuses a redirected event log and remains fail-open", (t) => {
  const f = fixture(t);
  const directory = path.join(f.root, ".pi", "harness", "observability");
  fs.mkdirSync(directory, { recursive: true });
  const victim = path.join(f.root, "victim.txt");
  fs.writeFileSync(victim, "unchanged\n");
  fs.symlinkSync(victim, path.join(directory, "jev-fidelity-shadow.jsonl"));
  assert.doesNotThrow(() => startJevFidelityShadow({
    projectRoot: f.root,
    sessionId: SESSION,
    callId: "call-redirected",
    dispatch: { subagent_type: "harness-test-reviewer", prompt: f.prompt },
    env: { [JEV_SHADOW_ENV]: "1" },
  }));
  assert.equal(fs.readFileSync(victim, "utf8"), "unchanged\n");
});

test("summary exposes dangerous disagreement directions separately", () => {
  const records = [
    { type: "prediction", call_id: "a", status: "ok", choice: "APPROVE", usage: { input_tokens: 10 } },
    { type: "native-verdict", call_id: "a", verdict: "REVISE" },
    { type: "prediction", call_id: "b", status: "ok", choice: "REVISE", usage: { output_tokens: 2 } },
    { type: "native-verdict", call_id: "b", verdict: "APPROVE" },
  ];
  const summary = summarizeJevFidelityRecords(records);
  assert.equal(summary.paired_reviews, 2);
  assert.equal(summary.false_approves, 1);
  assert.equal(summary.false_rejects, 1);
  assert.deepEqual(summary.usage, { input_tokens: 10, output_tokens: 2 });
});

test("TypeSafe overload is retried and the pinned model is sent", async () => {
  let calls = 0;
  const result = await testApi.requestJev({
    state: { obligation: {}, representation: {}, execution: {} },
    apiKey: "key",
    signal: new AbortController().signal,
    fetchImpl: async (_url, init) => {
      calls += 1;
      const body = JSON.parse(init.body);
      assert.equal(body.model, JEV_MODEL);
      return calls === 1
        ? new Response("busy", { status: 529 })
        : new Response(JSON.stringify({ answers: {}, usage: {}, model: JEV_MODEL }), { status: 200 });
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.model, JEV_MODEL);
});
