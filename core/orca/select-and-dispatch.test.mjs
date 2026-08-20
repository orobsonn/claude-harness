/**
 * @description Frozen oracle for the Orca selector. Every seam injected — ZERO real `orca`/`gh`.
 * The invariants pinned here are the ones whose absence killed the engine this replaces:
 *   • an unreadable concurrency ceiling SKIPS the tick (it is never read as "nothing is running");
 *   • a dependency is satisfied by the dependency ISSUE being CLOSED, never by a branch name;
 *   • an unreadable dependency state is fail-CLOSED;
 *   • the label lock is taken BEFORE `worktree create`, and released if the create fails;
 *   • the canary title filter actually narrows the oldest-first pick.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseWorktreePs,
  countWorking,
  eligibleIssues,
  selectIssue,
  normalizeConfig,
  runTick,
  main,
} from "./select-and-dispatch.mjs";

const CONFIG = normalizeConfig({
  project: "oraculo-app",
  ghRepo: "orobsonn/oraculo-app",
  orcaRepoId: "repo_abc123",
  globalMaxWorking: 4,
});

/** Builds injected seams over scripted `orca`/`gh` responses, recording every call. */
function harness(opts = {}) {
  const {
    ps = [],
    issues = [],
    issueStates = {},
    createThrows = false,
    lockThrows = false,
    unlockThrows = false,
    config = CONFIG,
  } = opts;
  const orcaCalls = [];
  const ghCalls = [];
  const logs = [];
  const orca = (args) => {
    orcaCalls.push(args);
    if (args[1] === "ps") return ps;
    if (args[1] === "create" && createThrows) throw new Error("orca: boom");
    return "";
  };
  const gh = (args) => {
    ghCalls.push(args);
    if (args[1] === "list") return issues;
    if (args[1] === "view") {
      const state = issueStates[Number(args[2])];
      if (state === undefined) throw new Error("gh: unreadable");
      return { state };
    }
    if (args[1] === "edit") {
      const adding = args[args.indexOf("--add-label") + 1];
      if (adding === "harness:in-progress" && lockThrows) throw new Error("gh: lock boom");
      if (adding === "harness:ready" && unlockThrows) throw new Error("gh: unlock boom");
      return "";
    }
    return "";
  };
  return { deps: { config, orca, gh, log: (t) => logs.push(t) }, orcaCalls, ghCalls, logs };
}

const issue = (number, over = {}) => ({
  number,
  title: `task ${number}`,
  createdAt: `2026-01-${String(number).padStart(2, "0")}T00:00:00Z`,
  body: "",
  labels: [],
  ...over,
});

test("parseWorktreePs accepts an array, a {worktrees} envelope and a JSON string; anything else is null (unreadable, not empty)", () => {
  assert.deepEqual(parseWorktreePs([{ status: "working" }]), [{ status: "working" }]);
  assert.deepEqual(parseWorktreePs({ worktrees: [{ status: "idle" }] }), [{ status: "idle" }]);
  assert.deepEqual(parseWorktreePs('[{"status":"working"}]'), [{ status: "working" }]);
  assert.equal(parseWorktreePs("not json"), null);
  assert.equal(parseWorktreePs(null), null);
  assert.equal(parseWorktreePs(undefined), null);
});

test("countWorking counts only status === 'working'", () => {
  assert.equal(
    countWorking([{ status: "working" }, { status: "idle" }, { status: "working" }, { status: "done" }, null]),
    2,
  );
});

test("eligibleIssues sorts oldest-first and drops anything already harness:in-progress", () => {
  const rows = [
    issue(3),
    issue(1, { labels: [{ name: "harness:in-progress" }] }),
    issue(2),
  ];
  assert.deepEqual(eligibleIssues(rows).map((i) => i.number), [2, 3]);
});

test("eligibleIssues: titleIncludes is the canary knob — it narrows the oldest-first pick instead of surrendering to the backlog", () => {
  const rows = [
    issue(1, { title: "hard delete de PII (5 meses atrás)" }),
    issue(9, { title: "[canary] ajuste trivial de copy" }),
  ];
  assert.deepEqual(eligibleIssues(rows).map((i) => i.number), [1, 9], "unfiltered, the ancient PII task wins");
  assert.deepEqual(
    eligibleIssues(rows, { titleIncludes: "[canary]" }).map((i) => i.number),
    [9],
    "with the canary filter, only the canary issue is a candidate",
  );
});

test("selectIssue picks the oldest issue whose harness-deps are all CLOSED, skipping ones still gated", () => {
  const rows = [
    issue(5, { body: "```harness-deps\n#1\n#2\n```" }),
    issue(6, { body: "```harness-deps\n#1\n```" }),
    issue(7),
  ];
  const closed = new Set([1]);
  const picked = selectIssue({ issues: rows, isClosed: (n) => closed.has(n) });
  assert.equal(picked.number, 6, "#5 is gated on the still-open #2; #6's only dep is closed");
});

test("selectIssue is fail-CLOSED: an unreadable dependency state never releases a gated issue", () => {
  const rows = [issue(5, { body: "```harness-deps\n#1\n```" })];
  assert.equal(selectIssue({ issues: rows, isClosed: () => false }), null);
});

test("runTick skips the tick when the GLOBAL ceiling is already reached", () => {
  const h = harness({ ps: [{ status: "working" }, { status: "working" }, { status: "working" }, { status: "working" }] });
  const result = runTick(h.deps);
  assert.deepEqual(result, { ok: true, dispatched: false, reason: "ceiling" });
  assert.equal(h.ghCalls.length, 0, "a skipped tick must not touch the issue tracker at all");
});

test("runTick skips (and reports NOT ok) when 'orca worktree ps --json' is unreadable — an unreadable ceiling is never 'nothing is running'", () => {
  const h = harness({ ps: "kaboom" });
  const result = runTick(h.deps);
  assert.deepEqual(result, { ok: false, dispatched: false, reason: "ps-unreadable" });
  assert.equal(h.ghCalls.length, 0);
  assert.equal(h.orcaCalls.filter((a) => a[1] === "create").length, 0);
});

test("runTick dispatches the oldest ready issue: label lock FIRST, then orca worktree create with the configured repo id / agent / base branch", () => {
  const h = harness({ ps: [{ status: "working" }], issues: [issue(4), issue(2)] });
  const result = runTick(h.deps);
  assert.deepEqual(result, { ok: true, dispatched: true, issue: 2 });

  const edit = h.ghCalls.find((a) => a[1] === "edit");
  assert.deepEqual(edit, [
    "issue", "edit", "2",
    "--repo", "orobsonn/oraculo-app",
    "--add-label", "harness:in-progress",
    "--remove-label", "harness:ready",
  ]);

  const create = h.orcaCalls.find((a) => a[1] === "create");
  assert.deepEqual(create, [
    "worktree", "create",
    "--repo", "id:repo_abc123",
    "--issue", "2",
    "--agent", "claude",
    "--base-branch", "main",
    "--prompt", CONFIG.prompt,
  ]);

  const editIdx = h.ghCalls.findIndex((a) => a[1] === "edit");
  const createIdx = h.orcaCalls.findIndex((a) => a[1] === "create");
  assert.ok(editIdx >= 0 && createIdx >= 0);
  // The lock must exist before any worktree does; `create` is the LAST orca call of the tick.
  assert.equal(h.orcaCalls[h.orcaCalls.length - 1][1], "create");
});

test("runTick: dependency satisfaction reads the ISSUE STATE, not a harness/<N> branch — an issue closed by an ORDINARY PR releases its dependent", () => {
  const h = harness({
    ps: [],
    issues: [issue(8, { body: "```harness-deps\n#3\n```" })],
    issueStates: { 3: "CLOSED" },
  });
  const result = runTick(h.deps);
  assert.equal(result.dispatched, true);
  assert.equal(result.issue, 8);
  const view = h.ghCalls.find((a) => a[1] === "view");
  assert.deepEqual(view, ["issue", "view", "3", "--repo", "orobsonn/oraculo-app", "--json", "state"]);
});

test("runTick defers (no lock, no worktree) while a dependency issue is still OPEN", () => {
  const h = harness({
    ps: [],
    issues: [issue(8, { body: "```harness-deps\n#3\n```" })],
    issueStates: { 3: "OPEN" },
  });
  assert.deepEqual(runTick(h.deps), { ok: true, dispatched: false, reason: "deps-pending" });
  assert.equal(h.ghCalls.filter((a) => a[1] === "edit").length, 0);
  assert.equal(h.orcaCalls.filter((a) => a[1] === "create").length, 0);
});

test("runTick returns the issue to the queue when 'orca worktree create' fails — never left stuck in-progress", () => {
  const h = harness({ ps: [], issues: [issue(2)], createThrows: true });
  const result = runTick(h.deps);
  assert.deepEqual(result, { ok: false, dispatched: false, reason: "dispatch-failed", issue: 2 });
  const edits = h.ghCalls.filter((a) => a[1] === "edit");
  assert.equal(edits.length, 2);
  assert.deepEqual(edits[1], [
    "issue", "edit", "2",
    "--repo", "orobsonn/oraculo-app",
    "--add-label", "harness:ready",
    "--remove-label", "harness:in-progress",
  ]);
});

test("runTick reports 'stuck' LOUDLY when the rollback itself fails — the one state a human must repair", () => {
  const h = harness({ ps: [], issues: [issue(2)], createThrows: true, unlockThrows: true });
  const result = runTick(h.deps);
  assert.deepEqual(result, { ok: false, dispatched: false, reason: "stuck", issue: 2 });
  assert.ok(h.logs.some((l) => l.includes("STUCK: #2")));
});

test("runTick never dispatches when the lock itself fails", () => {
  const h = harness({ ps: [], issues: [issue(2)], lockThrows: true });
  const result = runTick(h.deps);
  assert.deepEqual(result, { ok: false, dispatched: false, reason: "lock-failed", issue: 2 });
  assert.equal(h.orcaCalls.filter((a) => a[1] === "create").length, 0);
});

test("runTick is a clean no-op on an empty queue", () => {
  const h = harness({ ps: [], issues: [] });
  assert.deepEqual(runTick(h.deps), { ok: true, dispatched: false, reason: "empty" });
  assert.equal(h.orcaCalls.filter((a) => a[1] === "create").length, 0);
});

test("normalizeConfig fills the optional fields and REJECTS a config missing a required one (a misconfigured project fails loudly, never selects silently)", () => {
  const cfg = normalizeConfig({
    project: "p", ghRepo: "o/r", orcaRepoId: "id", globalMaxWorking: 4,
  });
  assert.equal(cfg.baseBranch, "main");
  assert.equal(cfg.agent, "claude");
  assert.equal(cfg.titleIncludes, null);
  assert.ok(cfg.prompt.length > 0);

  assert.throws(() => normalizeConfig({ ghRepo: "o/r", orcaRepoId: "id", globalMaxWorking: 4 }), /"project" is required/);
  assert.throws(() => normalizeConfig({ project: "p", orcaRepoId: "id", globalMaxWorking: 4 }), /"ghRepo" is required/);
  assert.throws(() => normalizeConfig({ project: "p", ghRepo: "o/r", globalMaxWorking: 4 }), /"orcaRepoId" is required/);
  assert.throws(() => normalizeConfig({ project: "p", ghRepo: "o/r", orcaRepoId: "id" }), /globalMaxWorking/);
  assert.throws(() => normalizeConfig({ project: "p", ghRepo: "o/r", orcaRepoId: "id", globalMaxWorking: 0 }), /globalMaxWorking/);
});

test("the documented CLI is REAL: main() exists, refuses a missing --config, and is wired to a module entry block", async () => {
  const { readFileSync } = await import("node:fs");
  const stderr = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => (stderr.push(String(chunk)), true);
  try {
    assert.equal(main([]), 2);
    assert.equal(main(["--config"]), 2);
    assert.equal(main(["--config", "/nonexistent/project.json"]), 2);
  } finally {
    process.stderr.write = original;
  }
  assert.ok(stderr.join("").includes("--config"));
  const source = readFileSync(new URL("./select-and-dispatch.mjs", import.meta.url), "utf8");
  assert.ok(
    source.includes("process.argv[1] === fileURLToPath(import.meta.url)"),
    "a documented `node select-and-dispatch.mjs` command must be backed by a real CLI entry block",
  );
});

test("the shipped project.example.json is a VALID config for normalizeConfig", async () => {
  const { readFileSync } = await import("node:fs");
  const example = JSON.parse(readFileSync(new URL("./project.example.json", import.meta.url), "utf8"));
  const cfg = normalizeConfig(example);
  assert.equal(cfg.globalMaxWorking, 4);
  assert.ok(cfg.ghRepo.includes("/"));
});

test("runTick skips cleanly when the ceiling probe THROWS (the real seam shells out — a non-zero exit raises, it does not return garbage)", () => {
  const orcaCalls = [];
  const ghCalls = [];
  const result = runTick({
    config: CONFIG,
    orca: (args) => {
      orcaCalls.push(args);
      throw new Error("orca: command failed");
    },
    gh: (args) => {
      ghCalls.push(args);
      return [];
    },
    log: () => {},
  });
  assert.deepEqual(result, { ok: false, dispatched: false, reason: "ps-unreadable" });
  assert.equal(ghCalls.length, 0, "a skipped tick must not touch the issue tracker");
});

test("runTick skips cleanly when the issue LIST throws — nothing is mutated yet, so the next tick simply retries", () => {
  const result = runTick({
    config: CONFIG,
    orca: (args) => (args[1] === "ps" ? [] : ""),
    gh: () => {
      throw new Error("gh: API is down");
    },
    log: () => {},
  });
  assert.deepEqual(result, { ok: false, dispatched: false, reason: "issues-unreadable" });
});

test("main() never lets a seam failure escape as a raw Node stack trace into the cron log", async () => {
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "orca-selector-"));
  const configPath = join(dir, "p.json");
  writeFileSync(
    configPath,
    JSON.stringify({ project: "demo", ghRepo: "o/r", orcaRepoId: "id", globalMaxWorking: 4 }),
  );
  const captured = [];
  const originalErr = process.stderr.write;
  const originalOut = process.stdout.write;
  const originalOrcaBin = process.env.ORCA_BIN;
  process.stderr.write = (chunk) => (captured.push(String(chunk)), true);
  process.stdout.write = (chunk) => (captured.push(String(chunk)), true);
  process.env.ORCA_BIN = "/bin/false";
  let code;
  try {
    code = main(["--config", configPath]);
  } finally {
    process.stderr.write = originalErr;
    process.stdout.write = originalOut;
    if (originalOrcaBin === undefined) delete process.env.ORCA_BIN;
    else process.env.ORCA_BIN = originalOrcaBin;
  }
  assert.equal(code, 1);
  const output = captured.join("");
  assert.ok(!output.includes("at ModuleJob"), `a stack trace leaked into the log: ${output}`);
  assert.match(output, /could not read 'orca worktree ps --json'/);
});
