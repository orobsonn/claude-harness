import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  captureTaskRuntime,
  verifyTaskRuntime,
  resolveTaskRuntimeLauncher,
} from "./task-runtime-assets.mjs";

const put = (root, name, value = "asset") => {
  const file = path.join(root, ...name.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
  return file;
};
const readAsset = (relative) => fs.readFileSync(new URL(relative, import.meta.url), "utf8");

test("task recovery uses committed host evidence and proportional RED", () => {
  for (const asset of [readAsset("../prompts/harness-task-runtime.md"),
    readAsset("../prompts/harness-runtime.md"), readAsset("../skills/harness-task-pipeline/SKILL.md")]) {
    assert.match(asset, /commit seletivo.*capture-verified.*árvore limpa/is);
    assert.match(asset, /integração.*imediatamente anterior/is);
    assert.match(asset, /sibling.*constraint/is);
    assert.match(asset, /menor RED fiel/);
    assert.doesNotMatch(asset, /capture-verified.*antes de commit\/revisores/);
    assert.doesNotMatch(asset, /Depois do executor e da captura atual|recapture a mudança, crie|valide\/capture, commite/);
    assert.doesNotMatch(asset, /valide e marque `capture-verified` após cada executor\/sniper e faça o/);
  }
});

test("task assets preserve LIGHT/FULL eye selection and fresh aggregate review", () => {
  const task = readAsset("../prompts/harness-task-runtime.md");
  const pipeline = readAsset("../skills/harness-task-pipeline/SKILL.md");
  for (const asset of [task, pipeline]) {
    assert.match(asset, /Em LIGHT, não (?:despache|rode) olhos de implementação por task/);
    assert.match(asset, /Em FULL,.*compliance/is);
    assert.match(asset, /adversary.*somente.*adversarial\.enabled.*true/is);
    assert.match(asset, /security.*trigger.*aplicabilidade/is);
    assert.match(asset, /final global.*(?:dual|fresca)/is);
    assert.match(asset, /triad.*security/is);
    assert.match(asset, /olho que o produziu e somente\s+(?:outros )?olhos.*obrigação ou trigger explícito.*afetado/is);
    assert.doesNotMatch(asset, /obrigatório após toda task|Toda task com escrita\s+exige adversary|false.*não (?:o dispensa|remove)|repita todos os\s+olhos já ativados/is);
  }
  for (const role of ["planner", "plan-reviewer"]) {
    const asset = readAsset(`../runtime/agents/harness-${role}.md`);
    assert.match(asset, /LIGHT has no per-task implementation eyes/);
    assert.match(asset, /FULL requires\s+compliance/);
    assert.match(asset, /adversary.*only when `adversarial\.enabled` is true/is);
    assert.doesNotMatch(asset, /mandatory post-implementation adversary|never disables|does not\s+turn the mandatory/);
  }
});

test("task assets preserve fidelity and escalate repeated failures without extra gates", () => {
  const task = readAsset("../prompts/harness-task-runtime.md");
  assert.match(task, /um RED\/freeze inicial por task/);
  assert.match(task, /Findings de produto seguem diretamente ao sniper, preservando a fidelidade/);
  assert.match(task, /somente quando o próprio teste\/fixture congelado estiver incorreto,\s+o contrato aprovado mudar ou um observável aprovado estiver concretamente sem cobertura/);
  assert.match(task, /Após duas falhas de fidelidade.*escale/is);
  assert.match(task, /Após dois ciclos HIGH de sniper\/re-gate.*escale/is);
  assert.match(task, /Não use stash\/rollback, no-op.*fabricar RED/);
  assert.doesNotMatch(task, /Defeito real sem cobertura: autor acrescenta|obtenha RED\/sensibilidade e fidelity atuais/);
  for (const role of ["test-author", "test-reviewer"]) {
    const asset = readAsset(`../runtime/agents/harness-${role}.md`);
    assert.match(asset, /one initial RED\/freeze per task/);
    assert.match(asset, /only for an incorrect frozen\s+test\/fixture, a changed approved\s+contract,? or a concretely uncovered approved observable/);
    assert.match(asset, /two fidelity failures/);
    assert.match(asset, /never (?:auto-approve|approve automatically)/);
  }
});

test("task eyes cannot import parent final-suite obligations", () => {
  for (const role of ["adversary", "compliance", "security"]) {
    const asset = readAsset(`../runtime/agents/harness-${role}.md`);
    assert.match(asset, /(?:do not|must not) require commands\s+from `final_review\.parent_verification`/);
    assert.match(asset, /final parent owns a green global suite\s+on the final HEAD|final parent owns a green global suite on the final HEAD/);
    assert.match(asset, /failure,\s*timeout or a new HEAD/);
    assert.match(asset, /ancestral task approval may keep an unaffected obligation satisfied without\s+certifying the new HEAD; final global review is fresh/);
    assert.doesNotMatch(asset, /two HIGH sniper\/re-gate cycles/);
    assert.match(asset, /Exclude secrets and credentials/);
  }
  const pipeline = readAsset("../skills/harness-task-pipeline/SKILL.md");
  assert.match(pipeline, /suite global precisa estar verde no HEAD final; timeout, falha ou HEAD\s+novo exige rerun pelo pai final/);
});

test("planning follows the side-effect seam and fidelity checks dependent fixtures locally", () => {
  for (const role of ["planner", "plan-reviewer"]) {
    const asset = readAsset(`../runtime/agents/harness-${role}.md`);
    assert.match(asset, /irreversible or external side effect.*caller\/helper.*last authoritative check\/read and the effect\/write/is);
    assert.match(asset, /[Ss]cope and ownership.*seam and.*necessary call sites/is);
    assert.match(asset, /[Nn]amed paths are starting points/);
    assert.match(asset, /[Ee]xclude\s+secrets and credentials/);
  }
  for (const role of ["test-author", "test-reviewer"]) {
    const asset = readAsset(`../runtime/agents/harness-${role}.md`);
    assert.match(asset, /TypeScript signature or shared fixture.*authorized path.*all\s+dependent call sites and fixtures in that path/is);
    assert.match(asset, /[Cc]onsolidate concrete defects.*same pattern.*first/is);
    assert.match(asset, /expected SUT type error.*acceptable RED/is);
    assert.match(asset, /fixture-local\s+type error, broken import or\s+zero collection is not/);
    assert.match(asset, /typecheck evidence.*parent|parent.*typecheck evidence/is);
  }
});
function sourceFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-runtime-source-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const launcher = put(root, "core/pi/bin/pi-harness.mjs", "launcher");
  put(root, "core/pi/lib/local.mjs", "local");
  put(root, "core/pi/runtime/settings.json", "{}");
  put(root, "core/shared/lib/upstream.mjs", "shared");
  put(root, "core/codex/lib/upstream.mjs", "codex");
  put(root, "core/opencode/lib/upstream.mjs", "opencode");
  put(root, "core/claude-code/skills/creating-plans/references/complexity-scorer.mjs", "scorer");
  return { root, launcher };
}
function vendorFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-runtime-vendor-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const harness = path.join(root, ".pi/harness");
  const launcher = put(harness, "bin/pi-harness.mjs", "launcher");
  for (const dir of [
    "extensions",
    "lib",
    "prompts",
    "skills",
    "vendor",
    "runtime-defaults",
    "runtime-deps",
  ])
    put(harness, `${dir}/asset`);
  return { root, harness, launcher };
}
const git = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
function repository(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-runtime-repo-"));
  const launcher = put(root, "core/pi/bin/pi-harness.mjs", "launcher");
  put(root, "core/pi/lib/local.mjs", "local");
  put(root, "core/pi/runtime/settings.json", "{}");
  put(root, "core/shared/lib/upstream.mjs");
  put(root, "core/codex/lib/upstream.mjs");
  put(root, "core/opencode/lib/upstream.mjs");
  put(root, "core/claude-code/skills/creating-plans/references/complexity-scorer.mjs", "scorer");
  put(root, ".pi/harness/bin/pi-harness.mjs", "vendor launcher");
  git(root, "init", "-q");
  git(root, "config", "user.name", "Harness");
  git(root, "config", "user.email", "harness@example.invalid");
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  const base = git(root, "rev-parse", "HEAD");
  const worktree = `${root}-task`;
  git(root, "worktree", "add", "-qb", "task", worktree, base);
  t.after(() => {
    try {
      git(root, "worktree", "remove", "--force", worktree);
    } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, launcher, base, worktree };
}

test("source runtime digest changes for Pi code and conservative upstream assets", (t) => {
  const f = sourceFixture(t);
  const first = captureTaskRuntime(f.launcher);
  assert.equal(first.ok, true, first.reason);
  assert.equal(verifyTaskRuntime(first.runtime).ok, true);
  fs.appendFileSync(path.join(f.root, "core/pi/lib/local.mjs"), " changed");
  assert.match(verifyTaskRuntime(first.runtime).reason, /changed/);
  const second = captureTaskRuntime(f.launcher);
  fs.appendFileSync(
    path.join(f.root, "core/shared/lib/upstream.mjs"),
    " changed",
  );
  assert.match(verifyTaskRuntime(second.runtime).reason, /changed/);
});

test("vendored digest ignores mutable runtime, state, auth and tests without reading their content", (t) => {
  const f = vendorFixture(t);
  const auth = put(f.harness, "runtime-defaults/auth.json", "secret");
  put(f.harness, "lib/ignored.test.mjs", "test");
  put(f.harness, "runtime/settings.json", "mutable");
  put(f.harness, "state/session/record.json", "mutable");
  fs.rmSync(auth);
  const secret = put(f.root, "secret-target", "secret");
  fs.symlinkSync(secret, auth);
  const credentials = put(
    f.harness,
    "runtime-defaults/credentials/private.json",
    "secret",
  );
  const devVars = put(f.harness, "runtime-defaults/.dev.vars.local", "secret");
  const first = captureTaskRuntime(f.launcher);
  assert.equal(first.ok, true, first.reason);
  for (const file of [
    secret,
    credentials,
    devVars,
    path.join(f.harness, "lib/ignored.test.mjs"),
    path.join(f.harness, "runtime/settings.json"),
    path.join(f.harness, "state/session/record.json"),
  ])
    fs.appendFileSync(file, " changed");
  assert.equal(verifyTaskRuntime(first.runtime).ok, true);
});

test("managed asset symlinks and unsupported launcher layouts fail closed", (t) => {
  const f = vendorFixture(t);
  fs.symlinkSync(
    path.join(f.harness, "lib/asset"),
    path.join(f.harness, "lib/link.mjs"),
  );
  assert.match(captureTaskRuntime(f.launcher).reason, /symlink/);
  const other = put(f.root, "bin/pi-harness.mjs");
  assert.match(captureTaskRuntime(other).reason, /supported/);
});

test("self-hosting caches a detached base while vendored and external launchers map directly", (t) => {
  const f = repository(t);
  const runtimeRoot = path.join(f.root, ".pi/harness/state/runtime-bases");
  const first = resolveTaskRuntimeLauncher({
    parentRoot: f.root,
    worktree: f.worktree,
    runtimeRoot,
    baseSha: f.base,
    sourceLauncher: f.launcher,
  });
  assert.equal(first.ok, true, first.reason);
  const before = captureTaskRuntime(first.launcherPath);
  assert.equal(before.ok, true, before.reason);
  fs.appendFileSync(
    path.join(f.worktree, "core/pi/lib/local.mjs"),
    " product change",
  );
  const again = resolveTaskRuntimeLauncher({
    parentRoot: f.root,
    worktree: f.worktree,
    runtimeRoot,
    baseSha: f.base,
    sourceLauncher: f.launcher,
  });
  assert.equal(again.launcherPath, first.launcherPath);
  assert.equal(verifyTaskRuntime(before.runtime).ok, true);
  const vendored = resolveTaskRuntimeLauncher({
    parentRoot: f.root,
    worktree: f.worktree,
    runtimeRoot,
    baseSha: f.base,
    sourceLauncher: path.join(f.root, ".pi/harness/bin/pi-harness.mjs"),
  });
  assert.equal(
    vendored.launcherPath,
    path.join(f.worktree, ".pi/harness/bin/pi-harness.mjs"),
  );
  const outside = vendorFixture(t);
  const external = resolveTaskRuntimeLauncher({
    parentRoot: f.root,
    worktree: f.worktree,
    runtimeRoot,
    baseSha: f.base,
    sourceLauncher: outside.launcher,
  });
  assert.equal(external.launcherPath, fs.realpathSync(outside.launcher));
  fs.appendFileSync(
    path.join(runtimeRoot, f.base, "core/pi/lib/local.mjs"),
    " runtime mutation",
  );
  assert.match(
    resolveTaskRuntimeLauncher({
      parentRoot: f.root,
      worktree: f.worktree,
      runtimeRoot,
      baseSha: f.base,
      sourceLauncher: f.launcher,
    }).reason,
    /clean reserved/,
  );
});
