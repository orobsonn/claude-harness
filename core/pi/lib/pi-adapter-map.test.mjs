import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isPiBashTool,
  isPiWriteTool,
  isPiReadTool,
  isPiDispatchTool,
  piCommandOf,
  piPathsOf,
  piSubagentArgs,
  toOcRole,
  piSessionId,
  isChildSession,
  isPiHeadlessContext,
  isDeliveryRole,
  isExecutorRole,
  isPlannerRole,
  isSniperRole,
  isTestAuthorRole,
  isAdversaryRole,
  isPlanReviewerRole,
} from "./pi-adapter-map.mjs";
import { CANONICAL_ROLES } from "./roles.mjs";

test("headless context uses Pi UI capability and established automation signals, never host location", () => {
  assert.equal(isPiHeadlessContext({ hasUI: false }, {}), true);
  assert.equal(isPiHeadlessContext(undefined, {}), true);
  assert.equal(isPiHeadlessContext({}, {}), true);
  assert.equal(isPiHeadlessContext({ hasUI: true }, {}), false);
  assert.equal(isPiHeadlessContext({ hasUI: true, mode: "rpc" }, {}), true);
  assert.equal(isPiHeadlessContext({ hasUI: true }, { SSH_CONNECTION: "remote-tui" }), false);
  for (const key of ["CLAUDE_CODE_REMOTE", "HARNESS_NOTIFY_PROJECT", "HARNESS_OBSERVABILITY_RUN_PATH"]) {
    assert.equal(isPiHeadlessContext({ hasUI: true }, { [key]: "automation" }), true);
    assert.equal(isPiHeadlessContext({ hasUI: true }, { [key]: "" }), false);
  }
});

// --- predicados de tool ---

test("isPiBashTool: bash e powershell são bash-tool; o resto não", () => {
  assert.equal(isPiBashTool("bash"), true);
  assert.equal(isPiBashTool("powershell"), true);
  assert.equal(isPiBashTool("Bash"), true); // case-insensitive
  assert.equal(isPiBashTool("write"), false);
  assert.equal(isPiBashTool("subagent"), false);
  assert.equal(isPiBashTool(undefined), false);
  assert.equal(isPiBashTool(123), false);
});

test("isPiWriteTool: write e edit são write-tool; o resto não", () => {
  assert.equal(isPiWriteTool("write"), true);
  assert.equal(isPiWriteTool("edit"), true);
  assert.equal(isPiWriteTool("EDIT"), true);
  assert.equal(isPiWriteTool("read"), false);
  assert.equal(isPiWriteTool("bash"), false);
  assert.equal(isPiWriteTool(null), false);
});

test("isPiReadTool: read|grep|find|ls são read-tool; o resto não", () => {
  assert.equal(isPiReadTool("read"), true);
  assert.equal(isPiReadTool("grep"), true);
  assert.equal(isPiReadTool("find"), true);
  assert.equal(isPiReadTool("ls"), true);
  assert.equal(isPiReadTool("write"), false);
  assert.equal(isPiReadTool("bash"), false);
});

test("isPiDispatchTool: só subagent dispara dispatch; get_subagent_result/steer_subagent não", () => {
  assert.equal(isPiDispatchTool("subagent"), true);
  assert.equal(isPiDispatchTool("SUBAGENT"), true);
  assert.equal(isPiDispatchTool("get_subagent_result"), false);
  assert.equal(isPiDispatchTool("steer_subagent"), false);
  assert.equal(isPiDispatchTool("bash"), false);
  assert.equal(isPiDispatchTool(""), false);
});

// --- piCommandOf ---

test("piCommandOf: extrai command de input de bash", () => {
  assert.equal(piCommandOf({ command: "ls -la" }), "ls -la");
});

test("piCommandOf: input malformado/sem command vira string vazia (fail-closed)", () => {
  assert.equal(piCommandOf(null), "");
  assert.equal(piCommandOf(undefined), "");
  assert.equal(piCommandOf([]), "");
  assert.equal(piCommandOf({}), "");
  assert.equal(piCommandOf({ command: 42 }), "");
});

// --- piPathsOf ---

test("piPathsOf: write/edit/read devolvem [input.path]", () => {
  assert.deepEqual(piPathsOf("write", { path: "/a/b.txt", content: "x" }), ["/a/b.txt"]);
  assert.deepEqual(piPathsOf("edit", { path: "/a/b.txt", edits: [] }), ["/a/b.txt"]);
  assert.deepEqual(piPathsOf("read", { path: "/a/b.txt" }), ["/a/b.txt"]);
});

test("piPathsOf: bash/powershell nunca tocam arquivo → []", () => {
  assert.deepEqual(piPathsOf("bash", { command: "rm -rf /a/b.txt" }), []);
  assert.deepEqual(piPathsOf("powershell", { command: "del a.txt" }), []);
});

test("piPathsOf: grep/find/ls e input malformado → []", () => {
  assert.deepEqual(piPathsOf("grep", { pattern: "x" }), []);
  assert.deepEqual(piPathsOf("write", null), []);
  assert.deepEqual(piPathsOf("write", { path: "" }), []);
  assert.deepEqual(piPathsOf("write", { path: 42 }), []);
});

// --- piSubagentArgs ---

test("piSubagentArgs: campos obrigatórios sempre presentes com default vazio", () => {
  assert.deepEqual(piSubagentArgs({}), { prompt: "", description: "", subagent_type: "" });
  assert.deepEqual(piSubagentArgs(null), { prompt: "", description: "", subagent_type: "" });
});

test("piSubagentArgs: extrai campos obrigatórios e opcionais quando presentes", () => {
  const out = piSubagentArgs({
    prompt: "faça X",
    description: "tarefa X",
    subagent_type: "harness-executor",
    model: "gpt-5.1-codex",
    thinking: "high",
    max_turns: 8,
    run_in_background: false,
    resume: "abc",
    inherit_context: true,
  });
  assert.deepEqual(out, {
    prompt: "faça X",
    description: "tarefa X",
    subagent_type: "harness-executor",
    model: "gpt-5.1-codex",
    thinking: "high",
    max_turns: 8,
    run_in_background: false,
    resume: "abc",
    inherit_context: true,
  });
});

test("piSubagentArgs: campo opcional de tipo errado é omitido, não forjado", () => {
  const out = piSubagentArgs({ prompt: "p", model: 123, max_turns: "8" });
  assert.equal(out.prompt, "p");
  assert.equal("model" in out, false);
  assert.equal("max_turns" in out, false);
});

// --- toOcRole + predicados OC delegados ---

test("toOcRole: remove o prefixo harness- (case-insensitive) e delega a bareRole", () => {
  assert.equal(toOcRole("harness-executor"), "executor");
  assert.equal(toOcRole("HARNESS-Planner"), "planner");
  assert.equal(toOcRole("planner"), "planner"); // sem prefixo, passa direto
  assert.equal(toOcRole("harness-executor-high"), "executor-high");
});

test("REGRESSÃO: papel decorado ainda é reconhecido como delivery (bareRole antes do strip)", () => {
  // bareRole() do OC tolera espaço em volta, '@' inicial, namespace 'ns/role'/'ns:role' e
  // sufixo '.md'. Se o prefixo 'harness-' fosse removido ANTES dessa normalização, todos
  // estes virariam o papel desconhecido 'harness-executor' e o dispatch da mão escaparia do
  // gate (fail-open de papel).
  for (const decorated of [
    " harness-executor",
    "harness-executor ",
    "@harness-executor",
    "local/harness-executor",
    "ns:harness-executor",
    "harness-Executor.md",
  ]) {
    const role = toOcRole(decorated);
    assert.equal(role, "executor", `toOcRole(${JSON.stringify(decorated)})`);
    assert.equal(isDeliveryRole(role), true, `isDeliveryRole de ${JSON.stringify(decorated)}`);
    assert.equal(isExecutorRole(role), true, `isExecutorRole de ${JSON.stringify(decorated)}`);
  }
  assert.equal(toOcRole("@local/harness-sniper.md"), "sniper");
});

test("toOcRole: papel sem prefixo continua passando por bareRole (decoração tolerada)", () => {
  assert.equal(toOcRole(" @local/Plan-Reviewer.md "), "plan-reviewer");
  assert.equal(toOcRole("harness-"), "");
  assert.equal(toOcRole("   "), "");
});

test("piSubagentArgs entrega subagent_type verbatim e toOcRole normaliza a folga", () => {
  // piSubagentArgs nunca reescreve o input (não forja identidade); quem normaliza o papel
  // para o vocabulário OC é toOcRole, como faz o extractSubagentType do OC ao trimar.
  const args = piSubagentArgs({ subagent_type: " harness-executor " });
  assert.equal(args.subagent_type, " harness-executor ");
  assert.equal(toOcRole(args.subagent_type), "executor");
  assert.equal(isDeliveryRole(toOcRole(args.subagent_type)), true);
});

test("TODO papel canônico do Pi vira delivery role do OC depois de toOcRole", () => {
  // Guarda a tabela de tradução inteira: se um papel entrar em core/pi/lib/roles.mjs sem
  // contraparte no vocabulário OC, o gate deixaria de reconhecê-lo (fail-open).
  for (const role of CANONICAL_ROLES) {
    const bare = toOcRole(role);
    assert.equal(bare, role.replace(/^harness-/, ""), `toOcRole(${role})`);
    assert.equal(isDeliveryRole(bare), true, `isDeliveryRole(${bare})`);
  }
  assert.equal(isSniperRole(toOcRole("harness-sniper")), true);
  assert.equal(isTestAuthorRole(toOcRole("harness-test-author")), true);
  assert.equal(isAdversaryRole(toOcRole("harness-adversary")), true);
  assert.equal(isPlanReviewerRole(toOcRole("harness-plan-reviewer")), true);
});

test("toOcRole: entrada não-string vira string vazia", () => {
  assert.equal(toOcRole(undefined), "");
  assert.equal(toOcRole(null), "");
  assert.equal(toOcRole(42), "");
});

test("CRÍTICO: bareRole do OC sozinho NÃO reconhece o prefixo harness- (isDeliveryRole falharia sem toOcRole)", () => {
  assert.equal(isDeliveryRole("harness-executor"), false);
});

test("toOcRole('harness-executor') é delivery role e executor role via predicados OC", () => {
  const role = toOcRole("harness-executor");
  assert.equal(role, "executor");
  assert.equal(isDeliveryRole(role), true);
  assert.equal(isExecutorRole(role), true);
});

test("toOcRole('planner') é planner role via predicado OC", () => {
  const role = toOcRole("planner");
  assert.equal(role, "planner");
  assert.equal(isPlannerRole(role), true);
});

// --- piSessionId ---

test("piSessionId: lê o UUID de ctx.sessionManager.getSessionId()", () => {
  const ctx = { sessionManager: { getSessionId: () => "11111111-1111-4111-8111-111111111111" } };
  assert.equal(piSessionId(ctx), "11111111-1111-4111-8111-111111111111");
});

test("piSessionId: ctx malformado/sem sessionManager fail-closed para string vazia", () => {
  assert.equal(piSessionId(undefined), "");
  assert.equal(piSessionId({}), "");
  assert.equal(piSessionId({ sessionManager: {} }), "");
  assert.equal(
    piSessionId({
      sessionManager: {
        getSessionId: () => {
          throw new Error("boom");
        },
      },
    }),
    "",
  );
});

// --- isChildSession ---

test("isChildSession: header com parentSession → true", () => {
  const ctx = { sessionManager: { getHeader: () => ({ parentSession: "parent-id" }) } };
  assert.equal(isChildSession(ctx), true);
});

test("isChildSession: header SEM parentSession → false (caso do enunciado)", () => {
  const ctx = { sessionManager: { getHeader: () => ({}) } };
  assert.equal(isChildSession(ctx), false);
});

test("isChildSession: sem header nenhum ou ctx malformado → false, nunca lança", () => {
  assert.equal(isChildSession(undefined), false);
  assert.equal(isChildSession({}), false);
  assert.equal(isChildSession({ sessionManager: { getHeader: () => null } }), false);
  assert.equal(
    isChildSession({
      sessionManager: {
        getHeader: () => {
          throw new Error("boom");
        },
      },
    }),
    false,
  );
});
