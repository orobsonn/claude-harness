#!/usr/bin/env node
/**
 * @description VPS cron installer — registers/unregisters a project's per-project cron jobs
 * (Cron A + Cron B) and the ONE shared reaper cron in the operator's crontab, plus the matching
 * JSON configs under `~/.claude/harness-crons/`. Mirrors the run-cron-a.mjs seam idiom: every
 * side-effecting seam is injectable (`deps.x ?? realX`) so the frozen suite drives pure transforms
 * with plain strings/objects and the composition roots (installProject/uninstallProject) with
 * in-memory fakes — zero real crontab/fs mutation from tests. Node builtins only, zero deps.
 *
 * Path formulas (POSIX single-operator VPS; Windows-style paths fail isAbsolute → rejected):
 *   - per-project config: <homeDir>/.claude/harness-crons/<project>.json
 *   - reaper fleet config: <homeDir>/.claude/harness-crons/reaper.json
 *   - install lock:        <homeDir>/.claude/harness-crons/.install.lock
 */
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  rmSync,
  openSync,
  closeSync,
  unlinkSync,
} from "node:fs";
import { join, dirname, basename, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

import { loadConfig, REQUIRED_CONFIG_FIELDS } from "./run-cron-a.mjs";

const HARNESS_CRONS_SUBDIR = ".claude/harness-crons";
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;
const PROJECT_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const NAME_TOKEN = /^[A-Za-z0-9._-]+$/;
const PATH_SAFE = /^[A-Za-z0-9._/-]+$/;
const RESERVED_PROJECT = "reaper";

/** @description Absolute scriptDir the crontab lines invoke; injectable via deps.scriptDir. */
const DEFAULT_SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

/** @description Per-project config path — the single join() formula shared by both roots. */
function perProjectConfigPath(homeDir, project) {
  return join(homeDir, HARNESS_CRONS_SUBDIR, `${project}.json`);
}

/** @description Reaper fleet config path — the single join() formula shared by both roots. */
function fleetConfigPath(homeDir) {
  return join(homeDir, HARNESS_CRONS_SUBDIR, "reaper.json");
}

/** @description Install-lock path — the single join() formula the lock seam guards. */
function installLockPath(homeDir) {
  return join(homeDir, HARNESS_CRONS_SUBDIR, ".install.lock");
}

// ---------------------------------------------------------------------------------------------
// Pure transforms (seam-free)
// ---------------------------------------------------------------------------------------------

/**
 * @description Render-time guard for a token interpolated raw into a crontab line that cron runs
 * via /bin/sh. nodeBin (process.execPath) and the script path (join(scriptDir, ...)) are NOT
 * coordinates, so validateInstallCoordinates never sees them — a harness checked out under a path
 * with a space or a shell metachar would silently break every cron line. These tokens are always
 * absolute fs paths, so a conservative allowlist (PATH_SAFE) is correct; whitespace or any
 * shell/cron metacharacter throws.
 * @param {string} token
 * @param {string} label
 * @returns {void}
 */
function assertCronSafe(token, label) {
  if (typeof token !== "string" || token.length === 0 || !PATH_SAFE.test(token)) {
    throw new Error(`unsafe ${label} in cron line`);
  }
}

/**
 * @description Validates raw install coordinates into a known-field coords object, or throws an
 * Error naming ONLY the offending field (never echoing its raw value — a control char must never
 * reach a log). Stricter superset of loadConfig's presence check: project must be a slug and not
 * the reserved "reaper"; owner/repo/optional harnessAuthorLogin must be safe name tokens;
 * projectRoot/stateDir/worktreeRoot/homeDir must be absolute AND a conservative safe charset
 * (^[A-Za-z0-9._/-]+$ — rejects spaces, ";", "$", backtick, quotes… that would inject a shell
 * command into the rendered cron line via the config path); no control char in any string field.
 * @param {object} inputs
 * @returns {{project:string,owner:string,repo:string,projectRoot:string,stateDir:string,worktreeRoot:string,homeDir:string,harnessAuthorLogin?:string}}
 */
export function validateInstallCoordinates(inputs) {
  const stringFields = [
    "project",
    "owner",
    "repo",
    "projectRoot",
    "stateDir",
    "worktreeRoot",
    "homeDir",
  ];
  for (const field of stringFields) {
    const value = inputs[field];
    if (typeof value !== "string" || value.length === 0 || CONTROL_CHAR.test(value)) {
      throw new Error(`invalid ${field}`);
    }
  }
  const hasAuthor = inputs.harnessAuthorLogin !== undefined && inputs.harnessAuthorLogin !== null;
  if (hasAuthor) {
    if (typeof inputs.harnessAuthorLogin !== "string" || CONTROL_CHAR.test(inputs.harnessAuthorLogin)) {
      throw new Error("invalid harnessAuthorLogin");
    }
  }

  if (!PROJECT_SLUG.test(inputs.project) || inputs.project === RESERVED_PROJECT) {
    throw new Error("invalid project");
  }
  for (const field of ["owner", "repo"]) {
    if (!NAME_TOKEN.test(inputs[field])) throw new Error(`invalid ${field}`);
  }
  if (hasAuthor && !NAME_TOKEN.test(inputs.harnessAuthorLogin)) {
    throw new Error("invalid harnessAuthorLogin");
  }
  for (const field of ["projectRoot", "stateDir", "worktreeRoot", "homeDir"]) {
    if (!isAbsolute(inputs[field]) || !PATH_SAFE.test(inputs[field])) {
      throw new Error(`invalid ${field}`);
    }
  }

  const coords = {
    project: inputs.project,
    owner: inputs.owner,
    repo: inputs.repo,
    projectRoot: inputs.projectRoot,
    stateDir: inputs.stateDir,
    worktreeRoot: inputs.worktreeRoot,
    homeDir: inputs.homeDir,
  };
  if (hasAuthor) coords.harnessAuthorLogin = inputs.harnessAuthorLogin;

  // Optional Telegram notify block — NOT secret (chatId/threadId are group coordinates; the bot
  // token lives ONLY in ~/.claude/.dev.vars, never here). Validated numeric so nothing unsafe
  // reaches the generated config. Absent notify → coords carries none and the config is unchanged.
  // Optional cadence overrides (integers 1..24) — install-time crontab-render knobs, injection-safe
  // by construction. Absent → the block renders with the default 4h/6h cadence.
  for (const field of ["intervalHoursA", "intervalHoursReview"]) {
    if (inputs[field] !== undefined && inputs[field] !== null) {
      const value = inputs[field];
      if (!Number.isInteger(value) || value < 1 || value > 24) {
        throw new Error(`invalid ${field}`);
      }
      coords[field] = value;
    }
  }

  const hasNotify = inputs.notify !== undefined && inputs.notify !== null;
  if (hasNotify) {
    const n = inputs.notify;
    if (typeof n !== "object" || Array.isArray(n)) throw new Error("invalid notify");
    if (!Number.isInteger(n.chatId)) throw new Error("invalid notify.chatId");
    if (n.threadId !== undefined && !Number.isInteger(n.threadId)) throw new Error("invalid notify.threadId");
    if (n.heartbeat !== undefined && typeof n.heartbeat !== "boolean") throw new Error("invalid notify.heartbeat");
    const notify = { chatId: n.chatId };
    if (n.threadId !== undefined) notify.threadId = n.threadId;
    if (n.heartbeat !== undefined) notify.heartbeat = n.heartbeat;
    coords.notify = notify;
  }
  return coords;
}

/**
 * @description Produces the per-project config object with keys in exactly REQUIRED_CONFIG_FIELDS
 * order (+ harnessAuthorLogin last iff present). Never reads any token or secret — derived purely
 * from validated coords.
 * @param {object} coords
 * @returns {object}
 */
export function generateProjectConfig(coords) {
  const config = {};
  for (const field of REQUIRED_CONFIG_FIELDS) {
    config[field] = coords[field];
  }
  if (coords.harnessAuthorLogin !== undefined && coords.harnessAuthorLogin !== null) {
    config.harnessAuthorLogin = coords.harnessAuthorLogin;
  }
  return config;
}

/** @description Default hour interval for Cron A (select/dispatch) and the review phase. */
const DEFAULT_INTERVAL_HOURS_A = 4;
const DEFAULT_INTERVAL_HOURS_REVIEW = 6;
/** @description Default MINUTE interval for the dedicated drain-only cron — the Telegram feed
 * updates this often (drain is lightweight; dispatch/review keep their hourly cadence). */
const DEFAULT_INTERVAL_MINUTES_DRAIN = 3;

/**
 * @description Renders the five-field cron schedule prefix for an every-N-hours cadence
 * (minute 0, hour step N), validating N is an integer in [1,24]. N is injection-safe by
 * construction (an integer), so the rendered schedule never carries anything unsafe into the
 * crontab line. Chaining latency is tuned here: a shorter Cron A / review interval advances a
 * merged roadmap faster.
 * @param {number} hours
 * @param {string} label
 * @returns {string}
 */
function everyNHoursSchedule(hours, label) {
  if (!Number.isInteger(hours) || hours < 1 || hours > 24) {
    throw new Error(`invalid ${label} (must be an integer 1..24)`);
  }
  return `0 */${hours} * * *`;
}

/**
 * @description Renders the five-field cron schedule for an every-N-MINUTES cadence (a step-N minute
 * field), validating N is an integer in [1,59]. Injection-safe by construction (an integer). Used
 * only for the lightweight drain-only cron.
 * @param {number} minutes
 * @param {string} label
 * @returns {string}
 */
function everyNMinutesSchedule(minutes, label) {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 59) {
    throw new Error(`invalid ${label} (must be an integer 1..59)`);
  }
  return `*/${minutes} * * * *`;
}

/**
 * @description Renders the fenced crontab block for a project: Cron A (run-cron-a.mjs) and the
 * review phase (run-cron-review.mjs — REPLACES the old Cron B slot, not a third line) invoking the
 * run-cron scripts with absolute paths, wrapped in literal `# >>> harness:<project> >>>` /
 * `# <<< harness:<project> <<<` fence lines. No trailing newline. Cadence defaults to every 4h
 * (Cron A) / 6h (review); `intervalHoursA` / `intervalHoursReview` (integers 1..24) override it to
 * make a merged roadmap chain faster.
 * @param {{project:string,nodeBin:string,scriptDir:string,configPath:string,intervalHoursA?:number,intervalHoursReview?:number}} args
 * @returns {string}
 */
export function renderProjectBlock({
  project,
  nodeBin,
  scriptDir,
  configPath,
  intervalHoursA = DEFAULT_INTERVAL_HOURS_A,
  intervalHoursReview = DEFAULT_INTERVAL_HOURS_REVIEW,
  intervalMinutesDrain = DEFAULT_INTERVAL_MINUTES_DRAIN,
}) {
  const scriptA = join(scriptDir, "run-cron-a.mjs");
  const scriptReview = join(scriptDir, "run-cron-review.mjs");
  const scriptDrain = join(scriptDir, "run-drain.mjs");
  assertCronSafe(nodeBin, "nodeBin");
  assertCronSafe(scriptA, "script path");
  assertCronSafe(scriptReview, "script path");
  assertCronSafe(scriptDrain, "script path");
  assertCronSafe(configPath, "configPath");
  const scheduleA = everyNHoursSchedule(intervalHoursA, "intervalHoursA");
  const scheduleReview = everyNHoursSchedule(intervalHoursReview, "intervalHoursReview");
  const scheduleDrain = everyNMinutesSchedule(intervalMinutesDrain, "intervalMinutesDrain");
  const cronA = `${scheduleA} ${nodeBin} ${scriptA} --config ${configPath}`;
  const cronReview = `${scheduleReview} ${nodeBin} ${scriptReview} --config ${configPath}`;
  const cronDrain = `${scheduleDrain} ${nodeBin} ${scriptDrain} --config ${configPath}`;
  return [`# >>> harness:${project} >>>`, cronA, cronReview, cronDrain, `# <<< harness:${project} <<<`].join("\n");
}

/**
 * @description Renders the shared reaper's fenced crontab block: a single 0 3 * * * run-reaper line
 * inside the literal harness:reaper fence. No trailing newline.
 * @param {{nodeBin:string,scriptDir:string,reaperConfigPath:string}} args
 * @returns {string}
 */
export function renderReaperBlock({ nodeBin, scriptDir, reaperConfigPath }) {
  const script = join(scriptDir, "run-reaper.mjs");
  assertCronSafe(nodeBin, "nodeBin");
  assertCronSafe(script, "script path");
  assertCronSafe(reaperConfigPath, "configPath");
  const line = `0 3 * * * ${nodeBin} ${script} --config ${reaperConfigPath}`;
  return ["# >>> harness:reaper >>>", line, "# <<< harness:reaper <<<"].join("\n");
}

/**
 * @description Removes any block delimited by the marker's literal fence lines, matched by
 * FULL-LINE equality only (never substring/regex) with a trailing CR tolerated (a CRLF crontab's
 * fence line ends in "\r"). Every NON-fence line is byte-preserved (its own CR intact); the two
 * neighbors of a removed block are joined by exactly one newline (no glue, no accumulating blank).
 * An opener with no matching closer before EOF is corruption — THROWS rather than silently dropping
 * the opener and leaving the block body as orphaned/duplicate cron lines.
 * @param {string} crontabText
 * @param {string} marker - e.g. "harness:demo"
 * @returns {string}
 */
export function removeBlock(crontabText, marker) {
  const opener = `# >>> ${marker} >>>`;
  const closer = `# <<< ${marker} <<<`;
  const isFence = (line, fence) => line.replace(/\r$/, "") === fence;
  const lines = crontabText.split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    if (isFence(lines[i], opener)) {
      let j = i + 1;
      while (j < lines.length && !isFence(lines[j], closer)) j++;
      if (j >= lines.length) {
        throw new Error("corrupt crontab: unterminated harness fence");
      }
      i = j + 1; // skip opener..closer inclusive
      continue;
    }
    out.push(lines[i]);
    i++;
  }
  return out.join("\n");
}

/**
 * @description Idempotently inserts/replaces the marker's block: removes any existing occurrence
 * (literal fence) then appends the fresh block. Output ends in exactly one newline; an inserted
 * block never glues to a preceding line and never leaves a leading blank on an empty crontab.
 * @param {string} crontabText
 * @param {string} marker
 * @param {string} blockText
 * @returns {string}
 */
export function upsertBlock(crontabText, marker, blockText) {
  const block = blockText.replace(/\n+$/, "");
  const base = removeBlock(crontabText, marker).replace(/\n+$/, "");
  if (base === "") return `${block}\n`;
  return `${base}\n${block}\n`;
}

/**
 * @description Lists every registered project name from the crontab's literal opener fence lines,
 * excluding the shared reaper. Full-line match only, with a trailing CR tolerated (CRLF crontab).
 * @param {string} crontabText
 * @returns {string[]}
 */
export function listRegisteredProjects(crontabText) {
  const names = [];
  for (const line of crontabText.split("\n")) {
    const match = /^# >>> harness:(.+) >>>$/.exec(line.replace(/\r$/, ""));
    if (match && match[1] !== RESERVED_PROJECT) names.push(match[1]);
  }
  return names;
}

/**
 * @description Builds the reconciled fleet config for the reaper. A null existing fleet seeds a
 * fresh one from coords. An existing fleet whose top owner/repo differs from coords throws BEFORE
 * any write (single-repo invariant) and never mutates its input. The projects[] array is reconciled
 * to only currently-registered projects plus the one being installed (ghosts whose crontab block is
 * absent are dropped), upserting the current project in place; top owner/repo stay constant.
 * @param {object|null} existingFleet
 * @param {string[]} registeredProjects
 * @param {object} coords
 * @returns {object}
 */
export function reconcileFleet(existingFleet, registeredProjects, coords) {
  const currentEntry = {
    project: coords.project,
    projectRoot: coords.projectRoot,
    stateDir: coords.stateDir,
  };

  if (existingFleet == null) {
    return {
      project: coords.project,
      owner: coords.owner,
      repo: coords.repo,
      projectRoot: coords.projectRoot,
      stateDir: coords.stateDir,
      worktreeRoot: coords.worktreeRoot,
      homeDir: coords.homeDir,
      // Optional notify base so the shared reaper can resolve the destination. Absent → omitted.
      ...(coords.notify ? { notify: coords.notify } : {}),
      projects: [currentEntry],
    };
  }

  if (existingFleet.owner !== coords.owner) throw new Error("owner mismatch with existing fleet");
  if (existingFleet.repo !== coords.repo) throw new Error("repo mismatch with existing fleet");

  const keep = new Set(registeredProjects);
  keep.add(coords.project);
  const existingProjects = Array.isArray(existingFleet.projects) ? existingFleet.projects : [];
  const reconciled = [];
  const emitted = new Set();
  let placedCurrent = false;
  for (const entry of existingProjects) {
    if (!entry || !keep.has(entry.project)) continue; // drop ghost / malformed
    if (emitted.has(entry.project)) continue; // dedup a corrupt fleet's repeated project
    emitted.add(entry.project);
    if (entry.project === coords.project) {
      reconciled.push({ ...currentEntry });
      placedCurrent = true;
    } else {
      reconciled.push({
        project: entry.project,
        projectRoot: entry.projectRoot,
        stateDir: entry.stateDir,
      });
    }
  }
  if (!placedCurrent) reconciled.push({ ...currentEntry });

  // Latest-installer sets/updates the shared notify destination; an install without notify leaves
  // the existing fleet's notify untouched (spread preserves it).
  return { ...existingFleet, ...(coords.notify ? { notify: coords.notify } : {}), projects: reconciled };
}

/**
 * @description Returns a copy of the fleet with the named project's entry removed; base fields and
 * other entries are untouched (never mutates the input).
 * @param {object} fleet
 * @param {string} project
 * @returns {object}
 */
export function removeFromFleetConfig(fleet, project) {
  const projects = Array.isArray(fleet.projects) ? fleet.projects : [];
  return { ...fleet, projects: projects.filter((entry) => entry.project !== project) };
}

// ---------------------------------------------------------------------------------------------
// Real seams (injectable; default real wiring)
// ---------------------------------------------------------------------------------------------

/**
 * @description Reads a JSON config file, returning the parsed object or null when absent (ENOENT).
 * @param {string} filePath
 * @param {object} [deps]
 * @returns {object|null}
 */
export function readConfigFile(filePath, deps = {}) {
  const readFileSyncFn = deps.readFileSync ?? readFileSync;
  let raw;
  try {
    raw = readFileSyncFn(filePath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
  return JSON.parse(raw);
}

/**
 * @description Reads the operator crontab via `crontab -l` under LC_ALL=C. Exit 0 → stdout; a
 * non-zero exit whose stderr matches "no crontab for " (benign empty-crontab signal) → ""; ANY
 * other non-zero → throw (catastrophic guard: a permission error must never look like "empty").
 * @param {object} [deps]
 * @returns {string}
 */
export function readCrontab(deps = {}) {
  const spawnSyncFn = deps.spawnSync ?? spawnSync;
  const res = spawnSyncFn("crontab", ["-l"], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
  });
  if (res.error) throw res.error;
  if (res.status === 0) return res.stdout ?? "";
  const stderr = res.stderr ?? "";
  if (res.status === 1 && /^no crontab for /.test(stderr)) return "";
  throw new Error(`crontab -l failed (status=${res.status})`);
}

/**
 * @description Writes the operator crontab by piping text to `crontab -` under LC_ALL=C. The piped
 * text is coerced to end in exactly one newline. A non-zero exit or spawn error throws.
 * @param {string} text
 * @param {object} [deps]
 * @returns {void}
 */
export function writeCrontab(text, deps = {}) {
  const spawnSyncFn = deps.spawnSync ?? spawnSync;
  const input = `${text.replace(/\n+$/, "")}\n`;
  const res = spawnSyncFn("crontab", ["-"], {
    input,
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
  });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`crontab - failed (status=${res.status})`);
}

/**
 * @description Atomically writes a JSON config: mkdir -p the parent, write to a sibling tmp file in
 * the SAME directory, then rename over the final path. Content is JSON.stringify(obj,null,2) + a
 * trailing newline. A write failure removes the tmp file and rethrows — the final path is never
 * renamed after a failed write, never truncated directly.
 * @param {string} filePath
 * @param {object} obj
 * @param {object} [deps]
 * @returns {void}
 */
export function atomicWriteConfig(filePath, obj, deps = {}) {
  const mkdirSyncFn = deps.mkdirSync ?? mkdirSync;
  const writeFileSyncFn = deps.writeFileSync ?? writeFileSync;
  const renameSyncFn = deps.renameSync ?? renameSync;
  const rmSyncFn = deps.rmSync ?? rmSync;

  const dir = dirname(filePath);
  mkdirSyncFn(dir, { recursive: true });
  const tmpPath = join(dir, `${basename(filePath)}.tmp-${process.pid}-${randomUUID()}`);
  const content = `${JSON.stringify(obj, null, 2)}\n`;
  try {
    writeFileSyncFn(tmpPath, content, "utf8");
  } catch (err) {
    try {
      rmSyncFn(tmpPath, { force: true });
    } catch {
      // best-effort tmp cleanup; never mask the original write failure
    }
    throw err;
  }
  renameSyncFn(tmpPath, filePath);
}

/**
 * @description Runs `fn` while holding the exclusive install lock. mkdir -p the lock's parent BEFORE
 * openSync(lock,"wx") (first-ever install has no dir yet); an EEXIST throws "install already in
 * progress" WITHOUT unlinking (it is another installer's lock). On success or failure the lock this
 * call created is closed and unlinked in a finally — the original error from `fn` is never masked.
 * @param {string} homeDir
 * @param {Function} fn
 * @param {object} [deps]
 * @returns {any}
 */
export function withInstallLock(homeDir, fn, deps = {}) {
  const mkdirSyncFn = deps.mkdirSync ?? mkdirSync;
  const openSyncFn = deps.openSync ?? openSync;
  const closeSyncFn = deps.closeSync ?? closeSync;
  const unlinkSyncFn = deps.unlinkSync ?? unlinkSync;

  const lockPath = installLockPath(homeDir);
  mkdirSyncFn(dirname(lockPath), { recursive: true });

  let fd;
  try {
    fd = openSyncFn(lockPath, "wx");
  } catch (err) {
    if (err && err.code === "EEXIST") {
      throw new Error(
        `install already in progress (lock: ${lockPath}); remove it if no installer is running`
      );
    }
    throw err;
  }

  try {
    return fn();
  } finally {
    try {
      closeSyncFn(fd);
    } catch {
      // best-effort fd close
    }
    try {
      unlinkSyncFn(lockPath);
    } catch {
      // best-effort lock release
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Composition roots (pure wiring)
// ---------------------------------------------------------------------------------------------

/**
 * @description Installs a project's cron jobs and configs. Validates coords, then under the install
 * lock: reads the crontab, reads the existing fleet, reconciles the fleet (throwing on a repo
 * mismatch BEFORE any write), validates both configs and the projects shape, THEN writes in order —
 * per-project config, fleet config, crontab (project block + reaper block). Any validation/mismatch
 * writes nothing. Never reads .dev.vars or any token.
 * @param {object} inputs
 * @param {object} [deps]
 * @returns {{project:string}}
 */
export function installProject(inputs, deps = {}) {
  const readCrontabFn = deps.readCrontab ?? readCrontab;
  const writeCrontabFn = deps.writeCrontab ?? writeCrontab;
  const readConfigFileFn = deps.readConfigFile ?? readConfigFile;
  const writeConfigFn = deps.writeConfig ?? atomicWriteConfig;
  const nodeBin = deps.nodeBin ?? process.execPath;
  const scriptDir = deps.scriptDir ?? DEFAULT_SCRIPT_DIR;
  const log = deps.log ?? console.error;

  const coords = validateInstallCoordinates(inputs);
  const { homeDir, project } = coords;
  const perProjectPath = perProjectConfigPath(homeDir, project);
  const fleetPath = fleetConfigPath(homeDir);

  return withInstallLock(
    homeDir,
    () => {
      const crontabText = readCrontabFn();
      const registered = listRegisteredProjects(crontabText);
      const existingFleet = readConfigFileFn(fleetPath);
      const fleet = reconcileFleet(existingFleet, registered, coords);

      // generateProjectConfig is frozen (exact-key tests); layer the optional notify block here,
      // AFTER the call, so the per-project config the reaper/cron-a/cron-b read gains notify without
      // touching the frozen generator. Absent notify → byte-identical to today.
      const perProjectConfig = generateProjectConfig(coords);
      if (coords.notify) perProjectConfig.notify = coords.notify;
      // Persist the cadence overrides so the installed config records the chosen interval (the crontab
      // line renders from coords below; this keeps the config self-describing for audit/re-install).
      if (coords.intervalHoursA !== undefined) perProjectConfig.intervalHoursA = coords.intervalHoursA;
      if (coords.intervalHoursReview !== undefined) perProjectConfig.intervalHoursReview = coords.intervalHoursReview;
      loadConfig(perProjectConfig);
      loadConfig(fleet);
      for (const entry of fleet.projects) {
        if (!entry || !entry.project || !entry.projectRoot || !entry.stateDir) {
          throw new Error("fleet projects entry missing required fields");
        }
      }

      // Render BEFORE any write so assertCronSafe (an unsafe nodeBin/scriptDir/config path) throws
      // before mutating any config file — validation fully precedes mutation (#ac-5.4).
      const projectBlock = renderProjectBlock({
        project,
        nodeBin,
        scriptDir,
        configPath: perProjectPath,
        intervalHoursA: coords.intervalHoursA,
        intervalHoursReview: coords.intervalHoursReview,
      });
      const reaperBlock = renderReaperBlock({ nodeBin, scriptDir, reaperConfigPath: fleetPath });

      writeConfigFn(perProjectPath, perProjectConfig);
      writeConfigFn(fleetPath, fleet);

      let nextCrontab = upsertBlock(crontabText, `harness:${project}`, projectBlock);
      nextCrontab = upsertBlock(nextCrontab, "harness:reaper", reaperBlock);
      writeCrontabFn(nextCrontab);

      log(`Installed cron jobs for project "${project}" (2 cron lines + shared reaper).`);
      return { project };
    },
    deps
  );
}

/**
 * @description Uninstalls a project's cron jobs and configs. Validates the slug, then under the
 * install lock: reads the crontab and removes the project block. If nothing changed (an
 * unregistered/ghost project) it early-returns with ZERO writes — an orphaned reaper is retained
 * byte-identical. Otherwise, if no projects remain it also removes the reaper block and DELETES the
 * fleet config file (a stale empty fleet with the old owner/repo would block a later unrelated
 * install); if projects remain it updates the fleet in place. Writes in order — crontab, fleet
 * (delete-or-update), per-project config removal (force).
 * @param {string} project
 * @param {object} [deps]
 * @returns {{project:string,removed:boolean}}
 */
export function uninstallProject(project, deps = {}) {
  const readCrontabFn = deps.readCrontab ?? readCrontab;
  const writeCrontabFn = deps.writeCrontab ?? writeCrontab;
  const readConfigFileFn = deps.readConfigFile ?? readConfigFile;
  const writeConfigFn = deps.writeConfig ?? atomicWriteConfig;
  const rmSyncFn = deps.rmSync ?? rmSync;
  const env = deps.env ?? process.env;
  const homeDir = deps.homeDir ?? env.HOME;
  const log = deps.log ?? console.error;

  if (typeof project !== "string" || project.length === 0) {
    throw new Error("invalid project");
  }
  if (!PROJECT_SLUG.test(project) || project === RESERVED_PROJECT) {
    throw new Error("invalid project");
  }
  const perProjectPath = perProjectConfigPath(homeDir, project);
  const fleetPath = fleetConfigPath(homeDir);

  return withInstallLock(
    homeDir,
    () => {
      const crontabText = readCrontabFn();
      let nextCrontab = removeBlock(crontabText, `harness:${project}`);
      if (nextCrontab === crontabText) {
        log(`Project "${project}" was not registered; nothing to uninstall.`);
        return { project, removed: false };
      }
      const noProjectsRemain = listRegisteredProjects(nextCrontab).length === 0;
      if (noProjectsRemain) {
        nextCrontab = removeBlock(nextCrontab, "harness:reaper");
      }
      writeCrontabFn(nextCrontab);

      if (noProjectsRemain) {
        rmSyncFn(fleetPath, { force: true });
      } else {
        const existingFleet = readConfigFileFn(fleetPath);
        if (existingFleet != null) {
          writeConfigFn(fleetPath, removeFromFleetConfig(existingFleet, project));
        }
      }
      rmSyncFn(perProjectPath, { force: true });

      const cleanup = noProjectsRemain
        ? "2 cron lines + shared reaper removed"
        : "2 cron lines removed";
      log(`Uninstalled cron jobs for project "${project}" (${cleanup}).`);
      return { project, removed: true };
    },
    deps
  );
}

// ---------------------------------------------------------------------------------------------
// CLI entry (hand-rolled flag parser; product-language logs only)
// ---------------------------------------------------------------------------------------------

/** @description Parses `--flag value` pairs into a plain object. */
function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      flags[arg.slice(2)] = args[i + 1];
      i++;
    }
  }
  return flags;
}

/** @description Prompts on the TTY for a single line; resolves with the typed answer. */
function askTTY(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => {
    rl.close();
    resolve(answer);
  }));
}

/**
 * @description Decides the heartbeat (idle "nada a fazer" ping) setting. PURE — `ask` is injectable.
 * An explicit `--heartbeat true|false` flag always wins (non-interactive / CI). Otherwise, ONLY on a
 * TTY do we prompt (default YES — heartbeat is ON by default). A non-TTY with no flag defaults ON.
 * @param {{ flag: string|undefined, isTTY: boolean, ask: (q: string) => Promise<string> }} opts
 * @returns {Promise<boolean>}
 */
export async function decideHeartbeat({ flag, isTTY, ask }) {
  if (flag !== undefined) return flag === "true";
  if (!isTTY) return true;
  const answer = await ask(
    "Ativar o heartbeat do Telegram (aviso periódico de \"nada a fazer\" a cada ~4h)? [Y/n] "
  );
  const trimmed = String(answer ?? "").trim();
  return !/^n(o|ão|ao)?$/i.test(trimmed); // default YES: anything but an explicit "n" keeps it ON
}

/**
 * @description Dispatches the CLI subcommands: `install <flags>` and `--uninstall <project>`.
 * `deps` is injectable so tests can observe the parsed inputs without touching real fs/crontab.
 * @param {string[]} argv
 * @param {{ installProject?: Function, uninstallProject?: Function, isTTY?: boolean, askHeartbeat?: Function }} [deps]
 */
export async function runCli(argv, deps = {}) {
  const installProjectFn = deps.installProject ?? installProject;
  const uninstallProjectFn = deps.uninstallProject ?? uninstallProject;
  const isTTY = deps.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const askHeartbeat = deps.askHeartbeat ?? askTTY;
  const uninstallIdx = argv.indexOf("--uninstall");
  if (uninstallIdx !== -1) {
    const target = argv[uninstallIdx + 1];
    if (typeof target !== "string" || target.length === 0 || target.startsWith("--")) {
      console.error("Usage:\n  --uninstall <project> [--home-dir <h>]");
      process.exitCode = 1;
      return;
    }
    // Accept --home-dir for symmetry with install, so uninstall targets the SAME config dir the
    // operator installed into (config removal is homeDir-derived); falls back to $HOME.
    const uflags = parseFlags(argv);
    const opts = uflags["home-dir"] ? { homeDir: uflags["home-dir"] } : {};
    uninstallProjectFn(target, opts);
    return;
  }
  if (argv[0] === "install") {
    const flags = parseFlags(argv.slice(1));
    const inputs = {
      project: flags.project,
      owner: flags.owner,
      repo: flags.repo,
      projectRoot: flags["project-root"],
      stateDir: flags["state-dir"],
      worktreeRoot: flags["worktree-root"],
      homeDir: flags["home-dir"],
    };
    if (flags["harness-author-login"]) inputs.harnessAuthorLogin = flags["harness-author-login"];
    // Optional cadence overrides (every N hours; integers 1..24). Absent → default 4h/6h. Shorter
    // intervals make a merged roadmap chain advance faster. A non-integer fails validation before any write.
    if (flags["interval-hours-a"] !== undefined) inputs.intervalHoursA = Number(flags["interval-hours-a"]);
    if (flags["interval-hours-review"] !== undefined) inputs.intervalHoursReview = Number(flags["interval-hours-review"]);
    // Review-phase kill switch. Defaults OFF (unlike heartbeat, which defaults ON) — an explicit
    // --review-enabled true|false flag always wins; absent, the review phase stays disabled until
    // the operator opts in.
    inputs.reviewEnabled = flags["review-enabled"] === "true";
    // Optional Telegram notify block. chatId/threadId are NON-secret group coordinates; the bot
    // token stays in ~/.claude/.dev.vars. validateInstallCoordinates rejects non-integer chatId/
    // threadId and a non-boolean heartbeat, so a malformed flag fails fast before any write.
    if (flags["chat-id"] !== undefined) {
      inputs.notify = { chatId: Number(flags["chat-id"]) };
      if (flags["thread-id"] !== undefined) inputs.notify.threadId = Number(flags["thread-id"]);
      // Heartbeat defaults ON: an explicit --heartbeat flag wins; otherwise prompt on a TTY (default
      // YES) or default ON non-interactively. The resolved value is written so the config is explicit.
      inputs.notify.heartbeat = await decideHeartbeat({ flag: flags["heartbeat"], isTTY, ask: askHeartbeat });
    }
    installProjectFn(inputs);
    return;
  }
  console.error(
    "Usage:\n" +
      "  install --project <slug> --owner <o> --repo <r> --project-root <p> --state-dir <s> --worktree-root <w> --home-dir <h> [--harness-author-login <l>] [--interval-hours-a <1..24>] [--interval-hours-review <1..24>] [--chat-id <n> [--thread-id <n>] [--heartbeat true|false]]\n" +
      "  --uninstall <project>"
  );
  process.exitCode = 1;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  runCli(process.argv.slice(2)).catch((err) => {
    console.error(`install-crons: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
