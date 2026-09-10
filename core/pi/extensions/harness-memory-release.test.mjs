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
import { capturePiReviewInput } from "../lib/pi-review-evidence.mjs";

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
  git(root, ["remote", "add", "origin", "https://github.com/example/release-fixture.git"]);
  git(root, ["commit", "-q", "--allow-empty", "-m", "chore: initialize fixture"]);
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
  writeFileSync(join(directory, "spec.md"), "# Verified release fixture\n", "utf8");
}

function seedAcceptedFinalReviewState(root, head) {
  const captured = capturePiReviewInput({ projectRoot: root, sessionId: SESSION, featureId: FEATURE, phase: "final" });
  assert.equal(captured.ok, true, captured.reason);
  const report = { issues: [] };
  const reportDigest = createHash("sha256").update(JSON.stringify(report)).digest("hex");
  const receipt = (role) => ({
    written_by: "host-subagent-completion",
    parent_session_id: SESSION,
    feature_id: FEATURE,
    role,
    dispatch_call_id: "call-" + role,
    child_session_id: "child-" + role,
    agent_id: "agent-" + role,
    status: "completed",
    reviewed_head_sha: head,
    accepted: true,
    input_digest: captured.snapshot.input_digest,
    report_digest: reportDigest,
    report,
  });
  writeFileSync(statePath(root), JSON.stringify({
    session_id: SESSION,
    feature_id: FEATURE,
    final_review_done: true,
    final_review_evidence: {
      adversary: receipt("harness-adversary"),
      compliance: receipt("harness-compliance"),
    },
  }), "utf8");
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
  for (const name of ["tool_call", "tool_execution_start", "tool_result"]) {
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

function completeShipper(api, root, during = () => {}) {
  const args = shipperEvent().input;
  api.handlers.get("tool_execution_start")(
    { toolName: "subagent", toolCallId: "shipper-release", args },
    runtime(root),
  );
  during();
  api.handlers.get("tool_result")(
    {
      toolName: "subagent",
      toolCallId: "shipper-release",
      input: args,
      content: [{ type: "text", text: "Release published.\nStatus: DONE" }],
      details: { status: "completed", agentId: "agent-release-shipper" },
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
  api.handlers.get("tool_result")(
    {
      toolName: "subagent",
      toolCallId: "harvest-release",
      input: args,
      content: [{ type: "text", text: harvestEnvelope(changes) }],
      details: { status: "completed", agentId: "agent-release-harvester" },
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

function installFakeGh(t, root, headSha, number = 42, releaseHeadSha = git(root, ["rev-parse", "chore/release-1.2.4"]), additionalEvidence = []) {
  const bin = mkdtempSync(join(tmpdir(), "pi-memory-gh-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const evidence = [{
    number,
    title: "chore: release v1.2.4",
    state: "MERGED",
    mergedAt: "2026-09-05T12:00:00Z",
    mergeCommit: { oid: headSha },
    headRefName: "chore/release-1.2.4",
    headRefOid: releaseHeadSha,
    baseRefName: "main",
    baseRefOid: git(root, ["rev-parse", `${headSha}^`]),
    isDraft: false,
    url: `https://github.com/example/release-fixture/pull/${number}`,
    statusCheckRollup: [{ conclusion: "SUCCESS" }],
  }, ...additionalEvidence];
  const remoteCommits = Object.fromEntries(evidence.map((row) => {
    const oid = row.mergeCommit.oid;
    return [oid, {
      sha: oid,
      tree: { sha: git(root, ["rev-parse", `${oid}^{tree}`]) },
      parents: [{ sha: row.baseRefOid }],
      message: git(root, ["log", "-1", "--format=%s", oid]),
    }];
  }));
  const repository = { nameWithOwner: "example/release-fixture", url: "https://github.com/example/release-fixture", defaultBranchRef: { name: "main" } };
  const remoteRef = { object: { sha: headSha } };
  const publishedMarker = join(bin, "published");
  const release = {
    tagName: "v1.2.4",
    targetCommitish: "main",
    name: "Release 1.2.4",
    body: "presentation may be edited",
    isDraft: false,
    isPrerelease: false,
    publishedAt: "2026-09-05T12:30:00Z",
    url: "https://github.com/example/release-fixture/releases/tag/v1.2.4",
  };
  const executable = join(bin, "gh");
  writeFileSync(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "repo" && args[1] === "view") console.log(${JSON.stringify(JSON.stringify(repository))});
else if (args[0] === "pr" && args[1] === "list") console.log(${JSON.stringify(JSON.stringify(evidence))});
else if (args[0] === "api" && args[1].includes("/git/ref/heads/main")) console.log(${JSON.stringify(JSON.stringify(remoteRef))});
else if (args[0] === "api" && args[1].includes("/compare/")) {
  const base = args[1].split("/compare/")[1].split("...")[0];
  console.log(JSON.stringify({ status: base === ${JSON.stringify(headSha)} ? "identical" : "ahead", merge_base_commit: { sha: base } }));
}
else if (args[0] === "api" && args[1].includes("/git/commits/")) {
  const oid = args[1].split("/git/commits/")[1];
  const commit = ${JSON.stringify(remoteCommits)}[oid];
  if (!commit) process.exit(1);
  console.log(JSON.stringify(commit));
}
else if (args[0] === "api" && args[1].includes("/commits/v1.2.4")) console.log(${JSON.stringify(JSON.stringify({ sha: headSha }))});
else if (args[0] === "release" && args[1] === "view" && fs.existsSync(${JSON.stringify(publishedMarker)})) console.log(${JSON.stringify(JSON.stringify(release))});
else process.exit(1);
`, "utf8");
  chmodSync(executable, 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${previous ?? ""}`;
  t.after(() => {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  });
  return { publish: () => writeFileSync(publishedMarker, "published\n", "utf8") };
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

test("harness-memory release: preparo pre-merge não se confunde com publicação finalizável", async (t) => {
  const f = releaseFixture(t);
  const api = register();
  seedPlan(f.root);
  await api.execute({ action: "update", content: "contexto já absorvido" }, runtime(f.root));
  completeHarvest(api, f.root);
  assert.equal(existsSync(harvestPath(f.root)), true);
  assert.equal(await api.handlers.get("tool_call")(shipperEvent(), runtime(f.root)), undefined);
  completeShipper(api, f.root);
  assert.equal(JSON.parse(readFileSync(shipmentPath(f.root), "utf8")).shipment_phase, "release-prepared");

  const finalized = await api.execute({ action: "finalize" }, runtime(f.root));
  assert.equal(finalized.details.ok, false);
  assert.equal(existsSync(sharedPath(f.root)), true);
  assert.equal(existsSync(harvestPath(f.root)), true);
  assert.equal(existsSync(shipmentPath(f.root)), true);
});

test("same-WT faz squash funcional, release e publicação em um dispatch sem reutilizar main", async (t) => {
  const f = releaseFixture(t);
  const initialBase = git(f.root, ["rev-parse", f.baseSha + "^"]);
  const releasePackage = readFileSync(join(f.root, "package.json"), "utf8");
  const releaseLock = readFileSync(join(f.root, "package-lock.json"), "utf8");
  const releaseChangelog = readFileSync(join(f.root, "CHANGELOG.md"), "utf8");
  git(f.root, ["branch", "-f", "main", initialBase]);
  git(f.root, ["update-ref", "refs/remotes/origin/main", initialBase]);
  git(f.root, ["switch", "-q", "-c", "feat/reviewed", f.baseSha]);
  seedPlan(f.root);
  seedAcceptedFinalReviewState(f.root, f.baseSha);
  const api = register();
  await api.execute({ action: "update", content: "same-WT release context" }, runtime(f.root));
  completeHarvest(api, f.root);
  const mainWorktree = mkdtempSync(join(tmpdir(), "pi-release-main-occupied-"));
  let functionalMerge;
  completeShipper(api, f.root, () => {
    git(f.root, ["worktree", "add", "-q", mainWorktree, "main"]);
    git(mainWorktree, ["merge", "-q", "--squash", "feat/reviewed"]);
    functionalMerge = commit(mainWorktree, "feat: reviewed functional squash (#41)");
    git(f.root, ["update-ref", "refs/remotes/origin/main", functionalMerge]);
    git(f.root, ["branch", "-f", "chore/release-1.2.4", functionalMerge]);
    git(f.root, ["switch", "-q", "chore/release-1.2.4"]);
    writeFileSync(join(f.root, "package.json"), releasePackage, "utf8");
    writeFileSync(join(f.root, "package-lock.json"), releaseLock, "utf8");
    writeFileSync(join(f.root, "CHANGELOG.md"), releaseChangelog, "utf8");
    const preparedHead = commit(f.root, "chore: release v1.2.4");
    git(mainWorktree, ["merge", "-q", "--squash", "chore/release-1.2.4"]);
    const releaseMerge = commit(mainWorktree, "chore: release v1.2.4 (#42)");
    git(f.root, ["update-ref", "refs/remotes/origin/main", releaseMerge]);
    const remote = installFakeGh(t, f.root, releaseMerge, 42, preparedHead, [{
      number: 41,
      title: "feat: reviewed functional change",
      state: "MERGED",
      isDraft: false,
      mergedAt: "2026-09-05T11:00:00Z",
      mergeCommit: { oid: functionalMerge },
      headRefOid: f.baseSha,
      headRefName: "feat/reviewed",
      baseRefName: "main",
      baseRefOid: initialBase,
      url: "https://github.com/example/release-fixture/pull/41",
      statusCheckRollup: [{ conclusion: "SUCCESS" }],
    }]);
    remote.publish();
  });
  t.after(() => {
    try { git(f.root, ["worktree", "remove", "--force", mainWorktree]); } catch {}
    rmSync(mainWorktree, { recursive: true, force: true });
  });
  assert.equal(git(f.root, ["branch", "--show-current"]), "chore/release-1.2.4");
  assert.equal(git(mainWorktree, ["branch", "--show-current"]), "main");
  const receipt = JSON.parse(readFileSync(shipmentPath(f.root), "utf8"));
  assert.equal(receipt.shipment_phase, "published");
  assert.notEqual(receipt.head, git(f.root, ["rev-parse", "HEAD"]));
  const finalized = await api.execute({ action: "finalize" }, runtime(f.root));
  assert.equal(finalized.details.ok, true);
});

test("harness-memory release: merge e publicação são recibos distintos antes do finalize", async (t) => {
  const f = releaseFixture(t);
  const mergedHead = mergeRelease(f.root);
  const remote = installFakeGh(t, f.root, mergedHead);
  const api = register();
  seedPlan(f.root);
  await api.execute({ action: "update", content: "contexto pós-merge absorvido" }, runtime(f.root));
  completeHarvest(api, f.root);
  assert.equal(await api.handlers.get("tool_call")(shipperEvent(), runtime(f.root)), undefined);
  completeShipper(api, f.root);
  assert.equal(JSON.parse(readFileSync(shipmentPath(f.root), "utf8")).shipment_phase, "merged");

  const premature = await api.execute({ action: "finalize" }, runtime(f.root));
  assert.equal(premature.details.ok, false);
  assert.equal(existsSync(sharedPath(f.root)), true);

  remote.publish();
  assert.equal(JSON.parse(readFileSync(shipmentPath(f.root), "utf8")).shipment_phase, "merged");

  const finalized = await api.execute({ action: "finalize" }, runtime(f.root));
  assert.equal(finalized.details.ok, true);
  assert.equal(existsSync(sharedPath(f.root)), false);
});

test("native shipper can complete only the exact proven release pre-to-post merge transition", async (t) => {
  for (const outcome of ["exact", "wrong-pr-head", "product-change", "base-advanced"]) {
    await t.test(outcome, async (st) => {
      const f = releaseFixture(st);
      const api = register();
      seedPlan(f.root);
      await api.execute({ action: "update", content: "release transition context" }, runtime(f.root));
      completeHarvest(api, f.root);
      let mergedHead;
      completeShipper(api, f.root, () => {
        if (outcome === "base-advanced") {
          git(f.root, ["switch", "-q", "main"]);
          writeFileSync(join(f.root, "src", "concurrent.ts"), "export const upstream = true;\n");
          const base = commit(f.root, "feat: concurrent upstream commit");
          git(f.root, ["update-ref", "refs/remotes/origin/main", base]);
        }
        mergedHead = mergeRelease(f.root);
        installFakeGh(st, f.root, mergedHead, 42, outcome === "wrong-pr-head" ? "f".repeat(40) : f.headSha);
        if (outcome === "product-change") {
          writeFileSync(join(f.root, "src", "app.ts"), "export const changed = true;\n");
          commit(f.root, "feat: unrelated change after merge");
          git(f.root, ["update-ref", "refs/remotes/origin/main", git(f.root, ["rev-parse", "HEAD"])]);
        }
      });
      assert.equal(existsSync(shipmentPath(f.root)), outcome === "exact");
      if (outcome === "exact") {
        const receipt = JSON.parse(readFileSync(shipmentPath(f.root), "utf8"));
        assert.equal(receipt.head, mergedHead);
        assert.equal(receipt.shipment_phase, "merged");
      }
      const finalized = await api.execute({ action: "finalize" }, runtime(f.root));
      assert.equal(finalized.details.ok, false);
      assert.equal(existsSync(sharedPath(f.root)), true);
    });
  }
});
