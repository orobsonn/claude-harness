/**
 * @description Testes travados da extensão Pi harness-context-files — adaptador fino sobre
 * `collectProjectContext` (core/pi/lib/context-files.mjs). Cobre o contrato do host: injeta em
 * TODO `before_agent_start` da sessão pai (o Pi reconstrói o prompt do zero a cada turno), lê o
 * disco uma única vez por sessão, é no-op em sessão filha e nunca lança.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import harnessContextFiles from "./harness-context-files.ts";

/** @description Registra a extensão contra um fake de ExtensionAPI e devolve os handlers. */
function register() {
  const handlers = {};
  harnessContextFiles({
    on(eventName, fn) {
      handlers[eventName] = fn;
    },
  });
  assert.equal(typeof handlers.before_agent_start, "function");
  assert.equal(typeof handlers.session_start, "function");
  return handlers;
}

/** @description Cria um projeto temporário com `.git` e devolve seu caminho (limpo no fim do teste). */
function makeProject(t) {
  const root = mkdtempSync(join(tmpdir(), "pi-context-files-"));
  mkdirSync(join(root, ".git"), { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const parentCtx = (cwd) => ({ cwd, sessionManager: { getHeader: () => ({}) } });
const childCtx = (cwd) => ({ cwd, sessionManager: { getHeader: () => ({ parentSession: "s-pai" }) } });
const event = { systemPrompt: "PROMPT BASE" };

test("harness-context-files: injeta em TODO turno, encadeando sobre o systemPrompt da vez", async (t) => {
  const root = makeProject(t);
  writeFileSync(join(root, "AGENTS.md"), "convenções do projeto");
  const { before_agent_start: onStart } = register();

  const first = await onStart(event, parentCtx(root));
  assert.match(first.systemPrompt, /^PROMPT BASE/);
  assert.match(first.systemPrompt, /<project-context files="AGENTS\.md">/);
  assert.match(first.systemPrompt, /convenções do projeto/);

  // Segundo turno: o Pi volta à base quando ninguém devolve systemPrompt — a injeção precisa
  // acontecer de novo, senão o contexto do projeto some a partir do 2º turno.
  const second = await onStart({ systemPrompt: "PROMPT BASE + OUTRA EXTENSÃO" }, parentCtx(root));
  assert.match(second.systemPrompt, /^PROMPT BASE \+ OUTRA EXTENSÃO/);
  assert.match(second.systemPrompt, /convenções do projeto/);
});

test("harness-context-files: lê o disco uma única vez por sessão", async (t) => {
  const root = makeProject(t);
  writeFileSync(join(root, "AGENTS.md"), "conteúdo original");
  const { before_agent_start: onStart } = register();

  await onStart(event, parentCtx(root));
  writeFileSync(join(root, "AGENTS.md"), "conteúdo trocado no disco");
  const second = await onStart(event, parentCtx(root));
  assert.match(second.systemPrompt, /conteúdo original/);
  assert.doesNotMatch(second.systemPrompt, /trocado no disco/);
});

test("harness-context-files: session_start invalida o cache da sessão anterior", async (t) => {
  const root = makeProject(t);
  const handlers = register();

  assert.equal(await handlers.before_agent_start(event, parentCtx(root)), undefined);
  writeFileSync(join(root, "AGENTS.md"), "contexto que apareceu depois");
  await handlers.session_start({}, parentCtx(root));
  const after = await handlers.before_agent_start(event, parentCtx(root));
  assert.match(after.systemPrompt, /contexto que apareceu depois/);
});

test("harness-context-files: sessão filha é no-op", async (t) => {
  const root = makeProject(t);
  writeFileSync(join(root, "AGENTS.md"), "não vai para o filho");
  const { before_agent_start: onStart } = register();
  assert.equal(await onStart(event, childCtx(root)), undefined);
});

test("harness-context-files: sem arquivo de contexto o prompt fica intacto", async (t) => {
  const root = makeProject(t);
  const { before_agent_start: onStart } = register();
  assert.equal(await onStart(event, parentCtx(root)), undefined);
});

test("harness-context-files: fail-open — ctx malformado não lança e não altera o prompt", async () => {
  const { before_agent_start: onStart } = register();
  assert.equal(await onStart(event, {}), undefined);
  assert.equal(await onStart(event, parentCtx(undefined)), undefined);
  assert.equal(await onStart(event, null), undefined);
});
