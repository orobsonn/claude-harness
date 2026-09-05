/**
 * @description Integração da exceção release-only na extensão de memória. A prova
 * vem de Git/gh reais no fixture; prompts nunca substituem metadata verificável.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import harnessMemory from "./harness-memory.ts";

const SESSION = "ses-release-memory";
const FEATURE = "release-memory-cycle";
const BASE_PACKAGE = { name: "fixture", version: "1.2.3", type: "module", dependencies: { leftpad: "1.0.0" } };
const BASE_LOCK = {
  name: "fixture",
  version: "1.2.3",
  lockfileVersion: 3,
  requires: true,
  packages: {
    "": { name: "fixture", version: "1.2.3", dependencies: { leftpad: "1.0.0" } },
    "node_modules/leftpad": { version: "1.0.0" },
  },
};
const BASE_CHANGELOG = `# Changelog

## [1.2.3] - 2026-09-01

### Fixed

- Previous milestone.
`;

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commit(root, message) {
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", message]);
  return git(root, ["rev-parse", "HEAD"]);
}

function writeJson(root, name, value) {
  writeFileSync(join(root, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function statePath(root) {
  return join(root, ".pi", "harness", "state", SESSION, "gate-state.json");
}

function sharedPath(root) {
  return join(root, ".pi", "harness", "state", SESSION, "shared_context.md");
}

function harvestPath(root) {
  return join(root, ".pi", "harness", "state", SESSION, "memory-harvest.json");
}

function shipmentPath(root) {
  return join(root, ".pi", "harness", "state", SESSION, "memory-shipment.json");
}

function releaseFixture(t, { mutation = "none", finalState = true } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-memory-release-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.name", "Memory Release"]);
  git(root, ["config", "user.email", "memory-release@example.test"]);
  writeFileSync(join(root, ".gitignore"), ".pi/harness/\nnode_modules/\n", "utf8");
  writeJson(root, "package.json", BASE_PACKAGE);
  writeJson(root, "package-lock.json", BASE_LOCK);
  writeFileSync(join(root, "CHANGELOG.md"), BASE_CHANGELOG, "utf8");
  writeFileSync(join(root, "MEMORY.md"), "memória anterior\n", "utf8");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "app.ts"), "export const stable = true;\n", "utf8");
  const baseSha = commit(root, "feat: previous milestone");
  git(root, ["update-ref", "refs/remotes/origin/main", baseSha]);
  git(root, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  git(root, ["switch", "-q", "-c", "chore/release-1.2.4"]);

  writeJson(root, "package.json", {
    ...BASE_PACKAGE,
    version: "1.2.4",
    ...(mutation === "metadata" ? { name: "silently-changed-product" } : {}),
  });
  writeJson(root, "package-lock.json", {
    ...BASE_LOCK,
    version: "1.2.4",
    packages: { ...BASE_LOCK.packages, "": { ...BASE_LOCK.packages[""], version: "1.2.4" } },
  });
  writeFileSync(join(root, "CHANGELOG.md"), `# Changelog

## [1.2.4] - 2026-09-05

### Fixed

- Release current milestone.

## [1.2.3] - 2026-09-01

### Fixed

- Previous milestone.
`, "utf8");
  if (mutation === "code") writeFileSync(join(root, "src", "app.ts"), "export const stable = false;\n", "utf8");
  const headSha = commit(root, "chore: release v1.2.4");

  mkdirSync(join(root, ".pi", "harness", "state", SESSION), { recursive: true });
  const oldReceipt = (role, suffix) => ({
    written_by: "host-subagent-completion",
    parent_session_id: SESSION,
    feature_id: FEATURE,
    role,
    dispatch_call_id: `old-${suffix}`,
    child_session_id: `old-child-${suffix}`,
    agent_id: `old-agent-${suffix}`,
    status: "completed",
    reviewed_head_sha: baseSha,
  });
  writeFileSync(statePath(root), JSON.stringify({
    session_id: SESSION,
    feature_id: FEATURE,
    ...(finalState ? {
      final_review_done: true,
      final_review_evidence: {
        adversary: oldReceipt("harness-adversary", "adversary"),
        compliance: oldReceipt("harness-compliance", "compliance"),
      },
    } : {}),
  }), "utf8");
  return { root, baseSha, headSha };
}

function seedPlan(root) {
  const directory = join(root, ".pi", "harness", "plans", FEATURE);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "execution-plan.json"),
    JSON.stringify({ feature_id: FEATURE, tasks: [{ id: "release-task", scope_paths: ["package.json", "package-lock.json", "CHANGELOG.md"] }] }),
    "utf8",
  );
}

function runtime(root) {
  return { cwd: root, sessionManager: { getSessionId: () => SESSION, getHeader: () => ({}) } };
}

function register() {
  const handlers = new Map();
  let tool;
  harnessMemory(/** @type {any} */ ({
    on(name, handler) { handlers.set(name, handler); },
    registerTool(definition) { tool = definition; },
  }));
  assert.equal(tool?.name, "harness_memory");
  for (const name of ["tool_call", "tool_execution_start", "tool_execution_end"]) {
    assert.equal(typeof handlers.get(name), "function");
  }
  return {
    handlers,
    execute(params, ctx) {
      return tool.execute("memory-release-call", params, new AbortController().signal, () => {}, ctx);
    },
  };
}

function shipperEvent() {
  return {
    toolName: "subagent",
    toolCallId: "shipper-release",
    input: { subagent_type: "harness-shipper", description: "publish release", prompt: "Publish the verified release." },
  };
}

function completeShipper(api, root) {
  const args = shipperEvent().input;
  api.handlers.get("tool_execution_start")(
    { toolName: "subagent", toolCallId: "shipper-release", args },
    runtime(root),
  );
  api.handlers.get("tool_execution_end")(
    {
      toolName: "subagent",
      toolCallId: "shipper-release",
      result: {
        content: [{ type: "text", text: "Release published.\nStatus: DONE" }],
        details: { status: "completed", agentId: "agent-release-shipper" },
      },
      isError: false,
    },
    runtime(root),
  );
}

function harvestEnvelope(changes) {
  return `[HARNESS_HARVEST_RESULT]${JSON.stringify({ changes })}[/HARNESS_HARVEST_RESULT]`;
}

function completeHarvest(api, root, changes = []) {
  const args = {
    subagent_type: "harness-harvester",
    description: "harvest release memory",
    prompt: "[HARNESS_HARVEST]\nReview release evidence.",
  };
  api.handlers.get("tool_execution_start")(
    { toolName: "subagent", toolCallId: "harvest-release", args },
    runtime(root),
  );
  api.handlers.get("tool_execution_end")(
    {
      toolName: "subagent",
      toolCallId: "harvest-release",
      result: {
        content: [{ type: "text", text: harvestEnvelope(changes) }],
        details: { status: "completed", agentId: "agent-release-harvester" },
      },
      isError: false,
    },
    runtime(root),
  );
}

function assertBlocked(decision) {
  assert.equal(decision?.block, true);
  assert.equal(typeof decision?.reason, "string");
}

function mergeRelease(root, number = 42) {
  git(root, ["switch", "-q", "main"]);
  git(root, ["merge", "-q", "--squash", "chore/release-1.2.4"]);
  const headSha = commit(root, `chore: release v1.2.4 (#${number})`);
  git(root, ["update-ref", "refs/remotes/origin/main", headSha]);
  return headSha;
}

function installFakeGh(t, root, headSha, number = 42) {
  const bin = mkdtempSync(join(tmpdir(), "pi-memory-gh-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const evidence = [{
    number,
    title: "chore: release v1.2.4",
    state: "MERGED",
    mergedAt: "2026-09-05T12:00:00Z",
    mergeCommit: { oid: headSha },
    headRefName: "chore/release-1.2.4",
    baseRefName: "main",
    statusCheckRollup: [{ conclusion: "SUCCESS" }],
  }];
  const executable = join(bin, "gh");
  writeFileSync(executable, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(evidence)}'\n`, "utf8");
  chmodSync(executable, 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${previous ?? ""}`;
  t.after(() => {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  });
}

test("harness-memory release: prova pre-merge libera shipper apesar das revisões pertencerem ao HEAD anterior", async (t) => {
  const f = releaseFixture(t);
  const api = register();
  assert.equal(await api.handlers.get("tool_call")(shipperEvent(), runtime(f.root)), undefined);
  completeShipper(api, f.root);

  const receipt = JSON.parse(readFileSync(shipmentPath(f.root), "utf8"));
  assert.equal(receipt.head, f.headSha);
  assert.equal(receipt.feature_id, FEATURE);
  assert.equal(receipt.release_phase, "pre-merge");
});

test("harness-memory release: código ou metadata misturados e feature comum sem reviews continuam bloqueados", async (t) => {
  for (const [label, options] of [
    ["código misturado", { mutation: "code" }],
    ["metadata além da versão", { mutation: "metadata" }],
    ["feature comum sem revisão", { ordinary: true, finalState: false }],
  ]) {
    await t.test(label, async (st) => {
      const f = releaseFixture(st, options);
      if (options.ordinary) git(f.root, ["switch", "-q", "main"]);
      assertBlocked(await register().handlers.get("tool_call")(shipperEvent(), runtime(f.root)));
    });
  }
});

test("harness-memory release: finalize preserva shared_context quando o release não foi colhido", async (t) => {
  const f = releaseFixture(t);
  const api = register();
  const updated = await api.execute({ action: "update", content: "contexto restante do release" }, runtime(f.root));
  assert.equal(updated.details.ok, true);
  completeShipper(api, f.root);

  const finalized = await api.execute({ action: "finalize" }, runtime(f.root));
  assert.equal(finalized.details.ok, false);
  assert.equal(finalized.isError, true);
  assert.equal(readFileSync(sharedPath(f.root), "utf8"), "contexto restante do release");
});

test("harness-memory release: finalize preserva proposta durável ainda não persistida", async (t) => {
  const f = releaseFixture(t);
  const api = register();
  seedPlan(f.root);
  await api.execute({ action: "update", content: "aprendizado pendente" }, runtime(f.root));
  const before = readFileSync(join(f.root, "MEMORY.md"), "utf8");
  completeHarvest(api, f.root, [{
    path: "MEMORY.md",
    before_sha256: createHash("sha256").update(before).digest("hex"),
    content: "memória proposta e ainda não escrita\n",
    evidence: "evidência confirmada",
    invalidation: "revalidar no próximo release",
  }]);
  completeShipper(api, f.root);

  const finalized = await api.execute({ action: "finalize" }, runtime(f.root));
  assert.equal(finalized.details.ok, false);
  assert.equal(finalized.isError, true);
  assert.equal(existsSync(sharedPath(f.root)), true);
  assert.equal(existsSync(harvestPath(f.root)), true);
  assert.equal(readFileSync(join(f.root, "MEMORY.md"), "utf8"), before);
});

test("harness-memory release: harvest zero delta persistido permite limpar o runtime pre-merge", async (t) => {
  const f = releaseFixture(t);
  const api = register();
  seedPlan(f.root);
  await api.execute({ action: "update", content: "contexto já absorvido" }, runtime(f.root));
  completeHarvest(api, f.root);
  assert.equal(existsSync(harvestPath(f.root)), true);
  assert.equal(await api.handlers.get("tool_call")(shipperEvent(), runtime(f.root)), undefined);
  completeShipper(api, f.root);

  const finalized = await api.execute({ action: "finalize" }, runtime(f.root));
  assert.equal(finalized.details.ok, true);
  assert.equal(existsSync(sharedPath(f.root)), false);
  assert.equal(existsSync(harvestPath(f.root)), false);
  assert.equal(existsSync(shipmentPath(f.root)), false);
});

test("harness-memory release: prova pós-merge usa somente o PR exato fornecido pelo gh local", async (t) => {
  const f = releaseFixture(t);
  const mergedHead = mergeRelease(f.root);
  installFakeGh(t, f.root, mergedHead);
  const api = register();
  seedPlan(f.root);
  await api.execute({ action: "update", content: "contexto pós-merge absorvido" }, runtime(f.root));
  completeHarvest(api, f.root);
  assert.equal(await api.handlers.get("tool_call")(shipperEvent(), runtime(f.root)), undefined);
  completeShipper(api, f.root);
  assert.equal(JSON.parse(readFileSync(shipmentPath(f.root), "utf8")).release_phase, "post-merge");

  const finalized = await api.execute({ action: "finalize" }, runtime(f.root));
  assert.equal(finalized.details.ok, true);
  assert.equal(existsSync(sharedPath(f.root)), false);
});
