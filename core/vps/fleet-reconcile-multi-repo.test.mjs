/**
 * @description FROZEN oracle for the multi-repo fleet-reconcile feature (#ac-1.1) in
 * core/vps/install-crons.mjs — per-project owner/repo tracking inside a shared reaper fleet.
 * Today reconcileFleet enforces a single-repo invariant (throws on any owner/repo mismatch with
 * the fleet's top-level owner/repo) and its projects[] entries carry no owner/repo field at all —
 * so all four tests below are EXPECTED TO FAIL (either an AssertionError on the new shape, or a
 * thrown "owner mismatch"/"repo mismatch" production error) until the feature lands. Mirrors the
 * install-crons.test.mjs idiom exactly: node:test + node:assert/strict, deps-injection with
 * in-memory fakes, ZERO real git/gh/fs/crontab mutation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { reconcileFleet, installProject, renderProjectBlock } from "./install-crons.mjs";

const NODE_BIN = "/usr/bin/node";
const SCRIPT_DIR = "/srv/harness/core/vps";
const HOME_DIR = "/home/harness";

/** @description Absolute per-project config path — mirrors install-crons.mjs's own join() formula. */
function configPathFor(project, homeDir = HOME_DIR) {
  return join(homeDir, ".claude/harness-crons", `${project}.json`);
}

/** @description Absolute reaper fleet config path — mirrors install-crons.mjs's own join() formula (fleetConfigPath is not exported). */
function fleetPathFor(homeDir = HOME_DIR) {
  return join(homeDir, ".claude/harness-crons/reaper.json");
}

/** @description Renders a project's fenced crontab block using the shared fixture constants. */
function projectBlockFixture(project, homeDir = HOME_DIR) {
  return renderProjectBlock({
    project,
    nodeBin: NODE_BIN,
    scriptDir: SCRIPT_DIR,
    configPath: configPathFor(project, homeDir),
  });
}

/**
 * @description Builds a fully in-memory fake `deps` object for installProject, mirroring
 * install-crons.test.mjs's makeMemoryDeps exactly (same key contract: readCrontab/writeCrontab/
 * readConfigFile/writeConfig/mkdirSync/openSync/closeSync/unlinkSync/rmSync/nodeBin/scriptDir/
 * homeDir/env/log).
 */
function makeMemoryDeps(overrides = {}) {
  const state = {
    crontabText: overrides.initialCrontab ?? "",
    configs: new Map(overrides.initialConfigs ? Object.entries(overrides.initialConfigs) : []),
    locks: new Set(),
    writeConfigCalls: [],
    writeCrontabCalls: [],
  };

  const deps = {
    homeDir: overrides.homeDir ?? HOME_DIR,
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
    mkdirSync: () => {},
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
      state.locks.delete(path);
    },
    rmSync: () => {},
    nodeBin: NODE_BIN,
    scriptDir: SCRIPT_DIR,
    log: () => {},
  };

  return { deps, state };
}

// ---------------------------------------------------------------------------------------------
// reconcileFleet: per-entry owner/repo (#ac-1.1)
// ---------------------------------------------------------------------------------------------

test("[#ac-1.1] reconcileFleet: installing a second project on a DIFFERENT repo returns without throwing and the new entry carries its OWN owner/repo", () => {
  const existingFleet = {
    project: "proj-a",
    owner: "owner-a",
    repo: "repo-a",
    projectRoot: "/srv/proj-a",
    stateDir: "/srv/proj-a/.claude/state",
    worktreeRoot: "/srv/worktrees",
    homeDir: HOME_DIR,
    projects: [
      {
        project: "proj-a",
        projectRoot: "/srv/proj-a",
        stateDir: "/srv/proj-a/.claude/state",
        owner: "owner-a",
        repo: "repo-a",
      },
    ],
  };
  const coordsB = {
    project: "proj-b",
    owner: "owner-b",
    repo: "repo-b",
    projectRoot: "/srv/proj-b",
    stateDir: "/srv/proj-b/.claude/state",
    worktreeRoot: "/srv/worktrees",
    homeDir: HOME_DIR,
  };

  let fleet;
  assert.doesNotThrow(() => {
    fleet = reconcileFleet(existingFleet, ["proj-a"], coordsB);
  });

  const entryB = fleet.projects.find((p) => p.project === "proj-b");
  assert.deepEqual(entryB, {
    project: "proj-b",
    owner: "owner-b",
    repo: "repo-b",
    projectRoot: coordsB.projectRoot,
    stateDir: coordsB.stateDir,
  });
});

test("[#ac-1.1] [C1] reconcileFleet: a sibling entry's explicit owner/repo survives installing a third project untouched (never stamped with the new project's owner/repo, nor with the fleet's top-level owner/repo)", () => {
  const existingFleet = {
    project: "proj-a",
    owner: "owner-x",
    repo: "repo-x",
    projectRoot: "/srv/proj-x",
    stateDir: "/srv/proj-x/.claude/state",
    worktreeRoot: "/srv/worktrees",
    homeDir: HOME_DIR,
    projects: [
      {
        project: "proj-a",
        projectRoot: "/srv/proj-a",
        stateDir: "/srv/proj-a/.claude/state",
        owner: "owner-a",
        repo: "repo-a",
      },
    ],
  };
  const coordsC = {
    project: "proj-c",
    owner: "owner-c",
    repo: "repo-c",
    projectRoot: "/srv/proj-c",
    stateDir: "/srv/proj-c/.claude/state",
    worktreeRoot: "/srv/worktrees",
    homeDir: HOME_DIR,
  };

  let fleet;
  assert.doesNotThrow(() => {
    fleet = reconcileFleet(existingFleet, ["proj-a"], coordsC);
  });

  const entryA = fleet.projects.find((p) => p.project === "proj-a");
  assert.equal(entryA.owner, "owner-a");
  assert.equal(entryA.repo, "repo-a");
});

test("[#ac-1.1] [C1] reconcileFleet: a LEGACY sibling entry with no owner/repo is backfilled from the fleet's top-level owner/repo when a third project is installed (never undefined, never the new project's owner/repo)", () => {
  const existingFleet = {
    project: "proj-a",
    owner: "owner-a",
    repo: "repo-a",
    projectRoot: "/srv/proj-a",
    stateDir: "/srv/proj-a/.claude/state",
    worktreeRoot: "/srv/worktrees",
    homeDir: HOME_DIR,
    projects: [
      { project: "proj-a", projectRoot: "/srv/proj-a", stateDir: "/srv/proj-a/.claude/state" },
    ],
  };
  const coordsC = {
    project: "proj-c",
    owner: "owner-c",
    repo: "repo-c",
    projectRoot: "/srv/proj-c",
    stateDir: "/srv/proj-c/.claude/state",
    worktreeRoot: "/srv/worktrees",
    homeDir: HOME_DIR,
  };

  let fleet;
  assert.doesNotThrow(() => {
    fleet = reconcileFleet(existingFleet, ["proj-a"], coordsC);
  });

  const entryA = fleet.projects.find((p) => p.project === "proj-a");
  assert.equal(entryA.owner, "owner-a");
  assert.equal(entryA.repo, "repo-a");
});

// ---------------------------------------------------------------------------------------------
// installProject: end-to-end composition root (#ac-1.1)
// ---------------------------------------------------------------------------------------------

test("[#ac-1.1] installProject: registering proj-b on owner-b/repo-b against a fleet already registered for owner-a/repo-a does not throw, and the reaper.json write carries proj-b's own owner/repo", () => {
  const existingFleet = {
    project: "proj-a",
    owner: "owner-a",
    repo: "repo-a",
    projectRoot: "/srv/proj-a",
    stateDir: "/srv/proj-a/.claude/state",
    worktreeRoot: "/srv/worktrees",
    homeDir: HOME_DIR,
    projects: [
      {
        project: "proj-a",
        projectRoot: "/srv/proj-a",
        stateDir: "/srv/proj-a/.claude/state",
        owner: "owner-a",
        repo: "repo-a",
      },
    ],
  };
  const initialCrontab = `${projectBlockFixture("proj-a")}\n`;
  const initialConfigs = { [fleetPathFor()]: existingFleet };
  const { deps, state } = makeMemoryDeps({ initialCrontab, initialConfigs });

  const coordsB = {
    project: "proj-b",
    owner: "owner-b",
    repo: "repo-b",
    projectRoot: "/srv/proj-b",
    stateDir: "/srv/proj-b/.claude/state",
    worktreeRoot: "/srv/worktrees",
    homeDir: HOME_DIR,
  };

  assert.doesNotThrow(() => installProject(coordsB, deps));

  const fleetWrite = state.writeConfigCalls.find((c) => c.path === fleetPathFor());
  assert.ok(fleetWrite, "installProject must writeConfig the reaper.json fleet file");
  const entryB = fleetWrite.obj.projects.find((p) => p.project === "proj-b");
  assert.ok(entryB, "reaper.json must contain a projects[] entry for proj-b");
  assert.equal(entryB.owner, "owner-b");
  assert.equal(entryB.repo, "repo-b");
});
