import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const plannerPath = fileURLToPath(new URL("./harness-planner.md", import.meta.url));

test("planner Pi recebe o mesmo contrato estrutural de plano validado da lane OpenCode", () => {
  const prompt = readFileSync(plannerPath, "utf8");

  assert.match(prompt, /full planning contract/i);
  assert.match(prompt, /Execution-plan schema/);
  assert.match(prompt, /"model_strategy"/);
  assert.match(prompt, /"severity"/);
  assert.match(prompt, /"scope_paths"/);
  assert.match(prompt, /"criterion_refs"/);
  assert.match(prompt, /"locked_tests"/);
  assert.match(prompt, /"adversarial"/);
  assert.match(prompt, /Self-check/);
  assert.match(prompt, /validate-plan/);
});

test("planner Pi usa a spec selada e o routing vendored sem exigir artefatos externos", () => {
  const prompt = readFileSync(plannerPath, "utf8");

  assert.match(prompt, /sealed spec is the complete delivery authority/i);
  assert.match(prompt, /do not\s+ask for the original issue body/i);
  assert.match(prompt, /never\s+ask the operator for it/i);
  assert.match(prompt, /"low": "openai-codex\/gpt-5\.6-luna"/);
  assert.match(prompt, /"medium": "openai-codex\/gpt-5\.6-terra"/);
  assert.match(prompt, /"planner": "openai-codex\/gpt-5\.6-sol"/);
  assert.match(prompt, /"plan-reviewer": "openai-codex\/gpt-6-astra"/);
  assert.doesNotMatch(prompt, /"plan-reviewer": "openai-codex\/gpt-5\.6-sol"/);
});

test("planner Pi recebe contexto de revisão sem depender de resposta posterior do pai", () => {
  const prompt = readFileSync(plannerPath, "utf8");

  assert.match(prompt, /HARNESS_PLAN_REVIEW_CONTEXT/);
  assert.match(prompt, /do\s+not ask the parent to run commands/i);
  assert.match(prompt, /do\s+not wait for an answer/i);
  assert.match(prompt, /do\s+not\s+request or use `resume`/i);
});

test("planner Pi copia o modo estável da cerimônia sem reclassificar por risco", () => {
  const prompt = readFileSync(plannerPath, "utf8");

  assert.match(prompt, /parent brief must state the stable ceremony mode.*`LIGHT` or `FULL`/is);
  assert.match(prompt, /Copy that value.*lowercase `light` or\s+`full`/is);
  assert.match(prompt, /Never infer or escalate.*severity, complexity,\s+risk/is);
  assert.match(prompt, /mode is\s+absent.*reply `BLOCKED`.*do not write the plan/is);
  assert.match(prompt, /"mode": "<stable ceremony mode copied lowercase: light \| full>"/);
});

test("planner has no harvest mode because finalization preserves the approved plan", () => {
  const prompt = readFileSync(plannerPath, "utf8");

  assert.doesNotMatch(prompt, /HARNESS_HARVEST_CONTEXT/);
  assert.doesNotMatch(prompt, /harvest documentation task/i);
});

test("planner declara security final para as superfícies de segurança aplicáveis", () => {
  const prompt = readFileSync(plannerPath, "utf8");
  assert.match(prompt, /final_review.security.*true/is);
  assert.match(prompt, /auth.*secrets.*external.*dependenc/is);
  assert.match(prompt, /optional.*false/is);
});
