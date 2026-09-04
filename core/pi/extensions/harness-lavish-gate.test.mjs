/**
 * @description Testes travados da extensão Pi harness-lavish-gate — adaptador fino sobre a
 * decisão pura reusada da lane OC (lavishDenyReason em
 * core/opencode/plugin/lib/lavish-command-decide.mjs). Espelha os casos de
 * core/opencode/plugin/lavish-command-gate.test.mjs no contrato do Pi: `tool_call` retorna
 * `{ block: true, reason }` (não lança), em vez do `throw` do `tool.execute.before` da OC.
 */
import test from "node:test";
import assert from "node:assert/strict";

import harnessLavishGate, { testApi } from "./harness-lavish-gate.ts";
import { forbiddenLavishSubcommand, lavishDenyReason } from "../../opencode/plugin/lib/lavish-command-decide.mjs";

const { isPiBashTool, piCommandOf } = testApi;

/** @description Registra a extensão contra um fake de ExtensionAPI e devolve o handler tool_call. */
function captureToolCallHandler() {
  let handler;
  const fakePi = {
    on(eventName, fn) {
      if (eventName === "tool_call") handler = fn;
    },
  };
  harnessLavishGate(fakePi);
  assert.equal(typeof handler, "function", "harness-lavish-gate deve registrar tool_call");
  return handler;
}

// --- reuso da camada pura (mesmos casos da lane OC) ---

test("forbiddenLavishSubcommand: null em uso comum de lavish-axi (open/poll/preview)", () => {
  assert.equal(forbiddenLavishSubcommand("npx -y lavish-axi docs/prd/x-mockup.html"), null);
  assert.equal(forbiddenLavishSubcommand("npx -y lavish-axi poll docs/prd/x-mockup.html"), null);
  assert.equal(forbiddenLavishSubcommand("npx -y lavish-axi preview mockup.html"), null);
});

test('forbiddenLavishSubcommand: "share" e "setup hooks" nos dois subcomandos proibidos', () => {
  assert.equal(forbiddenLavishSubcommand("npx -y lavish-axi share docs/prd/x-mockup.html"), "share");
  assert.equal(forbiddenLavishSubcommand("npx -y lavish-axi setup hooks"), "setup hooks");
});

test('lavishDenyReason: null no permitido, cita ht-ml.app para "share"', () => {
  assert.equal(lavishDenyReason("npx -y lavish-axi poll x.html"), null);
  assert.match(lavishDenyReason("npx -y lavish-axi share mockup.html"), /ht-ml\.app/);
});

// --- filtro de tool ---

test("isPiBashTool: aceita bash/shell e variantes com sufixo, rejeita outras tools", () => {
  assert.equal(isPiBashTool("bash"), true);
  assert.equal(isPiBashTool("shell"), true);
  assert.equal(isPiBashTool("harness_bash"), true);
  assert.equal(isPiBashTool("read"), false);
  assert.equal(isPiBashTool(undefined), false);
});

test("piCommandOf: extrai command/cmd, undefined em input não-objeto", () => {
  assert.equal(piCommandOf({ command: "echo ok" }), "echo ok");
  assert.equal(piCommandOf({ cmd: "echo ok" }), "echo ok");
  assert.equal(piCommandOf(null), undefined);
  assert.equal(piCommandOf("echo ok"), undefined);
});

// --- adaptador tool_call (contrato Pi: bloqueio via retorno { block, reason }, não throw) ---

test("tool_call: ignora tool que não é bash mesmo com comando proibido", async () => {
  const handler = captureToolCallHandler();
  const result = await handler({ toolName: "read", input: { command: "npx lavish-axi share mockup" } });
  assert.equal(result, undefined);
});

test("tool_call: bloqueia npx lavish-axi share mockup", async () => {
  const handler = captureToolCallHandler();
  const result = await handler({ toolName: "bash", input: { command: "npx lavish-axi share mockup" } });
  assert.equal(result.block, true);
  assert.match(result.reason, /^\[lavish-command-gate\] Blocked:/);
  assert.match(result.reason, /See core\/\*\/skills\/grill\/references\/lavish-usage\.md\./);
});

test("tool_call: bloqueia lavish-axi@1.2.3 setup hooks", async () => {
  const handler = captureToolCallHandler();
  const result = await handler({ toolName: "bash", input: { command: "lavish-axi@1.2.3 setup hooks" } });
  assert.equal(result.block, true);
  assert.match(result.reason, /setup hooks/);
});

test("tool_call: bloqueia menção em cláusula posterior (echo ok && lavish-axi share landing)", async () => {
  const handler = captureToolCallHandler();
  const result = await handler({ toolName: "bash", input: { command: "echo ok && lavish-axi share landing" } });
  assert.equal(result.block, true);
});

test("tool_call: reconhece nome de tool bash com namespace (harness.bash)", async () => {
  const handler = captureToolCallHandler();
  const result = await handler({ toolName: "harness.bash", input: { command: "npx -y lavish-axi share x.html" } });
  assert.equal(result.block, true);
  assert.match(result.reason, /\[lavish-command-gate\]/);
});

test("tool_call: permite comando lavish-axi comum via bash (open/poll)", async () => {
  const handler = captureToolCallHandler();
  assert.equal(await handler({ toolName: "bash", input: { command: "npx -y lavish-axi docs/prd/x-mockup.html" } }), undefined);
  assert.equal(await handler({ toolName: "bash", input: { command: "npx -y lavish-axi poll docs/prd/x-mockup.html" } }), undefined);
});

test("tool_call: permite npx lavish-axi preview mockup (subcomando não proibido)", async () => {
  const handler = captureToolCallHandler();
  const result = await handler({ toolName: "bash", input: { command: "npx lavish-axi preview mockup" } });
  assert.equal(result, undefined);
});

test("tool_call: ignora tool read com o mesmo texto proibido (sem falso positivo fora do bash)", async () => {
  const handler = captureToolCallHandler();
  const result = await handler({ toolName: "read", input: { command: "lavish-axi share mockup" } });
  assert.equal(result, undefined);
});

test("tool_call: fail-open em input ausente/malformado", async () => {
  const handler = captureToolCallHandler();
  assert.equal(await handler({ toolName: "bash", input: undefined }), undefined);
  assert.equal(await handler({ toolName: "bash" }), undefined);
  assert.equal(await handler(undefined), undefined);
});
