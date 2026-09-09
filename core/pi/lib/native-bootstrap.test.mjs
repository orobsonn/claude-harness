/** @description Contrato puro do materializador de papéis do `pi install`. */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RUNTIME_ROLES } from "./roles.mjs";
import { installNativeHarnessAgents, nativeAgentOwnershipMarker } from "./native-bootstrap.mjs";

test("materialização já possuída é idempotente e conserva o catálogo runtime inteiro", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-native-bootstrap-lib-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");

  const first = installNativeHarnessAgents({ agentDir });
  assert.equal(first.ok, true, first.reason);
  assert.deepEqual(first.roles, RUNTIME_ROLES);
  const planner = join(agentDir, "agents", "harness-planner.md");
  const firstContent = readFileSync(planner, "utf8");

  const second = installNativeHarnessAgents({ agentDir });
  assert.equal(second.ok, true, second.reason);
  assert.equal(readFileSync(planner, "utf8"), firstContent);
  assert.ok(firstContent.includes(nativeAgentOwnershipMarker("harness-planner")));
});

test("regression: bootstrap nativo materializa cap 3, preserva 1/2/3 e recusa configuração inválida", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-native-review-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const configPath = join(agentDir, "harness.json");

  const first = installNativeHarnessAgents({ agentDir });
  assert.equal(first.ok, true, first.reason);
  assert.equal(existsSync(configPath), true, "native bootstrap must materialize the harness-owned config");
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), { maxParallelEyes: 3 });

  for (const maxParallelEyes of [1, 2, 3]) {
    const operatorConfig = `${JSON.stringify({ maxParallelEyes }, null, 2)}\n`;
    writeFileSync(configPath, operatorConfig);
    const repeated = installNativeHarnessAgents({ agentDir });
    assert.equal(repeated.ok, true, repeated.reason);
    assert.equal(readFileSync(configPath, "utf8"), operatorConfig);
  }

  const invalidConfig = `${JSON.stringify({ maxParallelEyes: 4 }, null, 2)}\n`;
  writeFileSync(configPath, invalidConfig);
  const invalid = installNativeHarnessAgents({ agentDir });
  assert.equal(invalid.ok, false);
  assert.match(invalid.reason, /harness-config.*maxParallelEyes.*integer.*1.*3/i);
  assert.equal(readFileSync(configPath, "utf8"), invalidConfig, "bootstrap must not rewrite an invalid operator config");
});
