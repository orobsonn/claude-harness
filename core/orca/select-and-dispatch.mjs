/**
 * @description The multi-project delivery SELECTOR — the whole scheduled surface of the Orca-based
 * autonomous pipeline. It replaces the VPS cron engine (`core/vps/`, retiring — see
 * `core/vps/DEPRECATED.md`) with the smallest thing that still does the one job a scheduler must do:
 * decide WHICH issue runs next, take the lock, and hand it to Orca.
 *
 * The architecture this belongs to is two LAYERS, not two engines:
 *   • Orca (headless `orca serve` on the VPS, paired over Tailscale) DISPATCHES — it creates the
 *     worktree, launches the agent, and is the operator's window into the run from desktop/phone.
 *   • The repo's own vendored `.claude/` harness EXECUTES — the agent launched inside an Orca
 *     worktree reads the repo's `.claude/`, so the vendored pipeline IS the pipeline. Nothing here
 *     needs a dispatcher of its own; that is exactly the duplication `core/vps/` was.
 *
 * What this script deliberately does NOT do (each was a measured failure of the engine it replaces):
 *   • It does not rank by `createdAt` alone with no other filter. The engine's `cron-a-select.mjs`
 *     sorted open `harness:ready` issues oldest-first and applied no title/scope filter, so on a
 *     real backlog the FIRST thing it picked was a five-month-old PII hard-delete task — which makes
 *     a canary rollout impossible. Here `titleIncludes` is an explicit, per-project canary knob.
 *   • It does not decide "dependency satisfied" from a BRANCH NAME. The engine's
 *     `chain-release.mjs:dependencyMerged` only counted a dependency as met when a merged PR existed
 *     whose head was literally `harness/<N>`; an issue delivered by an ordinary PR never satisfied
 *     that, so its dependents sat at `harness:queued` forever (4 of 14 issues in one project were
 *     dead this way, and `chain-validate.mjs` could not see it — it only catches cycles and dangling
 *     refs). Here a dependency is satisfied when the dependency ISSUE is CLOSED: the state that
 *     actually means "delivered", independent of how it was delivered.
 *   • It does not GUESS the shape of anything the Orca CLI returns. Every `--json` command answers
 *     with the envelope `{ id, ok, result, _meta }`; the payload is under `result`. v0.57.0 shipped a
 *     `parseWorktreePs` that read `value.worktrees` — a shape nobody ever observed — so every tick
 *     skipped with "could not read", silently, forever. The frozen oracle did not catch it because
 *     the oracle asserted the SAME invented shape: test and code agreed with each other and both
 *     disagreed with reality. Boundary shapes are now anchored on a CAPTURED fixture
 *     (`__fixtures__/worktree-ps.json`) and unwrapped ONCE at the boundary by `unwrapOrca`, never
 *     per command — the envelope belongs to the CLI, so a parser per command re-arms the same mine
 *     for the next integrator. This is the same class of defect as the two above (local base ref,
 *     and the branch-name gate the retired engine died of): a piece assuming what another will say
 *     without ever having looked.
 *   • It does not dispatch on a LOCAL base ref. Passing `--base-branch main` looks right and is
 *     silently wrong: Orca resolves it against the clone it builds worktrees from, and that clone
 *     fetches from the remote but never advances its local branch. Every run then starts from
 *     wherever the clone was created and conflicts with everything merged since — and because the
 *     symptom only appears hours later, at merge time, as a conflict in files the run never touched,
 *     it reads as a harness bug rather than a base bug. Fetching alone does not fix it either: the
 *     local branch still does not move. The base must be asked for by its REMOTE name.
 *   • It does not run as root out of a shell carrying every client's deploy tokens. It is a user
 *     cron; credentials load per project, on demand (see `core/orca/README.md`).
 *
 * Concurrency is a GLOBAL ceiling, not a per-project one: `orca worktree ps --json` is asked how
 * many worktrees are `working` across the whole VPS, and a tick that would exceed the ceiling is
 * skipped entirely. Every project file must therefore carry the SAME `globalMaxWorking` — it is a
 * property of the machine (validated at 4 concurrent Claude agents on 2 vCPU / 8 GB), not of the
 * project.
 *
 * Ordering is load-bearing: the label flip `harness:ready` → `harness:in-progress` happens BEFORE
 * any worktree exists. A crash between the flip and a successful `worktree create` returns the issue
 * to the queue; an issue is never left silently stuck in `harness:in-progress` by this script.
 *
 * Every side-effecting seam (`orca`, `gh`) is injected, so `select-and-dispatch.test.mjs` runs
 * hermetic — no real CLI is spawned from the oracle.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseDependsOn } from "../shared/lib/harness-deps.mjs";

export const LABEL_READY = "harness:ready";
export const LABEL_IN_PROGRESS = "harness:in-progress";

/**
 * @description Thrown when the Orca CLI answers with `ok: false`. This is a REPORTED FAILURE, which
 * is a different state from "I could not read the answer" — the CLI ran, understood the request, and
 * said no. Collapsing the two into one skip reason produces a log line that cannot distinguish an
 * Orca that is down from an Orca that refused, and those need different repairs.
 */
export class OrcaRefusedError extends Error {}

/**
 * @description Unwraps the Orca CLI's response envelope at the BOUNDARY, once, for every command.
 *
 * Every `--json` command answers with the same envelope — measured on a live headless AppImage:
 *   `orca status`, `orca repo list`, `orca worktree list`, `orca worktree ps`
 *   → `{ id, ok, result, _meta }`
 * The payload lives under `result`; `worktree ps` puts `{ worktrees, totalCount, truncated }` there.
 *
 * This is deliberately NOT a per-command parser. The envelope is a property of the CLI, not of any
 * one command, so a parser per command re-arms the same mine for whoever integrates the next one —
 * which is exactly how `parseWorktreePs` shipped reading `value.worktrees` (a shape that never
 * existed) and made the selector skip 100% of its ticks in silence.
 *
 * Bare shapes still pass through untouched, so an injected test seam can hand over a plain array.
 * @param {unknown} raw parsed JSON, or a JSON string
 * @returns {unknown} the unwrapped payload
 * @throws {OrcaRefusedError} when the envelope carries `ok: false`
 */
export function unwrapOrca(raw) {
  let value = raw;
  if (typeof value === "string") value = JSON.parse(value);
  if (value && typeof value === "object" && !Array.isArray(value) && "ok" in value) {
    if (value.ok !== true) {
      throw new OrcaRefusedError(`orca answered ok:false — ${JSON.stringify(value).slice(0, 200)}`);
    }
    return value.result;
  }
  return value;
}

/**
 * @description Normalizes whatever `orca worktree ps --json` returned into a flat array. Accepts the
 * real response envelope, a bare `{ worktrees: [...] }`, a bare array, or a JSON string of any of
 * those. Anything else yields `null` — DISTINCT from `[]`, because "the ceiling could not be read"
 * must skip the tick rather than be mistaken for "nothing is running" (that mistake is how a
 * concurrency ceiling silently becomes no ceiling at all under a transient CLI failure).
 *
 * `truncated: true` is treated as UNREADABLE for the same reason: a truncated list undercounts the
 * busy worktrees, and an undercounted ceiling is no ceiling. The fixture in `__fixtures__/` is a
 * captured real response — the shape here is observed, never assumed.
 * @param {unknown} raw
 * @returns {object[]|null}
 * @throws {OrcaRefusedError} propagated from unwrapOrca — a refusal is not an unreadable answer
 */
export function parseWorktreePs(raw) {
  let value;
  try {
    value = unwrapOrca(raw);
  } catch (err) {
    if (err instanceof OrcaRefusedError) throw err;
    return null; // malformed JSON → unreadable
  }
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && Array.isArray(value.worktrees)) {
    if (value.truncated === true) return null;
    return value.worktrees;
  }
  return null;
}

/**
 * @description Counts worktrees currently occupying an agent slot — `status === "working"`. Any
 * other status (idle, done, failed, review) is not consuming a slot.
 * @param {object[]} entries
 * @returns {number}
 */
export function countWorking(entries) {
  if (!Array.isArray(entries)) return 0;
  return entries.filter((e) => e && typeof e === "object" && e.status === "working").length;
}

/**
 * @description The open `harness:ready` issues that are candidates for this tick, oldest FIRST.
 * Excludes anything already carrying `harness:in-progress` (defense-in-depth against a double
 * dispatch when a previous tick's label write landed but its bookkeeping did not). `titleIncludes`,
 * when set, is a case-insensitive substring filter on the title — the canary knob: it lets an
 * operator open the pipeline to `[canary]`-titled issues only, instead of to whatever happens to be
 * the oldest thing in a years-old backlog.
 * @param {object[]} issues raw `gh issue list --json number,title,createdAt,body,labels` rows
 * @param {{ titleIncludes?: string|null }} [opts]
 * @returns {object[]}
 */
export function eligibleIssues(issues, opts = {}) {
  const { titleIncludes = null } = opts;
  const needle = typeof titleIncludes === "string" && titleIncludes.length > 0
    ? titleIncludes.toLowerCase()
    : null;
  const hasLabel = (issue, name) =>
    (issue?.labels ?? []).some((label) => (label?.name ?? label) === name);
  return (Array.isArray(issues) ? issues : [])
    .filter((issue) => issue && typeof issue.number === "number")
    .filter((issue) => !hasLabel(issue, LABEL_IN_PROGRESS))
    .filter((issue) => (needle === null ? true : String(issue.title ?? "").toLowerCase().includes(needle)))
    .sort((a, b) => {
      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      if (ta !== tb) return ta - tb;
      return a.number - b.number;
    });
}

/**
 * @description Walks the eligible issues oldest-first and returns the first one whose declared
 * `harness-deps` are ALL closed. An issue with no declared dependency is picked immediately. A
 * dependency whose state cannot be read counts as NOT closed (fail-closed): a `gh` hiccup must never
 * be able to release a gated issue onto a base branch that lacks its dependency's code.
 * @param {object} opts
 * @param {object[]} opts.issues eligible issues, oldest-first
 * @param {(n: number) => boolean} opts.isClosed dependency-state probe
 * @returns {object|null}
 */
export function selectIssue(opts) {
  const { issues, isClosed } = opts;
  for (const candidate of issues) {
    const deps = parseDependsOn(candidate.body);
    if (deps.every((dep) => isClosed(dep) === true)) return candidate;
  }
  return null;
}

/**
 * @description Validates a project config and fills the optional fields. Throws on a missing
 * required field — a project whose config is wrong must fail LOUDLY on the next tick, never quietly
 * select nothing (a silent no-op is indistinguishable from an empty queue, which is how the old
 * fleet sat fully PAUSED without anyone noticing).
 * @param {object} raw parsed project JSON
 * @returns {{project:string,ghRepo:string,orcaRepoId:string,clonePath:string,baseBranch:string,agent:string,globalMaxWorking:number,titleIncludes:string|null,prompt:string}}
 */
export function normalizeConfig(raw) {
  const cfg = raw && typeof raw === "object" ? raw : {};
  const required = (field) => {
    const v = cfg[field];
    if (typeof v !== "string" || v.trim() === "") {
      throw new Error(`select-and-dispatch: project config field "${field}" is required`);
    }
    return v.trim();
  };
  const ceiling = Number(cfg.globalMaxWorking);
  if (!Number.isInteger(ceiling) || ceiling < 1) {
    throw new Error('select-and-dispatch: project config field "globalMaxWorking" must be an integer >= 1');
  }
  return {
    project: required("project"),
    ghRepo: required("ghRepo"),
    orcaRepoId: required("orcaRepoId"),
    // REQUIRED, and required for a reason — see the stale-base contract in the module header.
    // Without a clone to fetch in, `baseBranch` can only be resolved as the clone's LOCAL ref, which
    // never advances. Defaulting this field would restore exactly the silent bug it exists to kill.
    clonePath: required("clonePath"),
    baseBranch: typeof cfg.baseBranch === "string" && cfg.baseBranch.trim() !== "" ? cfg.baseBranch.trim() : "main",
    agent: typeof cfg.agent === "string" && cfg.agent.trim() !== "" ? cfg.agent.trim() : "claude",
    globalMaxWorking: ceiling,
    titleIncludes:
      typeof cfg.titleIncludes === "string" && cfg.titleIncludes.trim() !== "" ? cfg.titleIncludes.trim() : null,
    prompt:
      typeof cfg.prompt === "string" && cfg.prompt.trim() !== ""
        ? cfg.prompt.trim()
        : "Rode em MODO AUTÔNOMO (headless). Siga a entry-policy do .claude/ deste repo.",
  };
}

/**
 * @description One tick for one project. See the module header for the ordering contract.
 * @param {object} deps
 * @param {object} deps.config normalized project config
 * @param {(args: string[]) => any} deps.orca `orca` CLI seam (returns parsed JSON for `--json` calls)
 * @param {(args: string[]) => any} deps.gh `gh` CLI seam
 * @param {(args: string[]) => any} deps.git `git` CLI seam (used only to freshen the base ref)
 * @param {(text: string) => void} [deps.log]
 * @returns {{ok:boolean, dispatched:boolean, reason?:string, issue?:number}}
 */
export function runTick(deps) {
  const { config, orca, gh, git, log = () => {} } = deps;

  // 1) GLOBAL concurrency ceiling, read fresh. Unreadable → skip (never assume "nothing running").
  //    THROWING is the common failure here, not garbage output: the real seam shells out, and a
  //    non-zero exit (orca down, socket gone, binary moved) raises. Both paths must land on the same
  //    skip — an uncaught throw in a cron is a stack trace in a log nobody reads.
  let entries;
  try {
    entries = parseWorktreePs(orca(["worktree", "ps", "--json"]));
  } catch (err) {
    // A REFUSAL is not an unreadable answer. Orca ran, understood, and said no — that is a different
    // repair from "Orca is down", and a shared skip reason would hide which one happened.
    if (err instanceof OrcaRefusedError) {
      log(`[${config.project}] skip: ${err.message}`);
      return { ok: false, dispatched: false, reason: "ps-refused" };
    }
    entries = null;
  }
  if (entries === null) {
    log(`[${config.project}] skip: could not read 'orca worktree ps --json'`);
    return { ok: false, dispatched: false, reason: "ps-unreadable" };
  }
  const working = countWorking(entries);
  if (working >= config.globalMaxWorking) {
    log(`[${config.project}] skip: ${working}/${config.globalMaxWorking} worktrees working`);
    return { ok: true, dispatched: false, reason: "ceiling" };
  }

  // 2) Candidates. A `gh` failure here is a skipped tick, never a crash — nothing has been mutated
  //    yet, so retrying on the next tick is free and correct.
  let issues;
  try {
    issues = gh([
      "issue", "list",
      "--repo", config.ghRepo,
      "--label", LABEL_READY,
      "--state", "open",
      // `body` is REQUIRED — it carries the ```harness-deps``` block the gate below reads.
      "--json", "number,title,createdAt,body,labels",
    ]);
  } catch (err) {
    log(`[${config.project}] skip: could not list issues — ${err?.message ?? err}`);
    return { ok: false, dispatched: false, reason: "issues-unreadable" };
  }
  const eligible = eligibleIssues(issues, { titleIncludes: config.titleIncludes });
  if (eligible.length === 0) {
    log(`[${config.project}] nothing ready`);
    return { ok: true, dispatched: false, reason: "empty" };
  }

  // 3) Dependency gate on ISSUE STATE — never on a branch name.
  const isClosed = (n) => {
    try {
      const view = gh(["issue", "view", String(n), "--repo", config.ghRepo, "--json", "state"]);
      return String(view?.state ?? "").toUpperCase() === "CLOSED";
    } catch {
      return false; // fail-closed
    }
  };
  const picked = selectIssue({ issues: eligible, isClosed });
  if (!picked) {
    log(`[${config.project}] all ready issues are still waiting on open dependencies`);
    return { ok: true, dispatched: false, reason: "deps-pending" };
  }

  // 3.5) Freshen the base ref BEFORE taking the lock. The clone Orca builds worktrees from fetches
  //      from the remote but never advances its LOCAL branch, so `--base-branch main` resolves to
  //      wherever that clone happened to be when it was created — a base that silently ages by a
  //      commit every time anything merges. Every run then starts behind and conflicts with work it
  //      never touched, and the symptom only surfaces hours later, at merge time. Fetching is not
  //      enough on its own: the local branch still does not move, so the dispatch below must ask for
  //      the REMOTE ref by name. A failed fetch skips the tick — nothing has been mutated yet, and
  //      dispatching on a base we could not verify is the bug this step exists to prevent.
  try {
    git(["-C", config.clonePath, "fetch", "origin", config.baseBranch, "--quiet"]);
  } catch (err) {
    log(`[${config.project}] skip: could not fetch ${config.baseBranch} in ${config.clonePath} — ${err?.message ?? err}`);
    return { ok: false, dispatched: false, reason: "fetch-failed" };
  }
  const baseRef = `origin/${config.baseBranch}`;

  // 4) Take the lock BEFORE any worktree exists.
  try {
    gh([
      "issue", "edit", String(picked.number),
      "--repo", config.ghRepo,
      "--add-label", LABEL_IN_PROGRESS,
      "--remove-label", LABEL_READY,
    ]);
  } catch (err) {
    log(`[${config.project}] could not lock #${picked.number}: ${err?.message ?? err}`);
    return { ok: false, dispatched: false, reason: "lock-failed", issue: picked.number };
  }

  // 5) Dispatch. On failure the issue goes straight back to the queue — never left stuck.
  try {
    orca([
      "worktree", "create",
      "--repo", `id:${config.orcaRepoId}`,
      // `--name` is load-bearing, not cosmetic: the PR-review automation selects the PRs it may
      // merge with `headRefName` matching /harness-[0-9]+$/. Let Orca name the worktree itself and
      // nothing ever matches — the delivery half runs and the review half silently never picks it up.
      "--name", `harness-${picked.number}`,
      "--issue", String(picked.number),
      "--agent", config.agent,
      "--base-branch", baseRef,
      // Explicit: without it Orca infers lineage from the calling context, and a cron has none.
      "--no-parent",
      "--prompt", config.prompt,
    ]);
  } catch (err) {
    log(`[${config.project}] worktree create failed for #${picked.number}: ${err?.message ?? err}`);
    try {
      gh([
        "issue", "edit", String(picked.number),
        "--repo", config.ghRepo,
        "--add-label", LABEL_READY,
        "--remove-label", LABEL_IN_PROGRESS,
      ]);
    } catch (unlockErr) {
      // Loud: this is the one state a human must repair by hand.
      log(`[${config.project}] STUCK: #${picked.number} is in-progress with no worktree — ${unlockErr?.message ?? unlockErr}`);
      return { ok: false, dispatched: false, reason: "stuck", issue: picked.number };
    }
    return { ok: false, dispatched: false, reason: "dispatch-failed", issue: picked.number };
  }

  log(`[${config.project}] dispatched #${picked.number} — ${picked.title ?? ""}`);
  return { ok: true, dispatched: true, issue: picked.number };
}

// ---------- real seams + CLI ----------

/**
 * @description Runs a CLI and parses stdout as JSON when the argv asks for `--json`; otherwise
 * returns the raw stdout. Throws on non-zero exit, which is what the tick's try/catch rails expect.
 * @param {string} bin
 * @returns {(args: string[]) => any}
 */
function cliSeam(bin) {
  return (args) => {
    const stdout = execFileSync(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (!args.includes("--json")) return stdout;
    try {
      return JSON.parse(stdout);
    } catch {
      return null;
    }
  };
}

/**
 * @description CLI: `node select-and-dispatch.mjs --config <project.json>`. One project per
 * invocation; parallelism across projects is one more JSON file and one more crontab line.
 * @param {string[]} argv
 * @returns {number} process exit code
 */
export function main(argv) {
  const i = argv.indexOf("--config");
  if (i === -1 || !argv[i + 1]) {
    process.stderr.write("usage: node select-and-dispatch.mjs --config <project.json>\n");
    return 2;
  }
  let config;
  try {
    config = normalizeConfig(JSON.parse(readFileSync(argv[i + 1], "utf8")));
  } catch (err) {
    process.stderr.write(`[select-and-dispatch] ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  let result;
  try {
    result = runTick({
      config,
      orca: cliSeam(process.env.ORCA_BIN || "orca"),
      gh: cliSeam(process.env.GH_BIN || "gh"),
      git: cliSeam(process.env.GIT_BIN || "git"),
      log: (t) => process.stdout.write(`${t}\n`),
    });
  } catch (err) {
    // Last-resort rail: a cron log should carry one readable line, not a Node stack trace.
    process.stderr.write(`[select-and-dispatch] tick failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  return result.ok ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
