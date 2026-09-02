import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const promptPath = fileURLToPath(new URL("./harness-runtime.md", import.meta.url));

test("parent orchestration stays local and dispatches only canonical harness roles", () => {
  const prompt = readFileSync(promptPath, "utf8");

  assert.match(prompt, /agente principal faz triagem/i);
  assert.match(prompt, /harness-planner/);
  assert.match(prompt, /harness_plan/);
  assert.match(prompt, /validação própria/);
  assert.match(prompt, /harness-executor/);
  assert.doesNotMatch(prompt, /Delegue somente aos agentes `harness-\*`/);
});

test("o prompt descreve os rails que existem e não promete sandbox", () => {
  const prompt = readFileSync(promptPath, "utf8");

  // A frase antiga era falsa depois do porte: há, sim, negação por ferramenta.
  assert.doesNotMatch(prompt, /não existe aprovação por ferramenta/i);
  assert.match(prompt, /rails determinísticos/i);
  assert.match(prompt, /gh pr merge/);
  assert.match(prompt, /harness:ready/);
  assert.match(prompt, /\.pi\/harness\/state\//);
  assert.match(prompt, /lavish-axi/);
  assert.match(prompt, /não sandbox|não é sandbox/i);
  assert.match(prompt, /execution-plan\.json/);
});

test("o prompt exige vermelho executável antes do fidelity-pass", () => {
  const prompt = readFileSync(promptPath, "utf8");

  assert.match(prompt, /vermelho executável/i);
  assert.match(prompt, /dependência.*ausente|runner.*ausente/i);
  assert.match(prompt, /fidelity-pass/i);
});
