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
