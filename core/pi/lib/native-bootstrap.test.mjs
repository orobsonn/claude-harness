/** @description Contrato puro do materializador de papéis do `pi install`. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
