/**
 * @description Frozen oracle for the setup-vps wizard. Every seam injected — ZERO real prompts/fs/
 * git/crontab. Proves: inference from cwd + git remote (Enter accepts defaults), the STABLE selector
 * resolution (local clone, else auto-clone — never the npx cache), that the wizard installs the ORCA
 * selector (a project JSON + one fenced crontab line) and NOT the retired VPS cron engine, that the
 * crontab upsert preserves every unrelated line, and that it refuses to run as root.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CRON_FENCE_PREFIX,
  parseGitRemote,
  orcaGuide,
  buildProjectConfig,
  assertCronSafe,
  renderCronBlock,
  upsertCronBlock,
  reviewAutomationGuide,
  runSetupVps,
} from "./setup-vps.mjs";
import { parseCliArgs } from "./cli.mjs";
import { normalizeConfig } from "../../../../orca/select-and-dispatch.mjs";

// All-Enter for the inferred fields (home/projectRoot/project/owner/repo), then the Orca answers.
// clonePath sits right after orcaRepoId: both come from the same `orca repo list --json` row.
// Order matches runSetupVps's prompts.
const INFER = ["", "", "", "", "", "repo_abc123", "/clones/myproject", "", "", "", "[canary]", ""];

function harness(opts = {}) {
  const {
    answers = INFER,
    localEngineDir = "/srv/claude-harness",
    stableEngineDir = "/home/op/.claude/harness-core",
    gitRemote = () => "git@github.com:orobsonn/myproject.git",
    cwd = "/srv/myproject",
    exists,
    cloneEngine,
    crontab = "",
    whoami = () => "orca",
  } = opts;
  const queue = [...answers];
  const outLines = [];
  const jsonWrites = [];
  const crontabWrites = [];
  const cloneCalls = [];
  const dirs = [];
  const deps = {
    ask: async () => queue.shift(),
    out: (t) => outLines.push(t),
    env: { HOME: "/home/op" },
    cwd,
    gitRemote,
    nodeBin: "/usr/bin/node",
    localEngineDir,
    stableEngineDir,
    cloneEngine: cloneEngine ?? ((dir) => cloneCalls.push(dir)),
    // default: only the local clone ships the selector.
    exists: exists ?? ((p) => localEngineDir != null && p.startsWith(localEngineDir)),
    ensureDir: (d) => dirs.push(d),
    writeJson: (p, json) => jsonWrites.push({ p, json }),
    readCrontab: () => crontab,
    writeCrontab: (text) => crontabWrites.push(text),
    whoami,
  };
  return { deps, outLines, jsonWrites, crontabWrites, cloneCalls, dirs };
}

test("parseGitRemote handles ssh, https, .git and trailing slash", () => {
  assert.deepEqual(parseGitRemote("git@github.com:orobsonn/repo.git"), { owner: "orobsonn", repo: "repo" });
  assert.deepEqual(parseGitRemote("https://github.com/orobsonn/repo"), { owner: "orobsonn", repo: "repo" });
  assert.deepEqual(parseGitRemote("https://github.com/orobsonn/repo.git/"), { owner: "orobsonn", repo: "repo" });
  assert.deepEqual(parseGitRemote("lixo"), { owner: "", repo: "" });
});

test("orcaGuide names Orca as the official ADE, links the download, and explains the repo id / global ceiling / canary knob", () => {
  const g = orcaGuide();
  assert.match(g, /ADE oficial/);
  assert.match(g, /https:\/\/onorca\.dev/);
  assert.match(g, /orca repo list --json/);
  assert.match(g, /orca worktree ps --json/);
  assert.match(g, /canári/i);
});

test("buildProjectConfig produces a config the SELECTOR itself accepts (same shape as project.example.json)", () => {
  const cfg = buildProjectConfig({
    project: "myproject", owner: "orobsonn", repo: "myproject", orcaRepoId: "repo_abc123",
    clonePath: "/clones/myproject",
    baseBranch: "main", agent: "claude", globalMaxWorking: 4, titleIncludes: "[canary]", prompt: "vai",
  });
  assert.equal(cfg.ghRepo, "orobsonn/myproject");
  const normalized = normalizeConfig(cfg);
  assert.equal(normalized.orcaRepoId, "repo_abc123");
  assert.equal(normalized.titleIncludes, "[canary]");
  assert.equal(normalized.globalMaxWorking, 4);
});

test("buildProjectConfig carries clonePath through — the selector cannot fetch the base without it, and a config missing it must fail at setup, not at 3am", () => {
  const cfg = buildProjectConfig({
    project: "p", owner: "o", repo: "r", orcaRepoId: "id", clonePath: "/clones/r",
    baseBranch: "main", agent: "claude", globalMaxWorking: 4, titleIncludes: "", prompt: "x",
  });
  assert.equal(cfg.clonePath, "/clones/r");
  assert.equal(normalizeConfig(cfg).clonePath, "/clones/r");

  const { clonePath, ...without } = cfg;
  assert.throws(() => normalizeConfig(without), /"clonePath" is required/);
});

test("buildProjectConfig maps an empty title filter to null (no filter), not to an empty string", () => {
  const cfg = buildProjectConfig({
    project: "p", owner: "o", repo: "r", orcaRepoId: "id", clonePath: "/c",
    baseBranch: "main", agent: "claude", globalMaxWorking: 4, titleIncludes: "", prompt: "x",
  });
  assert.equal(cfg.titleIncludes, null);
});

test("assertCronSafe rejects the values that would silently break or inject into a crontab line", () => {
  assert.equal(assertCronSafe("/usr/bin/node", "nodeBin"), "/usr/bin/node");
  for (const bad of ["", "a%b", "a\nb", "a#b", "a\rb"]) {
    assert.throws(() => assertCronSafe(bad, "x"), /não pode ficar vazio nem conter/);
  }
});

test("renderCronBlock renders one fenced line invoking the selector with --config, and validates the interval", () => {
  const block = renderCronBlock({
    project: "myproject",
    nodeBin: "/usr/bin/node",
    selectorPath: "/srv/claude-harness/core/orca/select-and-dispatch.mjs",
    configPath: "/home/op/.config/claude-harness/projects/myproject.json",
    logPath: "/home/op/.local/state/claude-harness/myproject.log",
    intervalMinutes: 20,
  });
  assert.deepEqual(block.split("\n"), [
    "# >>> harness-orca:myproject >>>",
    "*/20 * * * * /usr/bin/node /srv/claude-harness/core/orca/select-and-dispatch.mjs --config /home/op/.config/claude-harness/projects/myproject.json >> /home/op/.local/state/claude-harness/myproject.log 2>&1",
    "# <<< harness-orca:myproject <<<",
  ]);
  const base = {
    project: "p", nodeBin: "/usr/bin/node", selectorPath: "/s", configPath: "/c", logPath: "/l",
  };
  assert.throws(() => renderCronBlock({ ...base, intervalMinutes: 0 }), /intervalMinutes/);
  assert.throws(() => renderCronBlock({ ...base, intervalMinutes: 60 }), /intervalMinutes/);
  assert.throws(() => renderCronBlock({ ...base, intervalMinutes: 1.5 }), /intervalMinutes/);
});

test("upsertCronBlock is idempotent and preserves OTHER projects' blocks and the operator's own crons", () => {
  const other = [
    "0 5 * * * /usr/bin/backup.sh",
    "# >>> harness-orca:outro >>>",
    "*/20 * * * * /usr/bin/node /s --config /outro.json",
    "# <<< harness-orca:outro <<<",
  ].join("\n");
  const block = "# >>> harness-orca:meu >>>\nLINHA\n# <<< harness-orca:meu <<<";
  const once = upsertCronBlock(other, "harness-orca:meu", block);
  assert.ok(once.includes("/usr/bin/backup.sh"));
  assert.ok(once.includes("harness-orca:outro"));
  assert.ok(once.includes("LINHA"));
  const twice = upsertCronBlock(once, "harness-orca:meu", block);
  assert.equal(twice, once, "re-running the wizard must not duplicate the block");
  assert.equal(twice.match(/harness-orca:meu >>>/g).length, 1);
});

test("upsertCronBlock replaces a stale block rather than appending next to it", () => {
  const stale = "# >>> harness-orca:meu >>>\nVELHO\n# <<< harness-orca:meu <<<";
  const fresh = "# >>> harness-orca:meu >>>\nNOVO\n# <<< harness-orca:meu <<<";
  const out = upsertCronBlock(stale, "harness-orca:meu", fresh);
  assert.ok(out.includes("NOVO"));
  assert.ok(!out.includes("VELHO"));
});

test("runSetupVps INFERS project/owner/repo/paths from cwd + git remote and writes the project JSON + one cron line", async () => {
  const h = harness();
  const result = await runSetupVps(h.deps);

  assert.equal(result.project, "myproject");
  assert.equal(result.configPath, "/home/op/.config/claude-harness/projects/myproject.json");
  assert.equal(result.selectorPath, "/srv/claude-harness/core/orca/select-and-dispatch.mjs");

  assert.equal(h.jsonWrites.length, 1);
  assert.deepEqual(h.jsonWrites[0].json, {
    project: "myproject",
    ghRepo: "orobsonn/myproject",
    orcaRepoId: "repo_abc123",
    clonePath: "/clones/myproject",
    baseBranch: "main",
    agent: "claude",
    globalMaxWorking: 4,
    titleIncludes: "[canary]",
    prompt: h.jsonWrites[0].json.prompt,
  });
  assert.match(h.jsonWrites[0].json.prompt, /AUT[ÔO]NOMO/);

  assert.equal(h.crontabWrites.length, 1);
  assert.ok(h.crontabWrites[0].includes(`# >>> ${CRON_FENCE_PREFIX}:myproject >>>`));
  assert.ok(h.crontabWrites[0].includes("core/orca/select-and-dispatch.mjs --config /home/op/.config/claude-harness/projects/myproject.json"));
  assert.ok(h.crontabWrites[0].includes("*/20 * * * *"));
});

test("runSetupVps installs the ORCA selector — it never touches the retired VPS cron engine", async () => {
  const h = harness();
  await runSetupVps(h.deps);
  const everything = [h.crontabWrites.join("\n"), h.outLines.join("\n")].join("\n");
  for (const retired of ["install-crons", "run-cron-a", "run-cron-review", "run-drain", "run-reaper", "TELEGRAM_BOT_TOKEN"]) {
    assert.ok(!everything.includes(retired), `setup-vps must no longer install/mention ${retired}`);
  }
});

test("runSetupVps: an explicit answer overrides the inferred default", async () => {
  const h = harness({
    answers: ["/home/outro", "/srv/x", "slug-custom", "acme", "produto", "repo_zzz", "/clones/produto", "develop", "claude", "2", "", "15"],
  });
  const result = await runSetupVps(h.deps);
  assert.equal(result.project, "slug-custom");
  assert.deepEqual(h.jsonWrites[0].json.ghRepo, "acme/produto");
  assert.equal(h.jsonWrites[0].json.baseBranch, "develop");
  assert.equal(h.jsonWrites[0].json.globalMaxWorking, 2);
  assert.equal(h.jsonWrites[0].json.titleIncludes, null);
  assert.equal(h.jsonWrites[0].p, "/home/outro/.config/claude-harness/projects/slug-custom.json");
  assert.ok(h.crontabWrites[0].includes("*/15 * * * *"));
});

test("runSetupVps: npx case (no local clone) auto-clones to the stable dir and points cron at THERE, never at the npx cache", async () => {
  const cloned = [];
  const h = harness({
    localEngineDir: null,
    exists: (p) => cloned.length > 0 && p.startsWith("/home/op/.claude/harness-core"),
    cloneEngine: (dir) => cloned.push(dir),
  });
  const result = await runSetupVps(h.deps);
  assert.deepEqual(cloned, ["/home/op/.claude/harness-core"]);
  assert.equal(result.selectorPath, "/home/op/.claude/harness-core/core/orca/select-and-dispatch.mjs");
  assert.ok(h.crontabWrites[0].includes("/home/op/.claude/harness-core/core/orca/select-and-dispatch.mjs"));
});

test("runSetupVps REFUSES to run as root — the selector is a user cron, which is what makes scoped credentials mean anything", async () => {
  const h = harness({ whoami: () => "root" });
  await assert.rejects(() => runSetupVps(h.deps), /não rode como root/);
  assert.equal(h.crontabWrites.length, 0);
  assert.equal(h.jsonWrites.length, 0);
});

test("runSetupVps fails fast (no install) when a required answer is empty", async () => {
  const h = harness({ answers: ["", "", "", "", "", "", "", "", "", "", "", ""] });
  await assert.rejects(() => runSetupVps(h.deps), /orca-repo-id/);
  assert.equal(h.crontabWrites.length, 0);
  assert.equal(h.jsonWrites.length, 0);
});

test("runSetupVps prints the PR-review automation contract, including the entry-gate's no--R consequence", async () => {
  const h = harness();
  await runSetupVps(h.deps);
  const printed = h.outLines.join("\n");
  assert.ok(printed.includes("--match-head-commit"));
  assert.ok(printed.includes("-R/--repo"));
  assert.match(printed, /SUCCESS/);
  assert.match(reviewAutomationGuide(), /ARMADO de severidade alta/);
});

test("runSetupVps warns explicitly when the canary title filter is left OFF", async () => {
  const h = harness({ answers: ["", "", "", "", "", "repo_abc123", "/clones/myproject", "", "", "", "", ""] });
  await runSetupVps(h.deps);
  assert.ok(h.outLines.join("\n").includes("SEM filtro de título"));
});

test("parseCliArgs passes the command through raw (init alias resolved by the dispatcher)", () => {
  assert.equal(parseCliArgs(["node", "cli.mjs", "setup-vps"]).command, "setup-vps");
});
