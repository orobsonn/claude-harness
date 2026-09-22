import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createJiti } from "../../../node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti-static.mjs";

const ENTRY = fileURLToPath(new URL("./harness-subagents.ts", import.meta.url));
const SOURCE_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function fakePi() {
  const handlers = new Map();
  const pi = {
    tools: new Map(), handlers,
    events: { emit(name, data) {
      for (const handler of handlers.get(name) ?? []) handler(data);
      if (name === "harness:child-bind" && data.result === undefined) data.result = { ok: true };
    } },
    on(name, handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    registerTool(tool) { this.tools.set(tool.name, tool); },
  };
  return pi;
}

async function nativeReviewTool() {
  const jiti = createJiti(import.meta.url, { moduleCache: false, tsconfigPaths: true });
  const { AgentTool } = await jiti.import(fileURLToPath(new URL(
    "../../../node_modules/@gotgenes/pi-subagents/src/tools/agent-tool.ts", import.meta.url,
  )));
  // Use the pinned tool's real description, schema and renderer without launching a child.
  return AgentTool.prototype.toToolDefinition.call({
    typeListText: "harness-adversary: review; harness-compliance: review; harness-security: review",
    availableTypesText: "harness-adversary, harness-compliance, harness-security",
    agentDir: "/fixture/agents", agentGuidelines: [], registry: {},
  });
}

test("the registered native tool teaches foreground review batches instead of forbidden background dispatch", async () => {
  const { testApi } = await createJiti(import.meta.url, { moduleCache: false, tsconfigPaths: true }).import(ENTRY);
  const native = await nativeReviewTool();
  const pi = fakePi();
  testApi.decorateNativeFactory((api) => api.registerTool(native))(pi);
  const tool = pi.tools.get("subagent");
  assert.doesNotMatch(tool.description, /For parallel work, use run_in_background: true|Foreground calls run sequentially|Use run_in_background for work you don't need immediately/);
  assert.match(tool.description, /foreground.*same (?:tool-call )?batch/is);
  assert.match(tool.description, /run_in_background.*(?:omit|false|forbidden)/is);
  assert.match(tool.description, /harness-adversary.*harness-compliance.*harness-security/s);
  assert.match(tool.description, /harness-support.*distinct diagnostic objectives/s);
  assert.match(tool.parameters.properties.run_in_background.description, /(?:omit|false|forbidden)/i);
  assert.deepEqual(tool.parameters.properties.complexity.enum, ["low", "medium", "high", "max"]);
  assert.match(tool.parameters.properties.complexity.description, /Required for executor, sniper and test-author/);
  assert.notEqual(tool.description, native.description, "native guidance is adapted without mutating the native tool");
  assert.match(native.description, /For parallel work, use run_in_background: true/);
});

test("native cards show pre-dispatch errors with empty details and preserve actual lifecycle outcomes", async () => {
  const { testApi } = await createJiti(import.meta.url, { moduleCache: false, tsconfigPaths: true }).import(ENTRY);
  const native = await nativeReviewTool();
  const pi = fakePi();
  testApi.decorateNativeFactory((api) => api.registerTool(native))(pi);
  const tool = pi.tools.get("subagent");
  const theme = { fg: (_color, text) => text, bold: (text) => text };
  const render = (target, result, options) => target.renderResult(result, options, theme).render(160).join("\n");
  for (const expanded of [false, true]) {
    const options = { expanded, isPartial: false };
    for (const reason of ["harness dispatch blocked: background-disabled", "harness dispatch blocked: model-route"]) {
      const result = { content: [{ type: "text", text: reason }], details: {}, isError: true };
      const before = structuredClone(result);
      const card = render(tool, result, options);
      assert.ok(card.includes(reason), card);
      assert.doesNotMatch(card, /max turns exceeded|APROVADO|Done/);
      assert.deepEqual(result, before, "rendering must not change the canonical error or receipt inputs");
    }
    for (const status of ["aborted", "stopped", "error", "running", "steered"]) {
      const result = { content: [{ type: "text", text: "native output" }], details: {
        status, error: "provider unavailable", durationMs: 10, turnCount: 144, maxTurns: 144,
      } };
      assert.equal(render(tool, result, options), render(native, result, options), status);
    }
  }
  const partial = { content: [{ type: "text", text: "pending" }], details: {} };
  const options = { expanded: false, isPartial: true };
  assert.equal(render(tool, partial, options), render(native, partial, options));
});

test("production entrypoint resolves the monorepo root without an injected override", async () => {
  const module = await createJiti(import.meta.url, { moduleCache: false, tsconfigPaths: true })
    .import(ENTRY);
  assert.equal(module.testApi.harnessRoot(), SOURCE_ROOT.replace(/\/$/, ""));
});

test("production entrypoint keeps a vendored harness root as its resource root", async (t) => {
  const module = await createJiti(import.meta.url, { moduleCache: false, tsconfigPaths: true })
    .import(ENTRY);
  const root = mkdtempSync(join(tmpdir(), "pi-vendored-root-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const vendored = join(root, ".pi", "harness");
  mkdirSync(join(vendored, "extensions"), { recursive: true });
  mkdirSync(join(root, "core", "pi", "extensions"), { recursive: true });
  assert.equal(module.testApi.resolveHarnessRoot(vendored), vendored);
});

test("native installs read the effective cap from the SDK agent directory, including manual serial fallback", async (t) => {
  const entry = await createJiti(import.meta.url, { moduleCache: false, tsconfigPaths: true })
    .import(ENTRY, { default: true });
  const root = mkdtempSync(join(tmpdir(), "pi-native-cap-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  for (const cap of [3, 1]) {
    const agentDir = join(root, String(cap));
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "harness.json"), `${JSON.stringify({ maxParallelEyes: cap })}\n`);
    const pi = fakePi();
    await entry(pi, {
      root: SOURCE_ROOT,
      getAgentDir: () => agentDir,
      async loadNativeFactory() { return () => {}; },
    });
    const notifications = [];
    for (const handler of pi.handlers.get("session_start") ?? []) {
      handler({}, { hasUI: true, ui: { notify: (message) => notifications.push(message) } });
    }
    assert.deepEqual(notifications, [`Harness parallel reviewers: ${cap}`]);
  }
});

test("production entrypoint suppresses descendant native factories and keeps the parent service", async () => {
  const entry = await createJiti(import.meta.url, { moduleCache: false, tsconfigPaths: true })
    .import(ENTRY, { default: true });
  const pi = fakePi();
  let nativeFactoryCalls = 0;
  const service = { identity: "parent" };
  const deps = {
    root: fileURLToPath(new URL("../../../", import.meta.url)),
    maxParallelEyes: 3,
    async loadNativeFactory() {
      return (api) => {
        nativeFactoryCalls++;
        globalThis[Symbol.for("@gotgenes/pi-subagents:service")] = service;
        api.registerTool({
          name: "subagent",
          async execute() {
            await entry(api, deps);
            return "child alive";
          },
        });
      };
    },
  };

  await entry(pi, deps);
  const parentService = globalThis[Symbol.for("@gotgenes/pi-subagents:service")];
  for (let index = 0; index < 3; index++) {
    assert.equal(await pi.tools.get("subagent").execute(`call-${index}`, {
      subagent_type: "harness-adversary",
      prompt: "[HARNESS_FINAL_REVIEW] review",
    }), "child alive");
  }
  assert.equal(nativeFactoryCalls, 1);
  assert.equal(globalThis[Symbol.for("@gotgenes/pi-subagents:service")], parentService);
  delete globalThis[Symbol.for("@gotgenes/pi-subagents:service")];
});

test("production entrypoint rejects a missing child rail before child model work", async () => {
  const entry = await createJiti(import.meta.url, { moduleCache: false, tsconfigPaths: true })
    .import(ENTRY, { default: true });
  const pi = fakePi();
  let childModelCalls = 0;
  await entry(pi, {
    root: fileURLToPath(new URL("../../../", import.meta.url)),
    maxParallelEyes: 1,
    async loadNativeFactory() {
      return (api) => api.registerTool({
        name: "subagent",
        async execute() {
          api.events.emit("subagents:child:session-created", { sessionId: "child", parentSessionId: "parent" });
          api.events.emit("subagents:child:bound", {
            sessionId: "child", parentSessionId: "parent",
            extensions: { resolvedPaths: [], errors: [] },
            skills: { filePaths: [], diagnostics: [] },
          });
          childModelCalls++;
        },
      });
    },
  });

  await assert.rejects(
    pi.tools.get("subagent").execute("call", { subagent_type: "harness-adversary", prompt: "[HARNESS_FINAL_REVIEW] review" }),
    /child extension missing/i,
  );
  assert.equal(childModelCalls, 0);
});

test("collapsed native cards show public planner and reviewer outcomes without changing expanded results", async () => {
  const entryModule = await createJiti(import.meta.url, { moduleCache: false, tsconfigPaths: true })
    .import(ENTRY);
  const pi = fakePi();
  await entryModule.default(pi, {
    root: SOURCE_ROOT,
    maxParallelEyes: 3,
    async loadNativeFactory() {
      return (api) => api.registerTool({
        name: "subagent",
        execute() {},
        renderResult(result, options) { return { result, options }; },
      });
    },
  });

  const tool = pi.tools.get("subagent");
  const completed = (subagentType, text) => ({
    content: [{ type: "text", text }],
    details: { status: "completed", subagentType },
  });
  const collapsed = { expanded: false, isPartial: false };

  const plannerText = [
    '{"version":1,"tasks":[{"id":"task-1"},{"id":"task-2"}]}',
    "Plano de entrega criado com 2 tarefas, severidades low/high e adversarial em task-2.",
  ].join("\n");
  const planner = tool.renderResult(completed("harness-planner", plannerText), collapsed, {});
  assert.equal(planner.options.expanded, true);
  assert.match(planner.result.content[0].text, /^└ Done\n└ PLANO · .*2 tarefas/);

  const planRevision = tool.renderResult(completed("harness-plan-reviewer", JSON.stringify({
    verdict: "REVISE",
    findings: [{
      area: "scope", severity: "high", task_id: "task-2",
      problem: "O caminho de migração não pertence à tarefa.",
      planner_instruction: "Mova o caminho para a tarefa proprietária.",
    }],
  })), collapsed, {});
  assert.match(planRevision.result.content[0].text, /PARECER: REVISAR · O caminho de migração/);

  const approval = tool.renderResult(completed("harness-security", '{"issues":[]}'), collapsed, {});
  assert.match(approval.result.content[0].text, /PARECER: APROVADO · sem achados/);

  const original = completed("harness-compliance", '{"issues":[]}');
  const expanded = tool.renderResult(original, { expanded: true, isPartial: false }, {});
  assert.strictEqual(expanded.result, original);
  assert.equal(expanded.options.expanded, true);
});

test("collapsed review summaries remain neutral without one completed canonical verdict", async () => {
  const { testApi } = await createJiti(import.meta.url, { moduleCache: false, tsconfigPaths: true })
    .import(ENTRY);
  const result = (status, subagentType, text) => ({
    content: [{ type: "text", text }],
    details: { status, subagentType },
  });

  assert.equal(
    testApi.summarizeHarnessSubagentResult(result("completed", "harness-test-reviewer", [
      "Findings:",
      "- A fixture não alcança o comportamento aprovado.",
      "Verdict: REVISE",
    ].join("\n"))),
    "PARECER: REVISAR · A fixture não alcança o comportamento aprovado.",
  );
  assert.equal(
    testApi.summarizeHarnessSubagentResult(result("completed", "harness-test-reviewer", "Verdict: APPROVE\nVerdict: REVISE")),
    "PARECER: INDISPONÍVEL · expanda para ver a saída",
  );
  assert.equal(
    testApi.summarizeHarnessSubagentResult(result("completed", "harness-test-reviewer", [
      "Agent completed in 2.0s (3 tool uses).",
      "Agent ID: child-1",
      "",
      "Verdict: APPROVE",
      "",
      "Phase: test-fidelity. All obligations pass.",
    ].join("\n"))),
    "PARECER: APROVADO · obrigações de teste atendidas",
  );
  assert.equal(
    testApi.summarizeHarnessSubagentResult(result("completed", "harness-test-reviewer", [
      "Agent completed in 2.0s (3 tool uses).",
      "Agent ID: child-1",
      "",
      "Verdict: REVISE",
      "Findings:",
      "- A fixture não alcança o comportamento aprovado.",
    ].join("\n"))),
    "PARECER: REVISAR · A fixture não alcança o comportamento aprovado.",
  );
  assert.equal(
    testApi.summarizeHarnessSubagentResult(result("completed", "harness-plan-reviewer", "APPROVE")),
    "PARECER: INDISPONÍVEL · expanda para ver a saída",
  );
  assert.equal(
    testApi.summarizeHarnessSubagentResult(result("completed", "harness-plan-reviewer", JSON.stringify({
      verdict: "APPROVE",
      findings: [{
        area: "scope", severity: "high", task_id: "task-2",
        problem: "O escopo ainda está incorreto.",
        planner_instruction: "Corrija o escopo.",
      }],
    }))),
    "PARECER: INDISPONÍVEL · aprovação contradiz os achados reportados",
  );
  assert.equal(
    testApi.summarizeHarnessSubagentResult(result("completed", "harness-plan-reviewer", [
      '{"verdict":"APPROVE","findings":[]}',
      '{"verdict":"REVISE","findings":[{"area":"scope","severity":"high","task_id":"task-2","problem":"Conflito.","planner_instruction":"Corrija."}]}',
    ].join("\n"))),
    "PARECER: INDISPONÍVEL · expanda para ver a saída",
  );
  assert.equal(
    testApi.summarizeHarnessSubagentResult(result("aborted", "harness-test-reviewer", "Verdict: APPROVE")),
    null,
  );
});

test("collapsed cards summarize the remaining harness roles from their existing public result", async () => {
  const { testApi } = await createJiti(import.meta.url, { moduleCache: false, tsconfigPaths: true })
    .import(ENTRY);
  const completed = (subagentType, text) => ({
    content: [{ type: "text", text }],
    details: { status: "completed", subagentType },
  });
  const envelope = (body) => `Agent completed in 2.0s (3 tool uses).\nAgent ID: child-1\n\n${body}`;

  for (const role of ["harness-executor", "harness-test-author", "harness-sniper", "harness-shipper"]) {
    assert.equal(
      testApi.summarizeHarnessSubagentResult(completed(role, envelope("Corrigi o limite observado e rodei a suíte focal.\nStatus: DONE"))),
      "STATUS: DONE · Corrigi o limite observado e rodei a suíte focal.",
    );
  }
  assert.equal(
    testApi.summarizeHarnessSubagentResult(completed("harness-harvester", envelope(
      '[HARNESS_HARVEST_RESULT]{"changes":[{"path":"MEMORY.md"},{"path":"kaizen.md"}]}[/HARNESS_HARVEST_RESULT]',
    ))),
    "HARVEST · 2 deltas propostos",
  );
  assert.equal(
    testApi.summarizeHarnessSubagentResult(completed("harness-discussion-adversary", envelope(
      "A proposta ainda não demonstra a fronteira de autorização.",
    ))),
    "RESULTADO · A proposta ainda não demonstra a fronteira de autorização.",
  );
  assert.equal(
    testApi.summarizeHarnessSubagentResult(completed("external-helper", "Status: DONE")),
    null,
  );
});
