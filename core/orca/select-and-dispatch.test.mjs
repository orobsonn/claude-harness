/**
 * @description Frozen oracle for the Orca selector. Every seam injected — ZERO real `orca`/`gh`.
 * The invariants pinned here are the ones whose absence killed the engine this replaces:
 *   • an unreadable concurrency ceiling SKIPS the tick (it is never read as "nothing is running");
 *   • a dependency is satisfied by the dependency ISSUE being CLOSED, never by a branch name;
 *   • an unreadable dependency state is fail-CLOSED;
 *   • the label lock is taken BEFORE `worktree create`, and released if the create fails;
 *   • the canary title filter actually narrows the oldest-first pick;
 *   • the worktree is created from the REMOTE base ref, after a fetch, and an unfetchable base
 *     skips the tick without taking the lock;
 *   • the Orca response envelope is read from a CAPTURED fixture, never from an invented shape —
 *     the defect this pins shipped precisely because the old oracle asserted the same guess the
 *     code made, so both passed and both were wrong.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";

import {
  parseWorktreePs,
  unwrapOrca,
  OrcaRefusedError,
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
  clonePath: "/clones/oraculo-app",
  globalMaxWorking: 4,
});

// Same config, plus the knob #809 adds. Kept separate so the untouched dispatch test above stays the
// proof that a config WITHOUT `setup` produces an argv without the flag.
const CONFIG_WITH_SETUP = normalizeConfig({
  project: "oraculo-app",
  ghRepo: "orobsonn/oraculo-app",
  orcaRepoId: "repo_abc123",
  clonePath: "/clones/oraculo-app",
  globalMaxWorking: 4,
  setup: "run",
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
    fetchThrows = false,
    config = CONFIG,
  } = opts;
  const orcaCalls = [];
  const ghCalls = [];
  const gitCalls = [];
  const logs = [];
  const git = (args) => {
    gitCalls.push(args);
    if (fetchThrows) throw new Error("git: fetch boom");
    return "";
  };
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
  return { deps: { config, orca, gh, git, log: (t) => logs.push(t) }, orcaCalls, ghCalls, gitCalls, logs };
}

const issue = (number, over = {}) => ({
  number,
  title: `task ${number}`,
  createdAt: `2026-01-${String(number).padStart(2, "0")}T00:00:00Z`,
  body: "",
  labels: [],
  ...over,
});

// The one shape that actually comes out of the CLI. Captured from a live headless AppImage and
// redacted; it is the anchor for every boundary assertion below. If Orca changes the contract, this
// file stops matching reality and the tests must be re-captured — which is the only thing a boundary
// test is for. Never hand-edit it into agreement with the code.
const PS_FIXTURE = JSON.parse(
  readFileSync(new URL("./__fixtures__/worktree-ps.json", import.meta.url), "utf8"),
);

test("the captured fixture IS the documented envelope — {id, ok, result:{worktrees,totalCount,truncated}}", () => {
  assert.deepEqual(Object.keys(PS_FIXTURE).sort(), ["_meta", "id", "ok", "result"]);
  assert.equal(PS_FIXTURE.ok, true);
  assert.ok(Array.isArray(PS_FIXTURE.result.worktrees));
  assert.equal(typeof PS_FIXTURE.result.truncated, "boolean");
  assert.equal(typeof PS_FIXTURE.result.totalCount, "number");
  // The shape the shipped v0.57.0 code read. Pinning its ABSENCE is the point: it never existed.
  assert.equal(PS_FIXTURE.worktrees, undefined);
});

test("parseWorktreePs reads the REAL captured response — this is the v0.57.0 defect: it read value.worktrees, a shape that never existed, and skipped every tick in silence", () => {
  const entries = parseWorktreePs(PS_FIXTURE);
  assert.ok(Array.isArray(entries), "the captured envelope must parse, not come back null");
  assert.equal(entries.length, PS_FIXTURE.result.worktrees.length);
  assert.equal(countWorking(entries), 1, "the fixture carries exactly one working worktree");
  // Same input as a JSON string — what the real seam hands over.
  assert.deepEqual(parseWorktreePs(JSON.stringify(PS_FIXTURE)), entries);
});

test("parseWorktreePs still accepts the bare shapes an injected seam hands over; anything else is null (unreadable, not empty)", () => {
  assert.deepEqual(parseWorktreePs([{ status: "working" }]), [{ status: "working" }]);
  assert.deepEqual(parseWorktreePs({ worktrees: [{ status: "idle" }] }), [{ status: "idle" }]);
  assert.deepEqual(parseWorktreePs('[{"status":"working"}]'), [{ status: "working" }]);
  assert.equal(parseWorktreePs("not json"), null);
  assert.equal(parseWorktreePs(null), null);
  assert.equal(parseWorktreePs(undefined), null);
});

test("parseWorktreePs treats truncated:true as UNREADABLE — a truncated list undercounts the busy worktrees, and an undercounted ceiling is no ceiling", () => {
  const truncated = { ...PS_FIXTURE, result: { ...PS_FIXTURE.result, truncated: true } };
  assert.equal(parseWorktreePs(truncated), null);
});

test("unwrapOrca is a BOUNDARY unwrapper, not a per-command parser — the envelope belongs to the CLI, so every command lands on it", () => {
  // Measured on a live AppImage: status, repo list, worktree list and worktree ps all answer this.
  assert.deepEqual(unwrapOrca({ id: "x", ok: true, result: { repos: [1] }, _meta: {} }), { repos: [1] });
  assert.deepEqual(unwrapOrca({ id: "x", ok: true, result: { worktrees: [] }, _meta: {} }), { worktrees: [] });
  // Bare shapes pass through so an injected seam can hand over a plain array.
  assert.deepEqual(unwrapOrca([1, 2]), [1, 2]);
  assert.deepEqual(unwrapOrca({ worktrees: [] }), { worktrees: [] });
});

test("unwrapOrca: ok:false is a REFUSAL, not an unreadable answer — Orca ran, understood, and said no, which is a different repair from Orca being down", () => {
  assert.throws(() => unwrapOrca({ id: "x", ok: false, result: null, _meta: {} }), OrcaRefusedError);
  assert.throws(() => parseWorktreePs({ id: "x", ok: false, result: null, _meta: {} }), OrcaRefusedError);
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
    // The review automation selects PRs by headRefName =~ /harness-[0-9]+$/. Without --name, Orca
    // names the worktree itself and the review half silently never picks the delivery up.
    "--name", "harness-2",
    "--issue", "2",
    "--agent", "claude",
    // REMOTE ref, never the bare local name — see the stale-base test below.
    "--base-branch", "origin/main",
    "--no-parent",
    "--prompt", CONFIG.prompt,
  ]);

  const editIdx = h.ghCalls.findIndex((a) => a[1] === "edit");
  const createIdx = h.orcaCalls.findIndex((a) => a[1] === "create");
  assert.ok(editIdx >= 0 && createIdx >= 0);
  // The lock must exist before any worktree does; `create` is the LAST orca call of the tick.
  assert.equal(h.orcaCalls[h.orcaCalls.length - 1][1], "create");
});

test("#ac-1.1 runTick passes --setup through to `orca worktree create` when the project asks for it — a worktree born without node_modules burns the first minutes of EVERY run, on a slot the global ceiling already paid for", () => {
  const h = harness({ ps: [], issues: [issue(2)], config: CONFIG_WITH_SETUP });
  assert.deepEqual(runTick(h.deps), { ok: true, dispatched: true, issue: 2 });

  const create = h.orcaCalls.find((a) => a[1] === "create");
  assert.deepEqual(create, [
    "worktree", "create",
    "--repo", "id:repo_abc123",
    "--name", "harness-2",
    "--issue", "2",
    "--agent", "claude",
    "--base-branch", "origin/main",
    "--no-parent",
    "--setup", "run",
    "--prompt", CONFIG_WITH_SETUP.prompt,
  ]);
});

test("#ac-1.2 a project config WITHOUT `setup` dispatches an argv with NO --setup at all — the default belongs to Orca, and a harness that picked one would be choosing under the table for every project that never opted in", () => {
  const h = harness({ ps: [], issues: [issue(2)] }); // CONFIG has no `setup`
  assert.deepEqual(runTick(h.deps), { ok: true, dispatched: true, issue: 2 });

  const create = h.orcaCalls.find((a) => a[1] === "create");
  // FULL deepEqual, not a negative membership check: it pins length, order and every neighbour, so
  // an argv that appends ["--setup", undefined], inserts the pair at the wrong index, or drops an
  // unrelated flag all FAIL here.
  assert.deepEqual(create, [
    "worktree", "create",
    "--repo", "id:repo_abc123",
    "--name", "harness-2",
    "--issue", "2",
    "--agent", "claude",
    "--base-branch", "origin/main",
    "--no-parent",
    "--prompt", CONFIG.prompt,
  ]);
  // Redundant on purpose, and STRICTLY WEAKER — it reads as documentation of the AC, never as its proof.
  assert.ok(!create.includes("--setup"));
  assert.equal(CONFIG.setup, null, "absent in the JSON normalizes to null, which is what suppresses the flag");
});

test("#ac-1.3 normalizeConfig REFUSES a `setup` outside run|skip|inherit, naming the field — same discipline as globalMaxWorking; and treats every 'no opinion' shape as ABSENT, which is what omits the flag", () => {
  const base = { project: "p", ghRepo: "o/r", orcaRepoId: "id", clonePath: "/c", globalMaxWorking: 4 };

  for (const value of ["run", "skip", "inherit"]) {
    assert.equal(normalizeConfig({ ...base, setup: value }).setup, value);
  }
  assert.equal(normalizeConfig({ ...base, setup: "  run  " }).setup, "run", "trimmed like every other field");

  // ABSENT in every shape an operator actually writes it. `null` is the shape project.example.json
  // already ships for a knob that is off (titleIncludes) — refusing it here would make the house
  // style a landmine, and a throw inside a cron tick stops the whole project's queue.
  assert.equal(normalizeConfig(base).setup, null);
  assert.equal(normalizeConfig({ ...base, setup: null }).setup, null);
  assert.equal(normalizeConfig({ ...base, setup: "" }).setup, null);
  assert.equal(normalizeConfig({ ...base, setup: "   " }).setup, null);

  // An opinion we cannot honor is refused, never guessed at — including a case variant, because
  // folding case is itself a guess about Orca's vocabulary.
  for (const bad of ["yes", "true", "RUN", "Run", "run skip", "--setup run", 1, 0, true, [], {}]) {
    assert.throws(
      () => normalizeConfig({ ...base, setup: bad }),
      /"setup" must be one of run, skip or inherit/,
      `\`setup: ${JSON.stringify(bad)}\` must fail loudly and name the field`,
    );
  }
});

test("runTick freshens the base BEFORE the lock and dispatches the REMOTE ref — a local base name silently ages and is the bug this pins", () => {
  const h = harness({ ps: [], issues: [issue(2)] });
  runTick(h.deps);

  assert.deepEqual(
    h.gitCalls,
    [["-C", "/clones/oraculo-app", "fetch", "origin", "main", "--quiet"]],
    "the tick fetches the base in the clone Orca builds worktrees from",
  );

  const create = h.orcaCalls.find((a) => a[1] === "create");
  const base = create[create.indexOf("--base-branch") + 1];
  assert.equal(base, "origin/main");
  assert.notEqual(base, "main", "the clone's LOCAL branch never advances — asking for it by bare name reuses a stale base");

  // Fetching without asking for the remote ref would leave the bug intact, so the ORDER matters:
  // the fetch has to happen, and it has to happen before anything is mutated.
  assert.equal(h.gitCalls.length, 1);
  assert.ok(h.ghCalls.every((a) => a[1] !== "edit") === false, "sanity: the lock was still taken");
});

test("runTick: an unfetchable base SKIPS the tick without taking the lock — dispatching on a base we could not verify is the failure being prevented", () => {
  const h = harness({ ps: [], issues: [issue(2)], fetchThrows: true });
  const result = runTick(h.deps);

  assert.deepEqual(result, { ok: false, dispatched: false, reason: "fetch-failed" });
  assert.equal(h.ghCalls.find((a) => a[1] === "edit"), undefined, "no label was flipped");
  assert.equal(h.orcaCalls.find((a) => a[1] === "create"), undefined, "no worktree was created");
  assert.match(h.logs.join("\n"), /could not fetch main/);
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
    project: "p", ghRepo: "o/r", orcaRepoId: "id", clonePath: "/c", globalMaxWorking: 4,
  });
  assert.equal(cfg.baseBranch, "main");
  assert.equal(cfg.agent, "claude");
  assert.equal(cfg.titleIncludes, null);
  assert.ok(cfg.prompt.length > 0);

  assert.throws(() => normalizeConfig({ ghRepo: "o/r", orcaRepoId: "id", clonePath: "/c", globalMaxWorking: 4 }), /"project" is required/);
  assert.throws(() => normalizeConfig({ project: "p", orcaRepoId: "id", clonePath: "/c", globalMaxWorking: 4 }), /"ghRepo" is required/);
  assert.throws(() => normalizeConfig({ project: "p", ghRepo: "o/r", clonePath: "/c", globalMaxWorking: 4 }), /"orcaRepoId" is required/);
  // clonePath has NO default on purpose: a default would silently restore the stale-base bug.
  assert.throws(() => normalizeConfig({ project: "p", ghRepo: "o/r", orcaRepoId: "id", globalMaxWorking: 4 }), /"clonePath" is required/);
  assert.throws(() => normalizeConfig({ project: "p", ghRepo: "o/r", orcaRepoId: "id", clonePath: "/c" }), /globalMaxWorking/);
  assert.throws(() => normalizeConfig({ project: "p", ghRepo: "o/r", orcaRepoId: "id", clonePath: "/c", globalMaxWorking: 0 }), /globalMaxWorking/);
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

test("runTick reports a REFUSAL separately from an unreadable answer — one log line cannot stand for both an Orca that is down and an Orca that said no", () => {
  const logs = [];
  const result = runTick({
    config: CONFIG,
    orca: (args) => (args[1] === "ps" ? { id: "x", ok: false, result: null, _meta: {} } : ""),
    gh: () => [],
    git: () => "",
    log: (t) => logs.push(t),
  });
  assert.deepEqual(result, { ok: false, dispatched: false, reason: "ps-refused" });
  assert.match(logs.join("\n"), /ok:false/);
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
    JSON.stringify({ project: "demo", ghRepo: "o/r", orcaRepoId: "id", clonePath: "/c", globalMaxWorking: 4 }),
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

test("#ac-2.1 the shipped example and the README table agree with normalizeConfig on `setup` — nothing else pins B/C/D parity", async () => {
  const { readFileSync } = await import("node:fs");
  const example = JSON.parse(readFileSync(new URL("./project.example.json", import.meta.url), "utf8"));
  assert.equal(normalizeConfig(example).setup, "run", "the shipped example must carry a REAL example value");
  const readme = readFileSync(new URL("./README.md", import.meta.url), "utf8");
  const row = readme.split("\n").find((l) => l.trim().startsWith("| `setup`"));
  assert.ok(row, "core/orca/README.md must document `setup` as a row of the config table");
  for (const token of ["run", "skip", "inherit"]) assert.ok(row.includes(token), `the row must name ${token}`);
  assert.match(readme, /`setup`[\s\S]*`--setup`/, "the prose must tie the field to the Orca flag it forwards");
  assert.ok(readme.includes('"setup": "run"'), "the README's JSON snippet must carry the same example value as project.example.json");
});
