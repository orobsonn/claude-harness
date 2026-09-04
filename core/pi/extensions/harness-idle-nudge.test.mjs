/**
 * @description Testes travados da extensão Pi harness-idle-nudge — adaptador fino sobre a
 * decisão pura reusada da lane OC (decide() em core/opencode/plugin/lib/agent-idle-nudge.mjs).
 * Espelha os casos de core/opencode/plugin/agent-idle-nudge.test.mjs no contrato do Pi:
 * `tool_result` retorna `{ details }` (nunca bloqueia, nunca lança), em vez do
 * `tool.execute.after` (output.metadata) da OC.
 */
import test from "node:test";
import assert from "node:assert/strict";

import harnessIdleNudge, { testApi } from "./harness-idle-nudge.ts";

const { extractResultText } = testApi;

/** @description Registra a extensão contra um fake de ExtensionAPI e devolve o handler tool_result. */
function captureToolResultHandler() {
  let handler;
  const fakePi = {
    on(eventName, fn) {
      if (eventName === "tool_result") handler = fn;
    },
  };
  harnessIdleNudge(fakePi);
  assert.equal(typeof handler, "function", "harness-idle-nudge deve registrar tool_result");
  return handler;
}

const parentCtx = { sessionManager: { getHeader: () => ({}) } };
const childCtx = { sessionManager: { getHeader: () => ({ parentSession: "parent-session-1" }) } };

// --- extração de texto ---

test("extractResultText: string direta, blocos de texto, formas inesperadas viram ''", () => {
  assert.equal(extractResultText("oi"), "oi");
  assert.equal(extractResultText([{ type: "text", text: "a" }, { type: "text", text: "b" }]), "ab");
  assert.equal(extractResultText([{ type: "image", data: "x" }]), "");
  assert.equal(extractResultText(null), "");
  assert.equal(extractResultText(undefined), "");
  assert.equal(extractResultText(42), "");
});

// --- resultado vazio de subagent injeta NUDGE_CONTEXT ---

test("tool_result: subagent com resultado vazio injeta NUDGE em details.agent_idle_nudge", async () => {
  const handler = captureToolResultHandler();
  const result = await handler({ toolName: "subagent", input: { subagent_type: "executor-medium" }, content: "" }, parentCtx);
  assert.equal(typeof result?.details?.agent_idle_nudge, "string");
  assert.match(result.details.agent_idle_nudge, /re-prompt|UNRESOLVED/i);
});

test("tool_result: subagent com content ausente (undefined) também injeta NUDGE", async () => {
  const handler = captureToolResultHandler();
  const result = await handler({ toolName: "subagent", input: {} }, parentCtx);
  assert.equal(typeof result?.details?.agent_idle_nudge, "string");
});

// --- resultado com texto não injeta ---

test("tool_result: subagent com relatório não vazio não injeta nada", async () => {
  const handler = captureToolResultHandler();
  const result = await handler(
    { toolName: "subagent", input: { subagent_type: "executor-medium" }, content: [{ type: "text", text: "DONE: report here" }] },
    parentCtx,
  );
  assert.equal(result, undefined);
});

// --- papel executor-high com 'maximum steps reached' injeta CAPACITY_CONTEXT ---

test("tool_result: papel do Pi ('harness-executor-high') + 'maximum steps reached' injeta CAPACITY_CONTEXT", async () => {
  const handler = captureToolResultHandler();
  const result = await handler(
    {
      toolName: "subagent",
      input: { subagent_type: "harness-executor-high" },
      content: [{ type: "text", text: "Maximum steps reached" }],
    },
    parentCtx,
  );
  assert.equal(typeof result?.details?.agent_idle_nudge, "string");
  assert.match(result.details.agent_idle_nudge, /capacity|tier|escalat/i);
});

test("tool_result: papel já no vocabulário OC ('sniper-high') também injeta CAPACITY_CONTEXT", async () => {
  const handler = captureToolResultHandler();
  const result = await handler(
    { toolName: "subagent", input: { subagent_type: "sniper-high" }, content: "Maximum steps reached" },
    parentCtx,
  );
  assert.match(result.details.agent_idle_nudge, /capacity|tier|escalat/i);
});

test("tool_result: papel sem tier ('harness-adversary') com relatório não vira CAPACITY nem NUDGE", async () => {
  const handler = captureToolResultHandler();
  const result = await handler(
    {
      toolName: "subagent",
      input: { subagent_type: "harness-adversary" },
      content: [{ type: "text", text: "Maximum steps reached" }],
    },
    parentCtx,
  );
  assert.equal(result, undefined);
});

test("tool_result: details preexistentes na resposta são preservados junto do agent_idle_nudge", async () => {
  const handler = captureToolResultHandler();
  const result = await handler(
    { toolName: "subagent", input: {}, content: "", details: { foo: "bar" } },
    parentCtx,
  );
  assert.equal(result.details.foo, "bar");
  assert.equal(typeof result.details.agent_idle_nudge, "string");
});

// --- sessão filha não injeta ---

test("tool_result: sessão filha (parentSession presente) nunca injeta, mesmo com resultado vazio", async () => {
  const handler = captureToolResultHandler();
  const result = await handler({ toolName: "subagent", input: {}, content: "" }, childCtx);
  assert.equal(result, undefined);
});

// --- tool read ignorada ---

test("tool_result: tool 'read' é ignorada mesmo com resultado vazio", async () => {
  const handler = captureToolResultHandler();
  const result = await handler({ toolName: "read", input: {}, content: "" }, parentCtx);
  assert.equal(result, undefined);
});

test("tool_result: get_subagent_result e steer_subagent (não disparam dispatch) são ignoradas", async () => {
  const handler = captureToolResultHandler();
  assert.equal(await handler({ toolName: "get_subagent_result", input: {}, content: "" }, parentCtx), undefined);
  assert.equal(await handler({ toolName: "steer_subagent", input: {}, content: "" }, parentCtx), undefined);
});

// --- fail-open ---

test("tool_result: fail-open em input/ctx ausente ou malformado (nunca lança)", async () => {
  const handler = captureToolResultHandler();
  assert.equal(await handler(undefined, undefined), undefined);
  assert.equal(await handler(null, null), undefined);
  // ctx ausente (isChildSession vira false) + toolName não-subagent → ignorado, sem lançar
  assert.equal(await handler({ toolName: "read" }, undefined), undefined);
  // subagent sem ctx: isChildSession(undefined) é false (pai por omissão) → não lança, pode injetar
  assert.doesNotThrow(() => handler({ toolName: "subagent" }, undefined));
});

test("tool_result: input presente porém não-objeto (array/string) nunca injeta", async () => {
  const handler = captureToolResultHandler();
  assert.equal(await handler({ toolName: "subagent", input: [], content: "" }, parentCtx), undefined);
  assert.equal(await handler({ toolName: "subagent", input: "prompt", content: "" }, parentCtx), undefined);
  // input ausente segue sendo {} (paridade OC: `input?.tool_input ?? {}`) → injeta
  assert.equal(typeof (await handler({ toolName: "subagent", content: "" }, parentCtx))?.details?.agent_idle_nudge, "string");
});
