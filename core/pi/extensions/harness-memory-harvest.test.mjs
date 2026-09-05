/**
 * @description Regressões do recibo host-owned de harvest. O harvester apenas propõe
 * deltas; estes testes provam que o host captura a revisão, valida preimages e só libera
 * revisão final/finalize quando o Git contém exatamente os documentos propostos.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import harnessMemory from "./harness-memory.ts";

const SESSION = "ses-harvest-parent";
const FEATURE = "pi-memory-harvest";
const BASE_TASK = { id: "task-1", scope_paths: ["src/app.ts"] };

function register() {
  const handlers = new Map();
  let tool;
  harnessMemory(/** @type {any} */ ({
    on(name, handler) {
      handlers.set(name, handler);
    },
    registerTool(definition) {
      tool = definition;
    },
  }));
  for (const eventName of ["tool_execution_start", "tool_execution_end", "tool_call"]) {
    assert.equal(typeof handlers.get(eventName), "function", `faltou registrar ${eventName}`);
  }
  assert.equal(tool?.name, "harness_memory");
  return {
    handlers,
    execute(params, runtime) {
      return tool.execute("memory-call", params, new AbortController().signal, () => {}, runtime);
    },
  };
}

function fixture(t, { omit = [] } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-memory-harvest-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(join(root, ".gitignore"), ".pi/harness/\nnode_modules/\n", "utf8");
  const files = {
    "MEMORY.md": "memória anterior\n",
    "CONTEXT.md": "contexto anterior\n",
    "kaizen.md": "kaizen anterior\n",
  };
  for (const [name, content] of Object.entries(files)) {
    if (!omit.includes(name)) writeFileSync(join(root, name), content, "utf8");
  }
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "app.ts"), "export const value = 1;\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: root });
  commit(root, "fixture");
  mkdirSync(join(root, ".pi", "harness", "state", SESSION), { recursive: true });
  writeFileSync(
    join(root, ".pi", "harness", "state", SESSION, "gate-state.json"),
    JSON.stringify({ session_id: SESSION, feature_id: FEATURE, classified: true, mode: "FULL" }),
    "utf8",
  );
  writePlan(root, { feature_id: FEATURE, tasks: [BASE_TASK] });
  return root;
}

function commit(root, message) {
  execFileSync(
    "git",
    ["-c", "user.name=Pi Harvest", "-c", "user.email=pi-harvest@example.test", "commit", "-q", "-m", message],
    { cwd: root },
  );
  return head(root);
}

function head(root) {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}

function sha256(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function harvestPath(root, sessionId = SESSION) {
  return join(root, ".pi", "harness", "state", sessionId, "memory-harvest.json");
}

function shipmentPath(root, sessionId = SESSION) {
  return join(root, ".pi", "harness", "state", sessionId, "memory-shipment.json");
}

function finalizedPath(root, sessionId = SESSION) {
  return join(root, ".pi", "harness", "state", sessionId, "memory-finalized.json");
}

function planPath(root) {
  return join(root, ".pi", "harness", "plans", FEATURE, "execution-plan.json");
}

function readPlan(root) {
  return JSON.parse(readFileSync(planPath(root), "utf8"));
}

function writePlan(root, plan) {
  mkdirSync(join(root, ".pi", "harness", "plans", FEATURE), { recursive: true });
  writeFileSync(planPath(root), JSON.stringify(plan, null, 2), "utf8");
}

function appendDocumentationTask(root, scopePaths, overrides = {}) {
  const plan = readPlan(root);
  plan.tasks.push({
    id: "harvest-memory-docs",
    scope_paths: scopePaths,
    no_tests: true,
    locked_tests: [],
    depends_on: plan.tasks.map(({ id }) => id),
    ...overrides,
  });
  writePlan(root, plan);
}

function ctx(root, { sessionId = SESSION, child = false } = {}) {
  return {
    cwd: root,
    sessionManager: {
      getSessionId: () => sessionId,
      getHeader: () => (child ? { parentSession: SESSION } : {}),
    },
  };
}

function harvestArgs(overrides = {}) {
  return {
    subagent_type: "harness-harvester",
    description: "collect verified learnings",
    prompt: "[HARNESS_HARVEST]\nInspect verified evidence and propose durable deltas.",
    ...overrides,
  };
}

function resultEnvelope(changes, { trailing = "", malformed = false } = {}) {
  if (malformed) return "Harvest complete.\n[HARNESS_HARVEST_RESULT]{broken[/HARNESS_HARVEST_RESULT]";
  return `Harvest complete.\n[HARNESS_HARVEST_RESULT]${JSON.stringify({ changes })}[/HARNESS_HARVEST_RESULT]${trailing}`;
}

function emitHarvest(api, root, {
  changes = [],
  args = harvestArgs(),
  sessionId = SESSION,
  child = false,
  isError = false,
  status = "completed",
  agentId = "agent-harvester",
  text = resultEnvelope(changes),
  callId = "harvest-call",
} = {}) {
  const runtime = ctx(root, { sessionId, child });
  api.handlers.get("tool_execution_start")(
    { toolName: "subagent", toolCallId: callId, args },
    runtime,
  );
  api.handlers.get("tool_execution_end")(
    {
      toolName: "subagent",
      toolCallId: callId,
      result: {
        content: [{ type: "text", text }],
        details: { status, agentId },
      },
      isError,
    },
    runtime,
  );
}

function emitShipper(api, root, {
  isError = false,
  status = "completed",
  agentId = "agent-shipper",
  text = "Delivery published.\nStatus: DONE",
  callId = "shipper-call",
} = {}) {
  const runtime = ctx(root);
  const args = {
    subagent_type: "harness-shipper",
    description: "publish reviewed delivery",
    prompt: "Publish the reviewed commit series.",
  };
  api.handlers.get("tool_execution_start")(
    { toolName: "subagent", toolCallId: callId, args },
    runtime,
  );
  api.handlers.get("tool_execution_end")(
    {
      toolName: "subagent",
      toolCallId: callId,
      result: { content: [{ type: "text", text }], details: { status, agentId } },
      isError,
    },
    runtime,
  );
}

async function readMemory(api, root, options) {
  const result = await api.execute({ action: "read" }, ctx(root, options));
  assert.equal(result?.details?.ok, true);
  assert.notEqual(result?.isError, true);
  return result;
}

async function assertNoReceipt(api, root, options) {
  const result = await readMemory(api, root, options);
  assert.equal(result.details.harvestReceipt == null, true);
}

function finalReviewEvent() {
  return {
    toolName: "subagent",
    toolCallId: "final-review-call",
    input: {
      subagent_type: "harness-adversary",
      description: "final review",
      prompt: "[HARNESS_FINAL_REVIEW]\nReview the aggregate diff.",
    },
  };
}

test("a failed replacement harvest cannot reuse the previous successful receipt", async (t) => {
  const root = fixture(t);
  const api = register();
  emitHarvest(api, root);
  assert.equal(api.handlers.get("tool_call")(finalReviewEvent(), ctx(root)), undefined);
  emitHarvest(api, root, { callId: "replacement", isError: true, status: "failed" });
  await assertBlocked(api.handlers.get("tool_call")(finalReviewEvent(), ctx(root)));
});

function finalMarkEvent() {
  return { toolName: "mark", toolCallId: "mark-final", input: { action: "final-review" } };
}

function shipperEvent(prompt = "Publish the reviewed commit series.") {
  return {
    toolName: "subagent",
    toolCallId: "shipper-gate-call",
    input: {
      subagent_type: "harness-shipper",
      description: "publish reviewed delivery",
      prompt,
    },
  };
}

async function assertBlocked(decision) {
  assert.equal(decision?.block, true);
  assert.equal(typeof decision?.reason, "string");
  assert.ok(decision.reason.length > 0);
}

function seedFinalReviewState(root, reviewedHead = head(root)) {
  const receipt = (role, suffix) => ({
    written_by: "host-subagent-completion",
    parent_session_id: SESSION,
    feature_id: FEATURE,
    role,
    dispatch_call_id: `final-${suffix}`,
    child_session_id: `child-${suffix}`,
    agent_id: `agent-${suffix}`,
    status: "completed",
    reviewed_head_sha: reviewedHead,
  });
  writeFileSync(
    join(root, ".pi", "harness", "state", SESSION, "gate-state.json"),
    JSON.stringify({
      session_id: SESSION,
      feature_id: FEATURE,
      classified: true,
      mode: "FULL",
      final_review_done: true,
      final_review_evidence: {
        adversary: receipt("harness-adversary", "adversary"),
        compliance: receipt("harness-compliance", "compliance"),
      },
    }),
    "utf8",
  );
}

test("tracked vendored tooling is never excluded from the clean-tree requirement", async (t) => {
  for (const mode of ["unstaged", "staged", "staged-then-restored"]) {
    await t.test(mode, async (st) => {
      const root = fixture(st);
      const file = join(root, ".pi", "harness", "lib", "gate.mjs");
      mkdirSync(join(root, ".pi", "harness", "lib"), { recursive: true });
      writeFileSync(file, "export const allow = false;\n");
      execFileSync("git", ["add", "-f", ".pi/harness/lib/gate.mjs"], { cwd: root });
      commit(root, "fixture vendored tooling");
      const api = register();
      await api.execute({ action: "update", content: "preserve until verified" }, ctx(root));
      emitHarvest(api, root);
      seedFinalReviewState(root);
      emitShipper(api, root);
      writeFileSync(file, "export const allow = true;\n");
      if (mode !== "unstaged") execFileSync("git", ["add", "-f", ".pi/harness/lib/gate.mjs"], { cwd: root });
      if (mode === "staged-then-restored") writeFileSync(file, "export const allow = false;\n");
      await assertBlocked(await api.handlers.get("tool_call")({ toolName: "subagent", input: harvestArgs() }, ctx(root)));
      await assertBlocked(await api.handlers.get("tool_call")(finalReviewEvent(), ctx(root)));
      assert.equal((await api.execute({ action: "finalize" }, ctx(root))).details.ok, false);
      assert.equal(existsSync(join(root, ".pi", "harness", "state", SESSION, "shared_context.md")), true);
    });
  }
});

test("only generated Pi directories are exempt; new vendored tooling blocks harvest", async (t) => {
  const root = fixture(t);
  writeFileSync(join(root, ".gitignore"), ".pi/harness/state/\n.pi/harness/plans/\n.pi/harness/runtime/\n.pi/harness/sessions/\nnode_modules/\n");
  execFileSync("git", ["add", ".gitignore"], { cwd: root });
  commit(root, "fixture precise vendor ignores");
  const api = register();
  await api.execute({ action: "update", content: "generated context" }, ctx(root));
  const event = { toolName: "subagent", input: harvestArgs() };
  assert.equal(await api.handlers.get("tool_call")(event, ctx(root)), undefined);
  mkdirSync(join(root, ".pi", "harness", "extensions"), { recursive: true });
  writeFileSync(join(root, ".pi", "harness", "extensions", "new.ts"), "export default () => {};\n");
  await assertBlocked(await api.handlers.get("tool_call")(event, ctx(root)));
});

test("harvest refuses an append whose result would exceed the durable read limit", async (t) => {
  const root = fixture(t);
  const original = "m".repeat(1024 * 1024);
  writeFileSync(join(root, "MEMORY.md"), original);
  execFileSync("git", ["add", "MEMORY.md"], { cwd: root });
  commit(root, "fixture memory at supported limit");
  const api = register();
  emitHarvest(api, root, { changes: [{ path: "MEMORY.md", before_sha256: sha256(original), append: "\nnew fact\n", evidence: "verified", invalidation: "recheck" }] });
  await assertNoReceipt(api, root);
});

test("harness-memory harvest: read expõe documentos duráveis com hash e o recibo host-owned da sessão", async (t) => {
  const root = fixture(t);
  const api = register();
  emitHarvest(api, root);

  const restarted = register();
  const read = await readMemory(restarted, root);
  assert.equal(Array.isArray(read.details.durableFiles), true);
  assert.deepEqual(
    read.details.durableFiles.map(({ path }) => path).sort(),
    ["CONTEXT.md", "MEMORY.md", "kaizen.md"],
  );
  for (const file of read.details.durableFiles) {
    const actual = readFileSync(join(root, file.path), "utf8");
    assert.equal(file.content, actual);
    assert.equal(file.sha256, sha256(actual));
    assert.equal(file.truncated, false);
  }
  assert.equal(read.details.harvestReceipt?.parent_session_id, SESSION);
  assert.equal(read.details.harvestReceipt?.feature_id, FEATURE);
  assert.deepEqual(read.details.harvestReceipt?.changes, []);
  await assertNoReceipt(restarted, root, { sessionId: "ses-harvest-other" });
  await assertBlocked(
    await restarted.handlers.get("tool_call")(finalReviewEvent(), ctx(root, { sessionId: "ses-harvest-other" })),
  );
});

test("harness-memory harvest: read limita conteúdo durável, mas calcula hash sobre o arquivo completo", async (t) => {
  const root = fixture(t);
  const fullByPath = new Map();
  for (const [name, unit] of [["MEMORY.md", "M"], ["CONTEXT.md", "C"], ["kaizen.md", "K"]]) {
    const content = `${name}\n${unit.repeat(20_000)}`;
    fullByPath.set(name, content);
    writeFileSync(join(root, name), content, "utf8");
  }
  execFileSync("git", ["add", "MEMORY.md", "CONTEXT.md", "kaizen.md"], { cwd: root });
  commit(root, "docs: add large durable context");
  const read = await readMemory(register(), root);

  assert.ok(
    Buffer.byteLength(read.details.durableFiles.map(({ content }) => content).join(""), "utf8") <= 24_576,
  );
  for (const file of read.details.durableFiles) {
    const full = fullByPath.get(file.path);
    assert.equal(file.truncated, true);
    assert.equal(file.sha256, sha256(full));
    assert.ok(Buffer.byteLength(file.content, "utf8") < Buffer.byteLength(full, "utf8"));
  }
});

test("harness-memory harvest: append pequeno atualiza arquivo durável grande sem copiar o preimage truncado", async (t) => {
  const root = fixture(t);
  const before = `# Memória extensa\n${"M".repeat(8_000)}`;
  const append = "\n\nNovo aprendizado pequeno e verificado.\n";
  writeFileSync(join(root, "MEMORY.md"), before, "utf8");
  execFileSync("git", ["add", "MEMORY.md"], { cwd: root });
  commit(root, "docs: seed large memory");
  const api = register();
  const bounded = await readMemory(api, root);
  const memory = bounded.details.durableFiles.find(({ path }) => path === "MEMORY.md");
  assert.equal(memory.truncated, true);
  assert.equal(memory.sha256, sha256(before));

  emitHarvest(api, root, {
    changes: [{
      path: "MEMORY.md",
      before_sha256: sha256(before),
      append,
      evidence: "regressão integrada confirmada",
      invalidation: "remover quando o contrato deixar de existir",
    }],
  });
  const receipt = (await readMemory(api, root)).details.harvestReceipt;
  assert.equal(receipt.changes[0].append, append);
  assert.equal(Object.hasOwn(receipt.changes[0], "content"), false);

  writeFileSync(join(root, "MEMORY.md"), before + append, "utf8");
  execFileSync("git", ["add", "MEMORY.md"], { cwd: root });
  commit(root, "docs: append harvested learning");
  appendDocumentationTask(root, ["MEMORY.md"]);
  assert.equal(await api.handlers.get("tool_call")(finalReviewEvent(), ctx(root)), undefined);
});

test("harness-memory harvest: só aceita subagent harvester pai com marcador na primeira linha", async (t) => {
  const cases = [
    { label: "papel errado", args: harvestArgs({ subagent_type: "harness-adversary" }) },
    { label: "marcador fora da primeira linha", args: harvestArgs({ prompt: "intro\n[HARNESS_HARVEST]" }) },
    { label: "sessão filha", child: true, sessionId: "ses-harvest-child" },
  ];
  for (const [index, item] of cases.entries()) {
    await t.test(item.label, async (st) => {
      const root = fixture(st);
      const api = register();
      emitHarvest(api, root, {
        args: item.args,
        child: item.child,
        sessionId: item.sessionId,
        callId: `invalid-origin-${index}`,
      });
      await assertNoReceipt(api, root);
    });
  }
});

test("harness-memory harvest: erro nativo ou envelope não terminal não produz recibo", async (t) => {
  const cases = [
    { label: "erro nativo mesmo com status completed", isError: true, status: "completed" },
    { label: "status terminal não completed", status: "error" },
    { label: "agentId ausente", agentId: "" },
    { label: "JSON malformado", text: resultEnvelope([], { malformed: true }) },
    { label: "texto depois do envelope", text: resultEnvelope([], { trailing: "\nconteúdo posterior" }) },
  ];
  for (const [index, item] of cases.entries()) {
    await t.test(item.label, async (st) => {
      const root = fixture(st);
      const api = register();
      emitHarvest(api, root, { ...item, callId: `invalid-result-${index}` });
      await assertNoReceipt(api, root);
    });
  }
});

test("harness-memory harvest: path fora da allowlist ou preimage divergente invalida o recibo inteiro", async (t) => {
  const memoryBefore = "memória anterior\n";
  const invalidChanges = [
    [{ path: "src/app.ts", before_sha256: sha256("export const value = 1;\n"), content: "produto alterado", evidence: "e", invalidation: "i" }],
    [{ path: "MEMORY.md", before_sha256: "0".repeat(64), content: "nova memória", evidence: "e", invalidation: "i" }],
    [{ path: "MEMORY.md", before_sha256: sha256(memoryBefore), content: "nova memória", evidence: "e" }],
    [{ path: "MEMORY.md", before_sha256: sha256(memoryBefore), content: "nova memória", append: "mais", evidence: "e", invalidation: "i" }],
  ];
  for (const [index, changes] of invalidChanges.entries()) {
    await t.test(`payload inválido ${index + 1}`, async (st) => {
      const root = fixture(st);
      const api = register();
      emitHarvest(api, root, { changes, callId: `invalid-change-${index}` });
      await assertNoReceipt(api, root);
    });
  }
});

test("harness-memory harvest: revisão final e mark são bloqueados sem recibo e liberados por zero delta atual", async (t) => {
  const root = fixture(t);
  const api = register();
  const runtime = ctx(root);
  await assertBlocked(await api.handlers.get("tool_call")(finalReviewEvent(), runtime));
  await assertBlocked(await api.handlers.get("tool_call")(finalMarkEvent(), runtime));

  emitHarvest(api, root);
  assert.equal(await api.handlers.get("tool_call")(finalReviewEvent(), runtime), undefined);
  assert.equal(await api.handlers.get("tool_call")(finalMarkEvent(), runtime), undefined);
});

test("harness-memory harvest: zero delta exige que o plano continue semanticamente idêntico", async (t) => {
  const root = fixture(t);
  const api = register();
  emitHarvest(api, root);
  const tampered = readPlan(root);
  tampered.tasks[0].scope_paths = ["src/other.ts"];
  writePlan(root, tampered);

  await assertBlocked(await api.handlers.get("tool_call")(finalReviewEvent(), ctx(root)));
});

test("harness-memory harvest: recibo persistido malformado volta a bloquear a revisão final", async (t) => {
  const root = fixture(t);
  const api = register();
  emitHarvest(api, root);
  assert.equal(existsSync(harvestPath(root)), true);
  writeFileSync(harvestPath(root), JSON.stringify({ changes: [] }), "utf8");

  await assertBlocked(await api.handlers.get("tool_call")(finalReviewEvent(), ctx(root)));
});

test("harness-memory harvest: delta de documento existente só libera após conteúdo exato ser commitado", async (t) => {
  const root = fixture(t);
  const api = register();
  const before = readFileSync(join(root, "MEMORY.md"), "utf8");
  const proposed = "# Memória curada\n\nPadrão verificado.\n";
  emitHarvest(api, root, {
    changes: [{
      path: "MEMORY.md",
      before_sha256: sha256(before),
      content: proposed,
      evidence: "teste integrado confirmou o padrão",
      invalidation: "remover se o contrato mudar",
    }],
  });

  await assertBlocked(await api.handlers.get("tool_call")(finalReviewEvent(), ctx(root)));
  writeFileSync(join(root, "MEMORY.md"), proposed, "utf8");
  execFileSync("git", ["add", "MEMORY.md"], { cwd: root });
  commit(root, "docs: persist harvested memory");
  appendDocumentationTask(root, ["MEMORY.md"]);
  assert.equal(await api.handlers.get("tool_call")(finalReviewEvent(), ctx(root)), undefined);
});

test("harness-memory harvest: arquivo antes ausente aceita preimage null e conteúdo completo commitado", async (t) => {
  const root = fixture(t, { omit: ["CONTEXT.md"] });
  const api = register();
  const proposed = "# Glossário\n\nTermo: definição verificada.\n";
  emitHarvest(api, root, {
    changes: [{
      path: "CONTEXT.md",
      before_sha256: null,
      content: proposed,
      evidence: "o domínio usa este termo",
      invalidation: "revisar se o domínio renomear o termo",
    }],
  });
  writeFileSync(join(root, "CONTEXT.md"), proposed, "utf8");
  execFileSync("git", ["add", "CONTEXT.md"], { cwd: root });
  commit(root, "docs: add harvested context");
  appendDocumentationTask(root, ["CONTEXT.md"]);

  assert.equal(await api.handlers.get("tool_call")(finalMarkEvent(), ctx(root)), undefined);
});

test("harness-memory harvest: conteúdo persistido diferente da proposta continua bloqueado", async (t) => {
  const root = fixture(t);
  const api = register();
  const before = readFileSync(join(root, "kaizen.md"), "utf8");
  emitHarvest(api, root, {
    changes: [{
      path: "kaizen.md",
      before_sha256: sha256(before),
      content: "proposta exata\n",
      evidence: "ocorrência repetida",
      invalidation: "revisar após mudança de processo",
    }],
  });
  writeFileSync(join(root, "kaizen.md"), "texto parecido, mas não proposto\n", "utf8");
  execFileSync("git", ["add", "kaizen.md"], { cwd: root });
  commit(root, "docs: persist wrong content");

  await assertBlocked(await api.handlers.get("tool_call")(finalReviewEvent(), ctx(root)));
});

test("harness-memory harvest: tarefa documental não pode reescrever o plano nem ampliar o delta", async (t) => {
  const mutations = [
    ["remove tarefa anterior", (plan) => { plan.tasks = plan.tasks.slice(1); }],
    ["edita tarefa anterior", (plan) => { plan.tasks[0].scope_paths = ["src/other.ts"]; }],
    ["adiciona scope estranho", (plan) => { plan.tasks[1].scope_paths.push("CONTEXT.md"); }],
    ["inventa dependência", (plan) => { plan.tasks[1].depends_on.push("task-inexistente"); }],
    ["adiciona duas tarefas", (plan) => { plan.tasks.push({ ...plan.tasks[1], id: "harvest-memory-docs-2" }); }],
  ];
  for (const [label, mutate] of mutations) {
    await t.test(label, async (st) => {
      const root = fixture(st);
      const api = register();
      const before = readFileSync(join(root, "MEMORY.md"), "utf8");
      const proposed = "memória proposta para validar plano\n";
      emitHarvest(api, root, {
        changes: [{
          path: "MEMORY.md",
          before_sha256: sha256(before),
          content: proposed,
          evidence: "evidência verificada",
          invalidation: "revalidar se a tarefa mudar",
        }],
      });
      writeFileSync(join(root, "MEMORY.md"), proposed, "utf8");
      execFileSync("git", ["add", "MEMORY.md"], { cwd: root });
      commit(root, "docs: persist proposed memory");
      appendDocumentationTask(root, ["MEMORY.md"]);
      const plan = readPlan(root);
      mutate(plan);
      writePlan(root, plan);

      await assertBlocked(await api.handlers.get("tool_call")(finalReviewEvent(), ctx(root)));
    });
  }
});

test("harness-memory harvest: worktree suja ou commit de código posterior invalida a revisão", async (t) => {
  await t.test("worktree suja", async (st) => {
    const root = fixture(st);
    const api = register();
    emitHarvest(api, root);
    writeFileSync(join(root, "src", "app.ts"), "export const value = 2;\n", "utf8");
    await assertBlocked(await api.handlers.get("tool_call")(finalReviewEvent(), ctx(root)));
  });

  await t.test("código commitado", async (st) => {
    const root = fixture(st);
    const api = register();
    emitHarvest(api, root);
    writeFileSync(join(root, "src", "app.ts"), "export const value = 3;\n", "utf8");
    execFileSync("git", ["add", "src/app.ts"], { cwd: root });
    commit(root, "feat: change code after harvest");
    await assertBlocked(await api.handlers.get("tool_call")(finalMarkEvent(), ctx(root)));
  });
});

test("harness-memory harvest: snapshot do HEAD vem do início do dispatch, antes de qualquer corrida", async (t) => {
  const root = fixture(t);
  const api = register();
  const runtime = ctx(root);
  const args = harvestArgs();
  api.handlers.get("tool_execution_start")(
    { toolName: "subagent", toolCallId: "harvest-race", args },
    runtime,
  );
  writeFileSync(join(root, "src", "app.ts"), "export const value = 4;\n", "utf8");
  execFileSync("git", ["add", "src/app.ts"], { cwd: root });
  commit(root, "feat: concurrent code change");
  api.handlers.get("tool_execution_end")(
    {
      toolName: "subagent",
      toolCallId: "harvest-race",
      result: {
        content: [{ type: "text", text: resultEnvelope([]) }],
        details: { status: "completed", agentId: "agent-harvester" },
      },
      isError: false,
    },
    runtime,
  );

  await assertBlocked(await api.handlers.get("tool_call")(finalReviewEvent(), runtime));
});

test("harness-memory shipment: bloqueia publicação antes da revisão final host-owned e libera o HEAD atual", async (t) => {
  const root = fixture(t);
  const api = register();
  const runtime = ctx(root);
  emitHarvest(api, root);

  await assertBlocked(await api.handlers.get("tool_call")(shipperEvent(), runtime));
  await assertBlocked(
    await api.handlers.get("tool_call")(shipperEvent("This is a metadata-only release stage; publish it."), runtime),
  );
  seedFinalReviewState(root);
  assert.equal(await api.handlers.get("tool_call")(shipperEvent(), runtime), undefined);
});

test("harness-memory shipment: HEAD alterado ou worktree suja bloqueiam antes do shipper publicar", async (t) => {
  await t.test("HEAD alterado", async (st) => {
    const root = fixture(st);
    const api = register();
    emitHarvest(api, root);
    seedFinalReviewState(root);
    writeFileSync(join(root, "src", "app.ts"), "export const value = 77;\n", "utf8");
    execFileSync("git", ["add", "src/app.ts"], { cwd: root });
    commit(root, "feat: move head before shipment");

    await assertBlocked(await api.handlers.get("tool_call")(shipperEvent(), ctx(root)));
  });

  await t.test("worktree suja", async (st) => {
    const root = fixture(st);
    const api = register();
    emitHarvest(api, root);
    seedFinalReviewState(root);
    writeFileSync(join(root, "src", "app.ts"), "export const value = 78;\n", "utf8");

    await assertBlocked(await api.handlers.get("tool_call")(shipperEvent(), ctx(root)));
  });
});

test("harness-memory shipment: start/end direto sem revisão final não cria recibo válido", async (t) => {
  const root = fixture(t);
  const api = register();
  emitHarvest(api, root);
  emitShipper(api, root);

  assert.equal(existsSync(shipmentPath(root)), false);
});

test("harness-memory shipment: finalize preserva o contexto sem término nativo DONE do shipper", async (t) => {
  const cases = [
    ["shipper ausente", null],
    ["erro nativo", { isError: true }],
    ["status interrompido", { status: "error" }],
    ["agentId ausente", { agentId: "" }],
    ["terminal sem DONE", { text: "Delivery stopped before publication." }],
    ["DONE não terminal", { text: "Status: DONE\ntexto posterior" }],
    ["status alternativo", { text: "Status: DONE_WITH_CONCERNS" }],
    ["retry falho invalida receipt anterior", { priorSuccess: true, isError: true, callId: "shipper-retry" }],
  ];
  for (const [label, shipment] of cases) {
    await t.test(label, async (st) => {
      const root = fixture(st);
      const api = register();
      const updated = await api.execute({ action: "update", content: "reter sem shipment válido" }, ctx(root));
      assert.equal(updated?.details?.ok, true);
      emitHarvest(api, root);
      seedFinalReviewState(root);
      if (shipment?.priorSuccess) emitShipper(api, root, { callId: "shipper-first" });
      if (shipment) emitShipper(api, root, shipment);

      const finalized = await api.execute({ action: "finalize" }, ctx(root));
      assert.equal(finalized?.details?.ok, false);
      assert.equal(finalized?.isError, true);
      assert.equal(
        readFileSync(join(root, ".pi", "harness", "state", SESSION, "shared_context.md"), "utf8"),
        "reter sem shipment válido",
      );
    });
  }
});

test("harness-memory harvest: finalize exige o recibo mesmo com os dois olhos finais atuais", async (t) => {
  const root = fixture(t);
  const api = register();
  const update = await api.execute({ action: "update", content: "reter sem harvest" }, ctx(root));
  assert.equal(update?.details?.ok, true);
  emitHarvest(api, root);
  seedFinalReviewState(root);
  emitShipper(api, root);
  assert.equal(existsSync(shipmentPath(root)), true);
  rmSync(harvestPath(root));

  const finalized = await api.execute({ action: "finalize" }, ctx(root));
  assert.equal(finalized?.details?.ok, false);
  assert.equal(finalized?.isError, true);
  assert.equal(readFileSync(join(root, ".pi", "harness", "state", SESSION, "shared_context.md"), "utf8"), "reter sem harvest");
});

test("harness-memory finalize: ausência de payload runtime sem tombstone nunca prova conclusão", async (t) => {
  const root = fixture(t);
  const api = register();
  emitHarvest(api, root);
  seedFinalReviewState(root);
  emitShipper(api, root);
  assert.equal(existsSync(shipmentPath(root)), true);
  rmSync(harvestPath(root));
  rmSync(shipmentPath(root));
  assert.equal(existsSync(harvestPath(root)), false);
  assert.equal(existsSync(join(root, ".pi", "harness", "state", SESSION, "shared_context.md")), false);
  assert.equal(existsSync(finalizedPath(root)), false);

  const finalized = await api.execute({ action: "finalize" }, ctx(root));
  assert.equal(finalized?.details?.ok, false);
  assert.equal(finalized?.isError, true);
  assert.equal(existsSync(finalizedPath(root)), false);
});

test("harness-memory harvest: finalize aceita delta exato revisado e remove recibo e diário runtime", async (t) => {
  const root = fixture(t);
  const api = register();
  const before = readFileSync(join(root, "MEMORY.md"), "utf8");
  const proposed = "memória final colhida\n";
  emitHarvest(api, root, {
    changes: [{
      path: "MEMORY.md",
      before_sha256: sha256(before),
      content: proposed,
      evidence: "evidência verificada",
      invalidation: "invalidar se o teste deixar de cobrir",
    }],
  });
  writeFileSync(join(root, "MEMORY.md"), proposed, "utf8");
  execFileSync("git", ["add", "MEMORY.md"], { cwd: root });
  commit(root, "docs: persist final harvest");
  appendDocumentationTask(root, ["MEMORY.md"]);
  await api.execute({ action: "update", content: "diário a descartar" }, ctx(root));
  seedFinalReviewState(root);
  emitShipper(api, root);
  assert.equal(existsSync(shipmentPath(root)), true);

  const finalized = await api.execute({ action: "finalize" }, ctx(root));
  assert.equal(finalized?.details?.ok, true);
  assert.notEqual(finalized?.isError, true);
  assert.equal(existsSync(join(root, ".pi", "harness", "state", SESSION, "shared_context.md")), false);
  assert.equal(existsSync(harvestPath(root)), false);
  assert.equal(existsSync(shipmentPath(root)), false);
  assert.equal(readFileSync(join(root, "MEMORY.md"), "utf8"), proposed);

  const tombstone = JSON.parse(readFileSync(finalizedPath(root), "utf8"));
  assert.deepEqual(Object.keys(tombstone).sort(), ["feature_id", "finalized_at", "head", "session_id"]);
  assert.equal(tombstone.session_id, SESSION);
  assert.equal(tombstone.feature_id, FEATURE);
  assert.equal(tombstone.head, head(root));
  assert.equal(typeof tombstone.finalized_at, "string");

  const after = await readMemory(api, root);
  assert.equal(after.details.harvestReceipt == null, true);
});

test("harness-memory finalize: replay exige tombstone compatível, revisão atual e worktree limpa", async (t) => {
  await t.test("worktree suja", async (st) => {
    const root = fixture(st);
    const api = register();
    await api.execute({ action: "update", content: "diário finalizado" }, ctx(root));
    emitHarvest(api, root);
    seedFinalReviewState(root);
    emitShipper(api, root);
    assert.equal((await api.execute({ action: "finalize" }, ctx(root))).details.ok, true);
    writeFileSync(join(root, "src", "app.ts"), "export const value = 99;\n", "utf8");

    const replay = await api.execute({ action: "finalize" }, ctx(root));
    assert.equal(replay?.details?.ok, false);
    assert.equal(replay?.isError, true);
  });

  await t.test("revisão final deixou de corresponder ao tombstone", async (st) => {
    const root = fixture(st);
    const api = register();
    await api.execute({ action: "update", content: "diário finalizado" }, ctx(root));
    emitHarvest(api, root);
    seedFinalReviewState(root);
    emitShipper(api, root);
    assert.equal((await api.execute({ action: "finalize" }, ctx(root))).details.ok, true);
    const gatePath = join(root, ".pi", "harness", "state", SESSION, "gate-state.json");
    const state = JSON.parse(readFileSync(gatePath, "utf8"));
    state.final_review_evidence.adversary.reviewed_head_sha = "0".repeat(40);
    writeFileSync(gatePath, JSON.stringify(state), "utf8");

    const replay = await api.execute({ action: "finalize" }, ctx(root));
    assert.equal(replay?.details?.ok, false);
    assert.equal(replay?.isError, true);
  });
});
