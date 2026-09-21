/**
 * @description Testes travados da extensão Pi harness-obs — adaptador fino dos três observadores
 * da lane OC (obs-hand, obs-eye, obs-plan-write) sobre a lógica pura de core/pi/lib/obs.mjs.
 * Espelham os casos de core/opencode/plugin/obs-hooks.test.mjs no contrato do Pi: os args do
 * dispatch/escrita chegam em `tool_execution_start` (o `tool_execution_end` do Pi NÃO os carrega)
 * e o outbox real é exercitado por HARNESS_OBSERVABILITY_RUN_PATH.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import harnessObs from "./harness-obs.ts";

const SESSION = "ses-obs-ext";
const FEATURE = "obs-ext";
const MARKER = '[HARNESS_TASK_CONTEXT]{"task_id":"t1"}[/HARNESS_TASK_CONTEXT]';

/** @description Registra a extensão contra um fake de ExtensionAPI e devolve os dois handlers. */
function captureHandlers(injected) {
  const handlers = {};
  harnessObs(/** @type {any} */ ({ on: (name, fn) => { handlers[name] = fn; } }), injected);
  assert.equal(typeof handlers.tool_call, "function");
  assert.equal(typeof handlers.tool_execution_start, "function");
  assert.equal(typeof handlers.tool_execution_end, "function");
  return handlers;
}

test("JEV starts from the enriched tool_call input, not the original execution args", async () => {
  const starts = [];
  const finishes = [];
  const h = captureHandlers({
    startJevFidelityShadow: (input) => { starts.push(input); return true; },
    finishJevFidelityShadow: (input) => { finishes.push(input); },
  });
  const ctx = { cwd: "/repo", sessionManager: { getSessionId: () => SESSION } };
  const enriched = {
    subagent_type: "harness-test-reviewer",
    prompt: `${MARKER}\n[HARNESS_REVIEW_EVIDENCE]\n{"status":"available"}\n[/HARNESS_REVIEW_EVIDENCE]`,
  };
  h.tool_call({ toolCallId: "jev-1", toolName: "subagent", input: enriched }, ctx);
  h.tool_execution_start({
    toolCallId: "jev-1",
    toolName: "subagent",
    args: { subagent_type: "harness-test-reviewer", prompt: MARKER },
  }, ctx);
  h.tool_execution_end({ toolCallId: "jev-1", toolName: "subagent", result: "Verdict: APPROVE" }, ctx);
  assert.equal(starts.length, 1);
  assert.match(starts[0].dispatch.prompt, /HARNESS_REVIEW_EVIDENCE/);
  assert.equal(finishes.length, 1);
  assert.equal(finishes[0].callId, "jev-1");
});

/**
 * @description Projeto temporário com gate-state/plano Pi e um outbox real; restaura o env.
 * @param {{ tasks?: object[] }} opts
 * @param {(fixture: { root: string, ctx: object, events: () => object[] }) => Promise<void>|void} fn
 */
async function withFixture(opts, fn) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-obs-ext-")));
  const previous = process.env.HARNESS_OBSERVABILITY_RUN_PATH;
  const metaPath = path.join(root, "outbox", "run.json");
  fs.mkdirSync(path.dirname(metaPath), { recursive: true });
  fs.writeFileSync(metaPath, JSON.stringify({ run_id: "r1" }), "utf8");
  process.env.HARNESS_OBSERVABILITY_RUN_PATH = metaPath;

  const stateDir = path.join(root, ".pi", "harness", "state", SESSION);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "gate-state.json"),
    JSON.stringify({ session_id: SESSION, feature_id: FEATURE, classified: true, mode: "FULL" }),
    "utf8",
  );
  if (opts.tasks) {
    const planDir = path.join(root, ".pi", "harness", "plans", FEATURE);
    fs.mkdirSync(planDir, { recursive: true });
    fs.writeFileSync(
      path.join(planDir, "execution-plan.json"),
      JSON.stringify({ feature_id: FEATURE, mode: "full", tasks: opts.tasks }),
      "utf8",
    );
  }
  const events = () =>
    (fs.existsSync(`${root}/outbox/run.events.jsonl`)
      ? fs.readFileSync(`${root}/outbox/run.events.jsonl`, "utf8")
      : "")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  try {
    await fn({
      root,
      ctx: { cwd: root, sessionManager: { getSessionId: () => SESSION } },
      events,
    });
  } finally {
    if (previous === undefined) delete process.env.HARNESS_OBSERVABILITY_RUN_PATH;
    else process.env.HARNESS_OBSERVABILITY_RUN_PATH = previous;
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

test("dispatch de mão: start emite task-executing e end emite hand-ran com os args memorizados", async () => {
  await withFixture({ tasks: [{ id: "t0" }, { id: "t1" }] }, async ({ ctx, events }) => {
    const h = captureHandlers();
    const args = { subagent_type: "harness-executor", prompt: MARKER, model: "openai-codex/gpt-5.6" };
    h.tool_execution_start({ toolCallId: "call-1", toolName: "subagent", args }, ctx);
    // O fim do Pi não carrega args — só o memo do início pode identificar a task.
    h.tool_execution_end({ toolCallId: "call-1", toolName: "subagent", result: "Status: DONE", isError: false }, ctx);
    assert.deepEqual(
      events().map(({ ts, ...rest }) => rest),
      [
        { type: "task-executing", n: 2, total: 2 },
        { type: "hand-ran", task: "t1", model: "openai-codex/gpt-5.6" },
      ],
    );
  });
});

test("dispatch de olho: nenhum task-executing e o veredito curado no fim", async () => {
  await withFixture({}, async ({ ctx, events }) => {
    const h = captureHandlers();
    const args = { subagent_type: "harness-adversary", prompt: "ataque a spec" };
    h.tool_execution_start({ toolCallId: "call-2", toolName: "subagent", args }, ctx);
    h.tool_execution_end({ toolCallId: "call-2", toolName: "subagent", result: '{"issues":[]}', isError: false }, ctx);
    assert.deepEqual(events().map(({ ts, ...rest }) => rest), [
      { type: "spec-adversary", role: "adversary" },
    ]);
  });
});

test("write do plano estável Pi emite plan-created com a contagem de tasks escrita", async () => {
  await withFixture({}, async ({ root, ctx, events }) => {
    const h = captureHandlers();
    const args = {
      path: path.join(root, ".pi", "harness", "plans", FEATURE, "execution-plan.json"),
      content: JSON.stringify({ tasks: [{ id: "t1" }, { id: "t2" }] }),
    };
    h.tool_execution_start({ toolCallId: "call-3", toolName: "write", args }, ctx);
    h.tool_execution_end({ toolCallId: "call-3", toolName: "write", result: "ok", isError: false }, ctx);
    assert.deepEqual(events().map(({ ts, ...rest }) => rest), [
      { type: "plan-created", session_id: SESSION, feature_id: FEATURE, tasks: 2 },
    ]);
  });
});

test("tools não observadas e eventos malformados não emitem nada e nunca lançam", async () => {
  await withFixture({ tasks: [{ id: "t1" }] }, async ({ ctx, events }) => {
    const h = captureHandlers();
    assert.doesNotThrow(() => {
      h.tool_execution_start({ toolCallId: "call-4", toolName: "bash", args: { command: "ls" } }, ctx);
      h.tool_execution_end({ toolCallId: "call-4", toolName: "bash", result: "ls", isError: false }, ctx);
      // Fim sem início (memo ausente) e evento sem nada dentro.
      h.tool_execution_end({ toolCallId: "orfao", toolName: "subagent", result: "x", isError: false }, ctx);
      h.tool_execution_start(undefined, undefined);
      h.tool_execution_end(undefined, undefined);
      // Escrita fora de .pi/harness/plans.
      h.tool_execution_start({ toolCallId: "call-5", toolName: "write", args: { path: "src/index.ts", content: "x" } }, ctx);
      h.tool_execution_end({ toolCallId: "call-5", toolName: "write", result: "ok", isError: false }, ctx);
    });
    assert.deepEqual(events(), []);
  });
});

test("o adaptador não tem dependência do OpenCode", () => {
  const source = fs.readFileSync(new URL("./harness-obs.ts", import.meta.url), "utf8");
  assert.equal(/opencode/i.test(source), false);
});
