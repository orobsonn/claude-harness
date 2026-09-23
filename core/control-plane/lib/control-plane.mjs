import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { parseDependsOn } from "../../shared/lib/harness-deps.mjs";
import { readTaskProcess } from "../../pi/lib/task-process.mjs";
import { createExternalRunner, terminalCommand } from "./external.mjs";
import {
  BRIDGE_SCHEMA,
  CONTROL_PROTOCOL,
  enqueueInboxMessage,
  inboxMessages,
  listBridgeEvents,
  markInboxSent,
  prepareBridgeResume,
  readBridge,
} from "./protocol.mjs";
import {
  assertPlainObject,
  assertSafeId,
  atomicWriteJson,
  controlHome,
  ensureControlHome,
  ensurePrivateDirectory,
  readPrivateJson,
  rejectSensitiveFields,
  withLock,
} from "./storage.mjs";

const PROJECT_SCHEMA = "harness.control.project.v1";
const RECOMMENDATION_SCHEMA = "harness.control.recommendation.v1";
const DELIVERY_SCHEMA = "harness.control.delivery.v1";
const SETTINGS_SCHEMA = "harness.control.settings.v1";
const CAPABILITIES_SCHEMA = "harness.control.consumer-capabilities.v1";
const REQUIRED_CAPABILITIES = [
  "vendored-launcher",
  "parent-session-identity",
  "sequenced-events",
  "durable-inbox",
  "versioned-decisions",
  "exact-resume",
];
const BLOCKED_LABELS = new Set(["blocked", "harness:blocked", "harness:in-progress", "wontfix"]);
const NOTIFIABLE_EVENTS = new Set([
  "session.stopped",
  "decision.opened",
  "decision.applied",
  "delivery.blocked",
  "delivery.failed",
  "delivery.milestone",
  "result.pr-available",
  "result.completed",
]);

function now() { return new Date().toISOString(); }
function token(bytes = 12) { return randomBytes(bytes).toString("hex"); }
function digest(text) { return createHash("sha256").update(text).digest("hex"); }
function requireExplicitAuthorization(value, action) {
  if (value !== "explicit-current-turn") throw new Error(`${action} requires explicit current-turn operator authorization`);
}
function safeDiagnostic(error) {
  const text = String(error instanceof Error ? error.message : error).slice(0, 1024);
  try { rejectSensitiveFields({ detail: text }); return text; }
  catch { return "external diagnostic contained credential-like text and was redacted"; }
}
function slug(value) {
  const result = String(value).normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
  if (!result) throw new Error("project name does not produce a safe id");
  return result;
}

function normalizeBaseBranch(value) {
  const branch = String(value || "main");
  // This value is later passed to both `git fetch` and `git rev-parse`.
  // Keep it to an intentionally smaller language than every ref Git accepts:
  // no option-looking value, reflog expression, traversal or ref metacharacter.
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/.test(branch) ||
      branch.includes("..") || branch.includes("//") || branch.includes("@{") ||
      branch.endsWith("/") || branch.endsWith(".") || branch.endsWith(".lock")) {
    throw new Error("project base_branch is not a safe branch name");
  }
  return branch;
}

function pathContains(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function listPrivateRecords(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => readPrivateJson(path.join(dir, entry.name)));
}

function exactKeys(value, allowed, label) {
  assertPlainObject(value, label);
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`${label} has unknown fields: ${unknown.join(", ")}`);
}

function labelNames(issue) {
  return (Array.isArray(issue?.labels) ? issue.labels : []).map((label) => String(label?.name ?? label).toLowerCase());
}

function issuePriority(issue) {
  const labels = labelNames(issue);
  if (labels.includes("priority:critical") || labels.includes("p0")) return 0;
  if (labels.includes("priority:high") || labels.includes("p1")) return 1;
  if (labels.includes("priority:medium") || labels.includes("p2")) return 2;
  return 3;
}

function worktreeIssueNumber(worktree) {
  const candidates = [
    worktree?.issueNumber,
    worktree?.issue_number,
    worktree?.issue?.number,
    worktree?.linkedIssue,
    worktree?.linkedIssue?.number,
  ];
  for (const value of candidates) {
    const number = Number(value);
    if (Number.isInteger(number) && number > 0) return number;
  }
  const text = typeof worktree?.linkedIssue === "string" ? worktree.linkedIssue : worktree?.linkedIssue?.url;
  const match = String(text ?? "").match(/\/issues\/(\d+)(?:\b|\/|$)/);
  return match ? Number(match[1]) : null;
}

function processStartToken(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    return stat.slice(close + 2).split(" ")[19] || null;
  } catch {
    return null;
  }
}

function firstJsonLine(file, root) {
  const safe = path.resolve(file);
  const relative = path.relative(root, safe);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error("session file escapes worktree");
  }
  let cursor = root;
  for (const part of relative.split(path.sep)) {
    cursor = path.join(cursor, part);
    if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error("session symlink rejected");
  }
  if (!fs.statSync(safe).isFile() || fs.realpathSync(safe) !== safe) throw new Error("session file invalid");
  const fd = fs.openSync(safe, "r");
  try {
    const buffer = Buffer.alloc(16 * 1024);
    const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const line = buffer.subarray(0, length).toString("utf8").split("\n", 1)[0];
    if (!line || !line.endsWith("}")) throw new Error("session header is unavailable or too large");
    return JSON.parse(line);
  } finally {
    fs.closeSync(fd);
  }
}

function externalParentIdentity(worktreePath) {
  try {
    const root = fs.realpathSync(worktreePath);
    const lockFile = assertRegularFile(path.join(root, ".pi", "harness", "state", "parent-orchestrator.lock"), root);
    const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    const sessionId = assertSafeId(String(lock?.session_id ?? ""), "external session id");
    const pid = Number(lock?.pid);
    if (!Number.isInteger(pid) || pid < 1 || !/^\d+$/.test(String(lock?.process_start_ticks ?? "")) ||
        processStartToken(pid) !== String(lock.process_start_ticks)) return null;
    const sessionsDir = path.join(root, ".pi", "harness", "sessions");
    const files = fs.readdirSync(sessionsDir).filter((name) => name.endsWith(`_${sessionId}.jsonl`));
    if (files.length !== 1) return null;
    const header = firstJsonLine(path.join(sessionsDir, files[0]), root);
    if (header?.type !== "session" || header.id !== sessionId || fs.realpathSync(header.cwd) !== root) return null;
    const gateFile = assertRegularFile(path.join(root, ".pi", "harness", "state", sessionId, "gate-state.json"), root);
    const gate = JSON.parse(fs.readFileSync(gateFile, "utf8"));
    if (gate?.session_id !== sessionId) return null;
    return {
      session_id: sessionId,
      pid,
      process_start_ticks: String(lock.process_start_ticks),
      feature_id: typeof gate.feature_id === "string" ? gate.feature_id.slice(0, 160) : null,
      mode: typeof gate.mode === "string" ? gate.mode.slice(0, 40) : null,
      spec_status: typeof gate.spec_status === "string" ? gate.spec_status.slice(0, 80) : null,
      final_review_done: gate.final_review_done === true,
    };
  } catch {
    return null;
  }
}

function externalActiveChildren(worktreePath, sessionId) {
  try {
    const root = fs.realpathSync(worktreePath);
    const safeSessionId = assertSafeId(String(sessionId ?? ""), "external session id");
    const directory = path.join(root, ".pi", "harness", "state", safeSessionId, "child-identity");
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
    catch (error) {
      if (error?.code === "ENOENT") return { ok: true, children: [] };
      throw error;
    }
    const children = [];
    for (const entry of entries) {
      if (!entry.name.endsWith(".json")) continue;
      if (!entry.isFile() || entry.isSymbolicLink() || !/^[0-9a-f]{64}\.json$/.test(entry.name)) {
        throw new Error("external child identity inventory conflict");
      }
      const file = assertRegularFile(path.join(directory, entry.name), root);
      const stat = fs.statSync(file);
      if (stat.size < 2 || stat.size > 64 * 1024) throw new Error("external child identity is unbounded");
      const record = JSON.parse(fs.readFileSync(file, "utf8"));
      const childSessionId = assertSafeId(String(record?.child_session_id ?? ""), "external child session id");
      const callId = assertSafeId(String(record?.dispatch_call_id ?? ""), "external child call id");
      const role = String(record?.role ?? "");
      const createdAt = String(record?.created_at ?? "");
      if (record?.parent_session_id !== safeSessionId || !/^harness-[a-z0-9-]{1,80}$/.test(role) ||
          !Number.isFinite(Date.parse(createdAt)) || new Date(Date.parse(createdAt)).toISOString() !== createdAt ||
          entry.name !== `${digest(childSessionId)}.json`) {
        throw new Error("external child identity schema conflict");
      }
      children.push({
        child_session_id: childSessionId,
        dispatch_call_id: callId,
        role,
        created_at: createdAt,
      });
    }
    children.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.child_session_id.localeCompare(b.child_session_id));
    return { ok: true, children };
  } catch {
    return { ok: false, reason: "external-child-activity-unknown", children: [] };
  }
}

function containedConsumerPath(root, file, label) {
  if (typeof file !== "string" || !path.isAbsolute(file)) throw new Error(`${label} is not absolute`);
  const resolved = path.resolve(file);
  if (!pathContains(root, resolved)) throw new Error(`${label} escapes worktree`);
  let cursor = root;
  for (const part of path.relative(root, resolved).split(path.sep)) {
    if (!part) continue;
    cursor = path.join(cursor, part);
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error(`${label} contains a symlink`);
    } catch (error) {
      if (error?.code === "ENOENT") break;
      throw error;
    }
  }
  return resolved;
}

function externalActiveTaskRuns(worktreePath, sessionId) {
  try {
    const root = fs.realpathSync(worktreePath);
    const safeSessionId = assertSafeId(String(sessionId ?? ""), "external session id");
    const candidate = path.join(root, ".pi", "harness", "state", safeSessionId, "task-runs", "index.json");
    let registryFile;
    try { registryFile = assertRegularFile(candidate, root); }
    catch (error) {
      if (error?.code === "ENOENT") return { ok: true, children: [] };
      throw error;
    }
    const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
    assertPlainObject(registry, "external task registry");
    assertPlainObject(registry.tasks, "external task registry tasks");
    const tasks = Object.entries(registry.tasks);
    if (registry.version !== 1 || registry.parent_session_id !== safeSessionId || tasks.length > 128) {
      throw new Error("external task registry identity conflict");
    }
    const children = [];
    let uncertain = false;
    for (const [taskId, task] of tasks) {
      assertSafeId(taskId, "external task id");
      assertPlainObject(task, "external task");
      if (task.task_id !== taskId || task.parent_session_id !== safeSessionId) {
        throw new Error("external task identity conflict");
      }
      if (task.status !== "running") continue;
      if (!Array.isArray(task.launches) || task.launches.length < 1 || task.launches.length > 128) {
        throw new Error("external task launch inventory conflict");
      }
      const launch = task.launches.at(-1);
      assertPlainObject(launch, "external task launch");
      const runId = assertSafeId(String(launch.run_id ?? ""), "external task run id");
      for (const key of ["process_path", "result_path", "descriptor_path", "worker_path"]) {
        containedConsumerPath(root, launch[key], `external task ${key}`);
      }
      const observed = readTaskProcess(launch);
      if (observed.ok && observed.running) {
        const createdAt = String(observed.record?.started_at ?? "");
        if (!Number.isFinite(Date.parse(createdAt)) || new Date(Date.parse(createdAt)).toISOString() !== createdAt) {
          throw new Error("external task start time conflict");
        }
        const terminalHandle = launch.orca?.terminal_handle;
        if (terminalHandle != null) assertSafeId(String(terminalHandle), "external task terminal handle");
        children.push({
          activity_id: `task:${taskId}:${runId}`,
          role: "harness-task-worker",
          task_id: taskId,
          run_id: runId,
          ...(terminalHandle ? { terminal_handle: terminalHandle } : {}),
          created_at: createdAt,
        });
      } else if (!(observed.ok && observed.terminal) && !observed.terminal) {
        uncertain = true;
      }
    }
    if (!children.length && uncertain) {
      return { ok: false, reason: "external-task-activity-unknown", children: [] };
    }
    children.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.activity_id.localeCompare(b.activity_id));
    return { ok: true, children };
  } catch {
    return { ok: false, reason: "external-task-activity-unknown", children: [] };
  }
}

function externalActiveActivity(worktreePath, sessionId) {
  const subagents = externalActiveChildren(worktreePath, sessionId);
  const taskRuns = externalActiveTaskRuns(worktreePath, sessionId);
  if (!subagents.ok || !taskRuns.ok) {
    return { ok: false, reason: subagents.reason ?? taskRuns.reason, children: [] };
  }
  const children = [...subagents.children, ...taskRuns.children]
    .sort((a, b) => a.created_at.localeCompare(b.created_at) ||
      String(a.child_session_id ?? a.activity_id).localeCompare(String(b.child_session_id ?? b.activity_id)));
  return { ok: true, children };
}

function terminalAttentionFingerprint(preview) {
  const normalized = String(preview ?? "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^Thinking\.\.\.$/i.test(line))
    .filter((line) => !/[─━].*\b(?:Working|Thinking)\b/i.test(line))
    .filter((line) => !/^[─━⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏\s]+$/.test(line))
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
  return normalized ? digest(normalized) : null;
}

function selectorConfigPath(line) {
  const match = String(line).match(/--config(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s>]+))/);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function canonicalSelectorCronBody(line) {
  const raw = String(line);
  const commented = /^\s*#/.test(raw);
  let body = commented ? raw.replace(/^\s*#\s?/, "").trim() : raw.trim();
  // Operators historically annotate disabled rows as
  // `# [ativo Project 2026-01-01] <cron expression> ...`. The annotation is
  // human prose inside a comment, not part of the schedule. Recognize exactly
  // one bounded bracket prefix, then validate the remaining command normally.
  if (commented) body = body.replace(/^\[[^\]\r\n]{1,160}\]\s+/, "");
  const tokens = body.split(/\s+/);
  if (tokens.length < 9 || !/^\*\/(?:[1-9]|[1-5][0-9])$/.test(tokens[0]) ||
      tokens.slice(1, 5).some((token) => token !== "*")) return null;
  let cursor = 5;
  if (path.basename(tokens[cursor] ?? "") === "flock") {
    if (tokens[cursor + 1] !== "-n" || !path.isAbsolute(tokens[cursor + 2] ?? "")) return null;
    cursor += 3;
  }
  if (path.basename(tokens[cursor] ?? "") === "env") cursor += 1;
  while (/^[A-Za-z_][A-Za-z0-9_]*=\S+$/.test(tokens[cursor] ?? "")) cursor += 1;
  if (path.basename(tokens[cursor] ?? "") !== "node") return null;
  if (!/^(?:[A-Za-z0-9._-]+-)?select-and-dispatch\.mjs$/.test(path.basename(tokens[cursor + 1] ?? ""))) return null;
  const validConfig = tokens[cursor + 2] === "--config"
    ? Boolean(tokens[cursor + 3] && !tokens[cursor + 3].startsWith("-"))
    : /^--config=\S+$/.test(tokens[cursor + 2] ?? "");
  return validConfig ? body : null;
}

function isCanonicalSelectorCronLine(line) {
  return canonicalSelectorCronBody(line) != null;
}

function configBelongsToProject(configPath, project) {
  try {
    const info = fs.statSync(configPath);
    if (!info.isFile() || info.size > 1024 * 1024) return null;
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const clonePath = fs.realpathSync(String(config?.clonePath ?? ""));
    return config?.ghRepo === project.gh_repo &&
      config?.orcaRepoId === project.orca_repo_id &&
      clonePath === project.repo_path &&
      String(config?.baseBranch || "main") === project.base_branch;
  } catch {
    return null;
  }
}

function automationRepoId(automation) {
  // Current Orca uses runContext.repoId; projectId is the documented legacy
  // field. The final fallbacks keep compatibility with earlier CLI payloads.
  return automation?.runContext?.repoId ?? automation?.projectId ??
    automation?.repoId ?? automation?.repo?.id ?? null;
}

function prUrlMatchesProject(rawUrl, ghRepo) {
  try {
    const url = new URL(rawUrl);
    const [owner, repo] = ghRepo.split("/");
    const segments = url.pathname.split("/").filter(Boolean);
    return url.protocol === "https:" && url.hostname.toLowerCase() === "github.com" &&
      !url.username && !url.password && segments.length === 4 &&
      segments[0].toLowerCase() === owner.toLowerCase() &&
      segments[1].toLowerCase() === repo.toLowerCase() &&
      segments[2] === "pull" && /^[1-9][0-9]*$/.test(segments[3]);
  } catch {
    return false;
  }
}

function githubRepoFromRemote(rawRemote) {
  const remote = String(rawRemote ?? "").trim();
  let pathname;
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(remote)) {
      const url = new URL(remote);
      if (url.hostname.toLowerCase() !== "github.com") return null;
      pathname = url.pathname;
    } else {
      const scp = remote.match(/^(?:[^@\s]+@)?github\.com:([^\s]+)$/i);
      if (!scp) return null;
      pathname = scp[1];
    }
  } catch {
    return null;
  }
  const parts = String(pathname).replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "").split("/");
  if (parts.length !== 2 || parts.some((part) => !part || /\s/.test(part))) return null;
  return `${parts[0]}/${parts[1]}`;
}

function githubRepoFromOrca(repo) {
  const canonical = String(repo?.gitRemoteIdentity?.canonicalKey ?? "").trim();
  const match = canonical.match(/^github\.com\/([^/\s]+)\/([^/\s]+)$/i);
  if (match) return `${match[1]}/${match[2].replace(/\.git$/i, "")}`;
  return githubRepoFromRemote(repo?.gitRemoteIdentity?.remoteUrl);
}

function publicProducer(producer) {
  if (!producer) return producer;
  return producer.kind === "orca"
    ? { kind: "orca", id: producer.id, active: producer.active }
    : { kind: "crontab-selector", config_path: producer.config_path, active: producer.active };
}

function publicAutomationResult(result) {
  if (!result || typeof result !== "object") return result;
  const output = { ...result };
  if (output.producer) output.producer = publicProducer(output.producer);
  if (Array.isArray(output.concurrent)) output.concurrent = output.concurrent.map(publicProducer);
  if (Array.isArray(output.producers)) output.producers = output.producers.map(publicProducer);
  if (Array.isArray(output.unresolved)) output.unresolved = output.unresolved.map(publicProducer);
  delete output.cronRows;
  delete output.orcaRows;
  return output;
}

function assertRegularFile(file, root) {
  const resolved = path.resolve(file);
  const rel = path.relative(root, resolved);
  if (rel.startsWith(`..${path.sep}`) || rel === ".." || path.isAbsolute(rel)) throw new Error("consumer file escapes project");
  let cursor = root;
  for (const part of rel.split(path.sep)) {
    cursor = path.join(cursor, part);
    const info = fs.lstatSync(cursor);
    if (info.isSymbolicLink()) throw new Error(`consumer symlink rejected: ${cursor}`);
  }
  const info = fs.statSync(resolved);
  if (!info.isFile() || info.size > 1024 * 1024) throw new Error(`consumer file invalid: ${resolved}`);
  return resolved;
}

function normalizeProject(input) {
  exactKeys(input, ["id", "name", "aliases", "repo_path", "gh_repo", "orca_repo_id", "base_branch", "setup", "automation"], "project");
  const name = String(input.name ?? "").trim();
  if (!name) throw new Error("project name required");
  const id = assertSafeId(input.id || slug(name), "project id");
  const repoPath = fs.realpathSync(String(input.repo_path ?? ""));
  if (!path.isAbsolute(repoPath)) throw new Error("project repo_path must be absolute");
  if (!/^[^/\s]+\/[^/\s]+$/.test(String(input.gh_repo ?? ""))) throw new Error("project gh_repo must be owner/repo");
  assertSafeId(String(input.orca_repo_id ?? ""), "Orca repo id");
  const aliases = [...new Set([name, id, ...(Array.isArray(input.aliases) ? input.aliases : [])].map((entry) => String(entry).trim()).filter(Boolean))];
  if (aliases.some((entry) => entry.length > 128)) throw new Error("project alias too long");
  const setup = input.setup ?? "inherit";
  if (!["run", "skip", "inherit"].includes(setup)) throw new Error("project setup invalid");
  let automation = null;
  if (input.automation != null) {
    assertPlainObject(input.automation, "project automation");
    if (input.automation.kind === "crontab-selector") {
      exactKeys(input.automation, ["kind", "config_path"], "project automation");
      if (!path.isAbsolute(input.automation.config_path)) throw new Error("automation config_path must be absolute");
      automation = { kind: "crontab-selector", config_path: path.resolve(input.automation.config_path) };
    } else if (input.automation.kind === "orca") {
      exactKeys(input.automation, ["kind", "id"], "project automation");
      automation = { kind: "orca", id: assertSafeId(input.automation.id, "automation id") };
    } else throw new Error("automation kind must be crontab-selector or orca");
  }
  const project = {
    schema: PROJECT_SCHEMA, id, name, aliases, repo_path: repoPath,
    gh_repo: input.gh_repo, orca_repo_id: input.orca_repo_id,
    base_branch: normalizeBaseBranch(input.base_branch), setup, automation,
    updated_at: now(),
  };
  rejectSensitiveFields(project);
  return project;
}

export class ControlPlane {
  constructor(options = {}) {
    this.home = ensureControlHome(options.home ?? controlHome(options.env));
    this.external = options.external ?? createExternalRunner(options.externalOptions);
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.startWaitMs = options.startWaitMs ?? 30_000;
    this.attentionConfirmMs = options.attentionConfirmMs ?? 15_000;
  }

  settings() {
    return readPrivateJson(path.join(this.home, "settings.json"), { optional: true }) ?? { schema: SETTINGS_SCHEMA, enabled: true };
  }

  async setEnabled(enabled) {
    if (typeof enabled !== "boolean") throw new Error("enabled must be boolean");
    return withLock(this.home, "settings", async () => {
      const record = { schema: SETTINGS_SCHEMA, enabled, updated_at: now() };
      atomicWriteJson(path.join(this.home, "settings.json"), record);
      return record;
    });
  }

  projects() { return listPrivateRecords(path.join(this.home, "projects")); }

  async materializeProjectInput(input) {
    exactKeys(input, ["id", "name", "aliases", "repo_path", "gh_repo", "orca_repo_id", "base_branch", "setup", "automation"], "project");
    const repoPath = fs.realpathSync(String(input.repo_path ?? ""));
    let ghRepo = input.gh_repo;
    if (!ghRepo) {
      let remote;
      try { remote = await this.external.git(["-C", repoPath, "remote", "get-url", "origin"]); }
      catch (error) { throw new Error(`cannot discover GitHub project identity: ${safeDiagnostic(error)}`); }
      ghRepo = githubRepoFromRemote(remote);
      if (!ghRepo) throw new Error("cannot discover GitHub owner/repo from origin");
    }
    let orcaRepoId = input.orca_repo_id;
    if (!orcaRepoId) {
      let observed;
      try {
        observed = await this.external.orca(["repo", "show", "--repo", `path:${repoPath}`], { cwd: repoPath });
      } catch (error) {
        throw new Error(`cannot discover Orca project identity: ${safeDiagnostic(error)}`);
      }
      const observedPath = typeof observed?.repo?.path === "string"
        ? fs.realpathSync(observed.repo.path)
        : null;
      if (!observed?.repo?.id || observedPath !== repoPath) {
        throw new Error("cannot discover an exact Orca repository for project path");
      }
      orcaRepoId = observed.repo.id;
    }
    return { ...input, repo_path: repoPath, gh_repo: ghRepo, orca_repo_id: orcaRepoId };
  }

  resolveProject(query) {
    if (typeof query !== "string" || !query.trim()) throw new Error("project query required");
    const needle = query.trim().toLowerCase();
    const matches = this.projects().filter((project) => project.id.toLowerCase() === needle ||
      project.name.toLowerCase() === needle || project.aliases.some((alias) => alias.toLowerCase() === needle));
    if (matches.length !== 1) {
      const reason = matches.length ? "ambiguous" : "not-found";
      return { ok: false, reason, choices: matches.map(({ id, name }) => ({ id, name })) };
    }
    return { ok: true, project: matches[0] };
  }

  async discoverProjects(query = "") {
    const needle = String(query ?? "").trim().toLowerCase();
    if (needle.length > 128) throw new Error("project discovery query too long");
    let observed;
    try { observed = await this.external.orca(["repo", "list"]); }
    catch (error) {
      return { ok: false, reason: "orca-project-inventory-unavailable", diagnostic: safeDiagnostic(error) };
    }
    const registered = this.projects();
    const candidates = [];
    const seen = new Set();
    for (const repo of Array.isArray(observed?.repos) ? observed.repos : []) {
      if (repo?.kind !== "git" || typeof repo.id !== "string" || typeof repo.path !== "string") continue;
      let repoPath;
      try { repoPath = fs.realpathSync(repo.path); }
      catch { continue; }
      if (!path.isAbsolute(repoPath) || seen.has(`${repo.id}\0${repoPath}`)) continue;
      seen.add(`${repo.id}\0${repoPath}`);
      const name = String(repo.displayName || path.basename(repoPath)).trim().slice(0, 128);
      if (!name) continue;
      const ghRepo = githubRepoFromOrca(repo);
      const current = registered.find((project) => project.repo_path === repoPath || project.orca_repo_id === repo.id);
      candidates.push({
        name,
        repo_path: repoPath,
        orca_repo_id: repo.id,
        ...(ghRepo ? { gh_repo: ghRepo } : {}),
        registered: Boolean(current),
        ...(current ? { project_id: current.id } : {}),
      });
    }
    const exact = needle
      ? candidates.filter((candidate) => [candidate.name, path.basename(candidate.repo_path), candidate.gh_repo, candidate.project_id]
        .filter(Boolean).some((value) => String(value).toLowerCase() === needle))
      : [];
    const matches = exact.length ? exact : needle
      ? candidates.filter((candidate) => [candidate.name, path.basename(candidate.repo_path), candidate.gh_repo, candidate.project_id]
        .filter(Boolean).some((value) => String(value).toLowerCase().includes(needle)))
      : candidates;
    const limit = 20;
    return {
      ok: true,
      query: needle,
      match: exact.length === 1 ? "exact" : matches.length === 1 ? "unique" : matches.length ? "multiple" : "none",
      candidates: matches.slice(0, limit),
      truncated: matches.length > limit,
    };
  }

  async registerProject(input) {
    if (this.settings().enabled !== true) return { ok: false, reason: "control-plane-disabled" };
    const project = normalizeProject(await this.materializeProjectInput(input));
    if (pathContains(project.repo_path, this.home) || pathContains(this.home, project.repo_path)) {
      throw new Error("control home and consumer repository must not overlap");
    }
    return withLock(this.home, "projects", async () => {
      const others = this.projects().filter((other) => other.id !== project.id);
      const aliasConflicts = others.filter((other) =>
        other.aliases.some((alias) => project.aliases.some((candidate) => candidate.toLowerCase() === alias.toLowerCase())));
      if (aliasConflicts.length) throw new Error(`project alias conflicts with ${aliasConflicts.map((entry) => entry.id).join(", ")}`);
      const identityConflicts = others.filter((other) =>
        other.repo_path === project.repo_path ||
        other.gh_repo.toLowerCase() === project.gh_repo.toLowerCase() ||
        other.orca_repo_id === project.orca_repo_id);
      if (identityConflicts.length) {
        throw new Error(`consumer identity is already registered by ${identityConflicts.map((entry) => entry.id).join(", ")}`);
      }
      const file = path.join(this.home, "projects", `${project.id}.json`);
      const current = readPrivateJson(file, { optional: true });
      const identityPinned = this.deliveries().some((delivery) => delivery.project_id === project.id) ||
        this.recommendations().some((recommendation) =>
          recommendation.project_id === project.id && recommendation.state === "recommended");
      if (current && identityPinned) {
        const immutable = ["repo_path", "gh_repo", "orca_repo_id", "base_branch"];
        const changed = immutable.filter((field) => current[field] !== project[field]);
        if (changed.length) throw new Error(`project identity is pinned by existing deliveries: ${changed.join(", ")}`);
      }
      const identity = await this.verifyProjectIdentity(project);
      if (!identity.ok) throw new Error(`project identity mismatch: ${identity.reason}`);
      atomicWriteJson(file, { ...project, created_at: current?.created_at ?? now() });
      return { ok: true, project: readPrivateJson(file) };
    });
  }

  async verifyProjectIdentity(project) {
    let remote;
    let orca;
    try {
      [remote, orca] = await Promise.all([
        this.external.git(["-C", project.repo_path, "remote", "get-url", "origin"]),
        this.external.orca(["repo", "show", "--repo", `id:${project.orca_repo_id}`], { cwd: project.repo_path }),
      ]);
    } catch (error) {
      return { ok: false, reason: "project-identity-unavailable", diagnostic: safeDiagnostic(error) };
    }
    const remoteRepo = githubRepoFromRemote(remote);
    if (remoteRepo?.toLowerCase() !== project.gh_repo.toLowerCase()) {
      return { ok: false, reason: "github-remote-mismatch" };
    }
    const repo = orca?.repo;
    if (repo?.id !== project.orca_repo_id || typeof repo.path !== "string") {
      return { ok: false, reason: "orca-repo-identity-mismatch" };
    }
    let orcaPath;
    try { orcaPath = fs.realpathSync(repo.path); }
    catch { return { ok: false, reason: "orca-repo-path-unavailable" }; }
    if (orcaPath !== project.repo_path) return { ok: false, reason: "orca-repo-path-mismatch" };
    return { ok: true };
  }

  async consumerCapabilities(projectOrPath) {
    const root = fs.realpathSync(typeof projectOrPath === "string" ? projectOrPath : projectOrPath.repo_path);
    const capabilitiesPath = assertRegularFile(path.join(root, ".pi", "harness", "control-capabilities.json"), root);
    const capabilities = JSON.parse(fs.readFileSync(capabilitiesPath, "utf8"));
    if (capabilities?.schema !== CAPABILITIES_SCHEMA || capabilities.protocol !== CONTROL_PROTOCOL || !Array.isArray(capabilities.capabilities)) {
      return { ok: false, reason: "consumer capability document incompatible" };
    }
    const missing = REQUIRED_CAPABILITIES.filter((item) => !capabilities.capabilities.includes(item));
    if (missing.length) return { ok: false, reason: `consumer capabilities missing: ${missing.join(", ")}` };
    const launcher = assertRegularFile(path.join(root, ".pi", "harness", "pi-harness.mjs"), root);
    const stampPath = assertRegularFile(path.join(root, ".pi", ".harness-version"), root);
    const version = fs.readFileSync(stampPath, "utf8").split("\n", 1)[0].trim();
    let verify;
    try {
      verify = JSON.parse(await this.external.text(process.execPath, [launcher, "--verify"], { cwd: root }));
    } catch (error) {
      return { ok: false, reason: `consumer verify failed: ${safeDiagnostic(error)}` };
    }
    if (verify?.ok !== true) return { ok: false, reason: `consumer preflight failed: ${verify?.reason ?? "unknown"}`, verify };
    return { ok: true, root, version, launcher, capabilities, verify };
  }

  deliveries() {
    return fs.readdirSync(path.join(this.home, "deliveries"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => readPrivateJson(path.join(this.home, "deliveries", entry.name, "record.json"), { optional: true }))
      .filter(Boolean);
  }

  async discoverRuns(projectQuery) {
    const resolved = this.resolveProject(projectQuery);
    if (!resolved.ok) return resolved;
    const project = resolved.project;
    const identity = await this.verifyProjectIdentity(project);
    if (!identity.ok) return { ...identity, project: project.id };
    let listed;
    try {
      listed = await this.external.orca([
        "worktree", "list", "--repo", `id:${project.orca_repo_id}`, "--limit", "200",
      ], { cwd: project.repo_path });
    } catch (error) {
      return { ok: false, reason: "execution-inventory-unavailable", diagnostic: safeDiagnostic(error), project: project.id };
    }
    if (!Array.isArray(listed.worktrees) || listed.truncated === true) {
      return { ok: false, reason: "execution-inventory-incomplete", project: project.id };
    }
    const candidates = [];
    for (const worktree of listed.worktrees) {
      const issueNumber = worktreeIssueNumber(worktree);
      if (worktree?.repoId !== project.orca_repo_id || worktree?.isMainWorktree === true ||
          worktree?.parentWorktreeId || !Number.isInteger(issueNumber) || !path.isAbsolute(worktree?.path ?? "")) continue;
      let worktreePath;
      try { worktreePath = fs.realpathSync(worktree.path); } catch { continue; }
      const parent = externalParentIdentity(worktreePath);
      if (!parent) continue;
      let terminals;
      try {
        const inventory = await this.external.orca([
          "terminal", "list", "--worktree", `id:${worktree.id}`, "--limit", "100",
        ], { cwd: worktreePath });
        if (!Array.isArray(inventory.terminals) || inventory.truncated === true) continue;
        terminals = inventory.terminals.filter((terminal) => terminal?.worktreeId === worktree.id &&
          terminal?.worktreePath === worktreePath && terminal?.connected === true && terminal?.orphaned !== true &&
          typeof terminal?.handle === "string");
      } catch {
        continue;
      }
      for (const terminal of terminals) {
        const candidateId = `run-${digest(`${project.id}\0${worktree.id}\0${terminal.handle}\0${parent.session_id}`).slice(0, 24)}`;
        const linked = worktree.linkedWorkItem;
        candidates.push({
          candidate_id: candidateId,
          project_id: project.id,
          issue: {
            number: issueNumber,
            title: typeof linked?.title === "string" ? linked.title : String(worktree.displayName ?? `Issue #${issueNumber}`),
            ...(typeof linked?.url === "string" ? { url: linked.url } : {}),
          },
          session_id: parent.session_id,
          feature_id: parent.feature_id,
          phase: { mode: parent.mode, spec_status: parent.spec_status, final_review_done: parent.final_review_done },
          worktree: { id: worktree.id, instance_id: worktree.instanceId ?? null, path: worktreePath, branch: worktree.branch ?? null },
          terminal: {
            handle: terminal.handle, title: terminal.title ?? "", worktree_id: terminal.worktreeId,
            surface: terminal.surface ?? "unknown",
            ...(Number.isFinite(terminal.lastOutputAt) ? { last_output_at: terminal.lastOutputAt } : {}),
          },
          already_tracked: this.deliveries().some((delivery) => delivery.project_id === project.id &&
            delivery.session_id === parent.session_id && delivery.terminal?.handle === terminal.handle),
        });
      }
    }
    return { ok: true, project: project.id, candidates };
  }

  async trackRun(projectQuery, candidateId) {
    if (this.settings().enabled !== true) return { ok: false, reason: "control-plane-disabled" };
    assertSafeId(candidateId, "run candidate id");
    const discovered = await this.discoverRuns(projectQuery);
    if (!discovered.ok) return discovered;
    const matches = discovered.candidates.filter((candidate) => candidate.candidate_id === candidateId);
    if (matches.length !== 1) return { ok: false, reason: "run-candidate-stale-or-ambiguous", project: discovered.project };
    const candidate = matches[0];
    return withLock(this.home, `project-${candidate.project_id}`, async () => {
      const sameSession = this.deliveries().find((delivery) => delivery.project_id === candidate.project_id &&
        delivery.session_id === candidate.session_id);
      if (sameSession?.terminal?.handle === candidate.terminal.handle) {
        return { ok: true, replay: true, outcome: "tracked", delivery: this.projectDelivery(sameSession) };
      }
      if (sameSession) {
        if (sameSession.observation_mode !== "external-readonly" || sameSession.result ||
            sameSession.issue?.number !== candidate.issue.number || sameSession.worktree?.id !== candidate.worktree.id ||
            sameSession.worktree?.path !== candidate.worktree.path) {
          return { ok: false, reason: "tracked-session-terminal-rebind-conflict", delivery: this.projectDelivery(sameSession) };
        }
        sameSession.generation += 1;
        sameSession.status = "running";
        sameSession.terminal = candidate.terminal;
        sameSession.observation = {
          ...sameSession.observation,
          feature_id: candidate.feature_id,
          phase: candidate.phase,
        };
        delete sameSession.terminal_exit_observed_at;
        delete sameSession.terminal_exit_notified_generation;
        delete sameSession.terminal_unknown_notified_generation;
        delete sameSession.terminal_idle_notified_output_at;
        delete sameSession.terminal_idle_notified_fingerprint;
        this.writeDelivery(sameSession);
        return { ok: true, replay: false, outcome: "terminal-rebound", delivery: this.projectDelivery(sameSession) };
      }
      const sameIssue = this.deliveries().find((delivery) => delivery.project_id === candidate.project_id &&
        delivery.issue?.number === candidate.issue.number);
      if (sameIssue) return { ok: false, reason: "issue-already-bound-to-delivery", delivery: this.projectDelivery(sameIssue) };
      const deliveryId = `observed-${digest(`${candidate.project_id}:${candidate.session_id}`).slice(0, 20)}`;
      const deliveryDir = this.deliveryDir(deliveryId);
      ensurePrivateDirectory(deliveryDir);
      ensurePrivateDirectory(path.join(deliveryDir, "outbox"));
      const record = {
        schema: DELIVERY_SCHEMA,
        delivery_id: deliveryId,
        project_id: candidate.project_id,
        issue: candidate.issue,
        status: "running",
        generation: 1,
        session_id: candidate.session_id,
        worktree: candidate.worktree,
        terminal: candidate.terminal,
        observation_mode: "external-readonly",
        observation: {
          source: "orca+harness-parent-lock",
          feature_id: candidate.feature_id,
          phase: candidate.phase,
          bridge: "unavailable-preexisting-session",
          decisions: "not-forwardable",
        },
        created_at: now(),
        adopted_at: now(),
        updated_at: now(),
      };
      this.writeDelivery(record);
      return { ok: true, outcome: "tracked", replay: false, delivery: this.projectDelivery(record) };
    });
  }

  async sendTrackedRunMessage({ delivery_id: deliveryId, message, authorization }) {
    requireExplicitAuthorization(authorization, "tracked run message");
    if (this.settings().enabled !== true) return { ok: false, reason: "control-plane-disabled" };
    const text = String(message ?? "").trim();
    if (!text || text.length > 4000) throw new Error("tracked run message must be 1..4000 characters");
    rejectSensitiveFields({ message: text });
    const initial = this.readDelivery(deliveryId);
    if (initial.observation_mode !== "external-readonly") {
      return { ok: false, reason: "delivery-is-not-an-external-tracked-run", delivery: this.projectDelivery(initial) };
    }
    const project = this.resolveProject(initial.project_id).project;
    return withLock(this.home, `project-${project.id}`, async () => {
      const record = this.readDelivery(deliveryId);
      if (!record.terminal?.handle || !record.worktree?.path || !record.session_id) {
        return { ok: false, reason: "tracked-run-identity-missing", delivery: this.projectDelivery(record) };
      }
      const messageId = `tracked-message-${digest(`${deliveryId}\0${record.session_id}\0${text}`).slice(0, 24)}`;
      const messageFile = path.join(this.deliveryDir(deliveryId), "outbox", `${messageId}.json`);
      const existing = readPrivateJson(messageFile, { optional: true });
      if (existing) {
        return { ok: true, replay: true, state: existing.state, message_id: messageId, applied: false, delivery: this.projectDelivery(record) };
      }
      try {
        const observed = await this.external.orca([
          "terminal", "wait", "--terminal", record.terminal.handle, "--for", "exit", "--timeout-ms", "1",
        ], { cwd: record.worktree.path });
        if (observed?.wait?.satisfied === true) {
          return { ok: false, reason: "tracked-parent-not-running", delivery: this.projectDelivery(record) };
        }
      } catch (error) {
        if (error?.code !== "timeout" && !/\btimeout\b/i.test(error?.message ?? "")) {
          return { ok: false, reason: "tracked-parent-liveness-unknown", diagnostic: safeDiagnostic(error), delivery: this.projectDelivery(record) };
        }
      }
      const envelope = {
        schema: "harness.control.tracked-message.v1",
        message_id: messageId,
        project_id: record.project_id,
        delivery_id: record.delivery_id,
        session_id: record.session_id,
        terminal_handle: record.terminal.handle,
        content_sha256: digest(text),
        state: "queued",
        created_at: now(),
      };
      atomicWriteJson(messageFile, envelope);
      try {
        await this.external.orca([
          "terminal", "send", "--terminal", record.terminal.handle, "--text", text, "--enter",
        ], { cwd: record.worktree.path });
        envelope.state = "sent";
        envelope.sent_at = now();
        atomicWriteJson(messageFile, envelope);
        delete record.terminal_idle_notified_output_at;
        this.writeDelivery(record);
        return { ok: true, replay: false, state: "sent", message_id: messageId, applied: false, delivery: this.projectDelivery(record) };
      } catch (error) {
        envelope.state = "unknown";
        envelope.last_error = safeDiagnostic(error);
        atomicWriteJson(messageFile, envelope);
        return { ok: false, reason: "tracked-message-send-unknown", state: "unknown", message_id: messageId, applied: false, diagnostic: envelope.last_error, delivery: this.projectDelivery(record) };
      }
    });
  }

  async recommendIssue(projectQuery) {
    if (this.settings().enabled !== true) return { ok: false, reason: "control-plane-disabled" };
    const resolved = this.resolveProject(projectQuery);
    if (!resolved.ok) return resolved;
    const project = resolved.project;
    const identity = await this.verifyProjectIdentity(project);
    if (!identity.ok) return { ...identity, project: project.id };
    const compatibility = await this.consumerCapabilities(project).catch((error) => ({ ok: false, reason: safeDiagnostic(error) }));
    if (!compatibility.ok) return { ok: false, reason: "consumer-incompatible", diagnostic: compatibility.reason, project: project.id };
    const issues = await this.external.gh([
      "issue", "list", "--repo", project.gh_repo, "--label", "harness:ready", "--state", "open", "--limit", "200",
      "--json", "number,title,body,createdAt,labels,url",
    ], { cwd: project.repo_path });
    let worktreeInventory;
    try {
      worktreeInventory = await this.external.orca([
        "worktree", "list", "--repo", `id:${project.orca_repo_id}`, "--limit", "200",
      ], { cwd: project.repo_path });
    } catch (error) {
      return { ok: false, reason: "execution-inventory-unavailable", diagnostic: safeDiagnostic(error), project: project.id };
    }
    if (!Array.isArray(worktreeInventory.worktrees) || worktreeInventory.truncated === true) {
      return { ok: false, reason: "execution-inventory-incomplete", project: project.id };
    }
    // A failed or completed delivery still owns its issue. Re-admission must be an
    // explicit lifecycle operation on that delivery, never a fresh parent.
    const activeIssues = new Set([
      ...this.deliveries().filter((delivery) => delivery.project_id === project.id).map((delivery) => delivery.issue.number),
      ...worktreeInventory.worktrees.map(worktreeIssueNumber).filter(Number.isInteger),
    ]);
    const eligible = issues.filter((issue) => Number.isInteger(issue.number))
      .filter((issue) => !activeIssues.has(issue.number))
      .filter((issue) => !labelNames(issue).some((label) => BLOCKED_LABELS.has(label)));
    const dependencyNumbers = [...new Set(eligible.flatMap((issue) => parseDependsOn(issue.body)))];
    const dependencyStates = new Map(await Promise.all(dependencyNumbers.map(async (number) => {
      try {
        const viewed = await this.external.gh([
          "issue", "view", String(number), "--repo", project.gh_repo, "--json", "state",
        ], { cwd: project.repo_path });
        return [number, String(viewed?.state ?? "").toUpperCase()];
      } catch {
        return [number, "UNKNOWN"];
      }
    })));
    const candidates = eligible
      .filter((issue) => parseDependsOn(issue.body).every((dep) => dependencyStates.get(dep) === "CLOSED"))
      .sort((a, b) => issuePriority(a) - issuePriority(b) || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() || a.number - b.number);
    if (!candidates.length) return { ok: true, project: project.id, recommendation: null, reason: "no compatible unblocked issue is available" };
    const issue = candidates[0];
    return withLock(this.home, `project-${project.id}`, async () => {
      if (this.deliveries().some((delivery) =>
        delivery.project_id === project.id && delivery.issue.number === issue.number)) {
        return { ok: true, project: project.id, recommendation: null, reason: "selected issue became active before recommendation was recorded" };
      }
      const current = this.recommendations()
        .filter((entry) => entry.project_id === project.id && entry.state === "recommended");
      const replay = current.find((entry) => entry.issue.number === issue.number);
      if (replay) return { ok: true, project: project.id, recommendation: replay, replay: true };
      const recommendationId = `rec-${token(10)}`;
      const record = {
        schema: RECOMMENDATION_SCHEMA, recommendation_id: recommendationId, project_id: project.id,
        issue: { number: issue.number, title: issue.title, url: issue.url, labels: labelNames(issue) },
        state: "recommended", created_at: now(),
        reason: issuePriority(issue) < 3 ? "highest eligible priority; no active delivery or open dependency" : "oldest eligible issue; no active delivery or open dependency",
      };
      for (const previous of current) {
        previous.state = "superseded";
        previous.superseded_at = now();
        previous.replaced_by = recommendationId;
        atomicWriteJson(path.join(this.home, "recommendations", `${previous.recommendation_id}.json`), previous);
      }
      atomicWriteJson(path.join(this.home, "recommendations", `${recommendationId}.json`), record);
      return { ok: true, project: project.id, recommendation: record };
    });
  }

  recommendation(id) {
    assertSafeId(id, "recommendation id");
    return readPrivateJson(path.join(this.home, "recommendations", `${id}.json`));
  }

  recommendations() { return listPrivateRecords(path.join(this.home, "recommendations")); }

  deliveryDir(id) {
    assertSafeId(id, "delivery id");
    return path.join(this.home, "deliveries", id);
  }

  readDelivery(id) { return readPrivateJson(path.join(this.deliveryDir(id), "record.json")); }
  writeDelivery(record) {
    record.updated_at = now();
    atomicWriteJson(path.join(this.deliveryDir(record.delivery_id), "record.json"), record);
  }

  async automationStatus(projectQuery, { internal = false } = {}) {
    const resolved = this.resolveProject(projectQuery);
    if (!resolved.ok) return resolved;
    const project = resolved.project;
    const identity = await this.verifyProjectIdentity(project);
    if (!identity.ok) return identity;
    const inventory = await this.producerInventory(project);
    if (!inventory.ok) return internal ? inventory : publicAutomationResult(inventory);
    const { producers, cronRows, orcaRows } = inventory;
    const discovered = !project.automation;
    const selected = discovered
      ? cronRows
      : project.automation.kind === "crontab-selector"
        ? cronRows.filter((row) => row.config_path === project.automation.config_path)
        : orcaRows.filter((row) => row.id === project.automation.id);
    if (selected.length !== 1) {
      const result = {
        ok: false,
        reason: selected.length
          ? (discovered ? "existing-producer-ambiguous" : "registered-producer-ambiguous")
          : (discovered ? "no-existing-automation-found" : "registered-producer-missing"),
        project: project.id, producers,
      };
      return internal ? result : publicAutomationResult(result);
    }
    const concurrent = producers.filter((producer) => producer.active && producer !== selected[0]);
    const result = {
      ok: concurrent.length === 0,
      reason: concurrent.length ? "concurrent-producer-active" : undefined,
      project: project.id, producer: selected[0], concurrent, producers,
      ...(discovered ? { discovered: true } : {}),
    };
    return internal ? result : publicAutomationResult(result);
  }

  async persistDiscoveredAutomation(projectId, producer) {
    if (producer.kind !== "crontab-selector" || !path.isAbsolute(producer.config_path ?? "")) {
      throw new Error("only an exact existing selector can be discovered automatically");
    }
    return withLock(this.home, "projects", async () => {
      const file = path.join(this.home, "projects", `${projectId}.json`);
      const current = readPrivateJson(file);
      const binding = { kind: "crontab-selector", config_path: producer.config_path };
      if (current.automation && canonicalJson(current.automation) !== canonicalJson(binding)) {
        throw new Error("project automation changed during discovery");
      }
      if (!current.automation) {
        current.automation = binding;
        current.updated_at = now();
        atomicWriteJson(file, current);
      }
      return current;
    });
  }

  async producerInventory(project) {
    let cronText;
    let result;
    try {
      [cronText, result] = await Promise.all([
        this.external.crontabRead(),
        this.external.orca(["automations", "list"], { cwd: project.repo_path }),
      ]);
    } catch (error) {
      return { ok: false, reason: "producer-inventory-unavailable", diagnostic: safeDiagnostic(error), project: project.id };
    }
    const allCronRows = cronText.split("\n").map((line, index) => ({ line, index }))
      .filter(({ line }) => isCanonicalSelectorCronLine(line))
      .map((row) => {
        const schedule_line = canonicalSelectorCronBody(row.line);
        const config_path = selectorConfigPath(schedule_line);
        const registered = config_path != null && config_path === project.automation?.config_path;
        const belongs = config_path ? configBelongsToProject(config_path, project) : null;
        return { ...row, schedule_line, kind: "crontab-selector", config_path, active: !/^\s*#/.test(row.line), belongs, registered };
      });
    const registeredCronMismatch = allCronRows.find((row) => row.registered && row.belongs === false);
    if (registeredCronMismatch) {
      return { ok: false, reason: "registered-producer-target-mismatch", project: project.id };
    }
    const registeredCronUnknown = allCronRows.find((row) => row.registered && row.belongs === null);
    if (registeredCronUnknown) {
      return { ok: false, reason: "producer-inventory-incomplete", project: project.id };
    }
    const unresolved = allCronRows.filter((row) => row.active && row.belongs === null);
    const cronRows = allCronRows.filter((row) => row.belongs === true);
    if (unresolved.length) {
      return { ok: false, reason: "producer-inventory-incomplete", project: project.id, unresolved };
    }
    const items = result.automations ?? result.items ?? [];
    if (!Array.isArray(items)) return { ok: false, reason: "producer-inventory-incomplete", project: project.id };
    // An Orca automation is an arbitrary scheduled prompt. This repository's
    // PR reviewer targets the same repo but does not create deliveries, so repo
    // membership alone is not evidence that an automation is a producer. Only
    // the exact producer registered for this project enters this inventory.
    const registeredOrca = project.automation?.kind === "orca"
      ? items.filter((item) => item.id === project.automation.id)
      : [];
    const targetMismatch = registeredOrca.find((item) => automationRepoId(item) !== project.orca_repo_id);
    if (targetMismatch) {
      return { ok: false, reason: "registered-producer-target-mismatch", project: project.id };
    }
    const orcaRows = registeredOrca
      .map((item) => ({ kind: "orca", id: item.id, active: item.enabled === true, item }));
    return { ok: true, project: project.id, cronRows, orcaRows, producers: [...cronRows, ...orcaRows] };
  }

  async enableAutomation(projectQuery, authorization) {
    requireExplicitAuthorization(authorization, "automation enable");
    if (this.settings().enabled !== true) return { ok: false, reason: "control-plane-disabled" };
    const resolved = this.resolveProject(projectQuery);
    if (!resolved.ok) return resolved;
    const project = resolved.project;
    return withLock(this.home, `project-${project.id}`, async () => {
      const before = await this.automationStatus(project.id, { internal: true });
      if (!before.ok) return publicAutomationResult(before);
      if (before.discovered) await this.persistDiscoveredAutomation(project.id, before.producer);
      if (before.producer.active) return publicAutomationResult({ ...before, outcome: "already-active", verified: true });
      if (before.producer.kind === "orca") {
        await this.external.orca(["automations", "edit", before.producer.id, "--enabled"], { cwd: project.repo_path });
      } else {
        const current = await this.external.crontabRead();
        const lines = current.split("\n");
        const target = before.producer.index;
        if (lines[target] !== before.producer.line || !/^\s*#/.test(lines[target] ?? "")) {
          throw new Error("crontab producer changed before activation");
        }
        const indentation = lines[target].match(/^\s*/)?.[0] ?? "";
        lines[target] = `${indentation}${before.producer.schedule_line}`;
        await this.external.crontabWrite(lines.join("\n"));
      }
      const after = await this.automationStatus(project.id, { internal: true });
      if (!after.ok || !after.producer.active) {
        return publicAutomationResult({
          ok: false, reason: "automation-postcondition-failed",
          before: publicAutomationResult(before), after: publicAutomationResult(after),
        });
      }
      return publicAutomationResult({ ...after, outcome: "activated", verified: true });
    });
  }

  async assertNoActiveProducer(project) {
    const inventory = await this.producerInventory(project);
    if (!inventory.ok) throw new Error(`cannot exclude concurrent producer: ${inventory.reason}`);
    if (inventory.producers.some((producer) => producer.active)) {
      throw new Error("autonomous producer is active; pause it before a manual delivery admission");
    }
  }

  async deliveryAdmissionStatus(project, issue) {
    let viewed;
    try {
      viewed = await this.external.gh([
        "issue", "view", String(issue.number), "--repo", project.gh_repo,
        "--json", "number,title,state,labels,url,body",
      ], { cwd: project.repo_path });
    } catch (error) {
      return { ok: false, reason: "issue-state-unavailable", diagnostic: safeDiagnostic(error) };
    }
    const labels = labelNames(viewed);
    if (String(viewed?.state ?? "").toUpperCase() !== "OPEN") return { ok: false, reason: "issue-not-open" };
    if (!labels.includes("harness:ready")) return { ok: false, reason: "issue-not-ready" };
    if (labels.some((label) => BLOCKED_LABELS.has(label))) return { ok: false, reason: "issue-not-admissible" };
    for (const dependency of parseDependsOn(viewed.body)) {
      let dependencyState;
      try {
        const result = await this.external.gh([
          "issue", "view", String(dependency), "--repo", project.gh_repo, "--json", "state",
        ], { cwd: project.repo_path });
        dependencyState = String(result?.state ?? "").toUpperCase();
      } catch (error) {
        return { ok: false, reason: "issue-dependency-state-unavailable", diagnostic: safeDiagnostic(error) };
      }
      if (dependencyState !== "CLOSED") {
        return { ok: false, reason: "issue-dependency-not-closed", dependency };
      }
    }
    let listed;
    try {
      listed = await this.external.orca([
        "worktree", "list", "--repo", `id:${project.orca_repo_id}`, "--limit", "200",
      ], { cwd: project.repo_path });
    } catch (error) {
      return { ok: false, reason: "execution-inventory-unavailable", diagnostic: safeDiagnostic(error) };
    }
    if (!Array.isArray(listed.worktrees) || listed.truncated === true) {
      return { ok: false, reason: "execution-inventory-incomplete" };
    }
    if (listed.worktrees.some((worktree) => worktreeIssueNumber(worktree) === issue.number)) {
      return { ok: false, reason: "issue-already-in-execution" };
    }
    return { ok: true };
  }

  async startDelivery(recommendationId, authorization) {
    requireExplicitAuthorization(authorization, "delivery start");
    if (this.settings().enabled !== true) return { ok: false, reason: "control-plane-disabled" };
    const recommendation = this.recommendation(recommendationId);
    const project = this.resolveProject(recommendation.project_id).project;
    const deliveryId = `delivery-${digest(`${project.id}:${recommendation.issue.number}:${recommendationId}`).slice(0, 20)}`;
    return withLock(this.home, `project-${project.id}`, async () => {
      const sameIssue = this.deliveries().find((entry) => entry.project_id === project.id && entry.issue.number === recommendation.issue.number);
      if (sameIssue && sameIssue.delivery_id !== deliveryId) return { ok: true, replay: true, delivery: this.projectDelivery(sameIssue) };
      const deliveryDir = this.deliveryDir(deliveryId);
      let record = readPrivateJson(path.join(deliveryDir, "record.json"), { optional: true });
      const replay = record !== null;
      if (!record) {
        if (recommendation.state !== "recommended") throw new Error(`recommendation is not current: ${recommendation.state}`);
        const identity = await this.verifyProjectIdentity(project);
        if (!identity.ok) return { ...identity, project: project.id };
        await this.assertNoActiveProducer(project);
        const admission = await this.deliveryAdmissionStatus(project, recommendation.issue);
        if (!admission.ok) return admission;
        const compatibility = await this.consumerCapabilities(project)
          .catch((error) => ({ ok: false, reason: safeDiagnostic(error) }));
        if (!compatibility.ok) return { ok: false, reason: "consumer-incompatible", diagnostic: compatibility.reason };
        // Admission is still side-effect free at this point. Only reserve
        // private delivery state after producer and consumer preflights pass.
        ensurePrivateDirectory(deliveryDir);
        ensurePrivateDirectory(path.join(deliveryDir, "inbox"));
        ensurePrivateDirectory(path.join(deliveryDir, "inbox", "handled"));
        record = {
          schema: DELIVERY_SCHEMA, delivery_id: deliveryId, project_id: project.id,
          issue: recommendation.issue, recommendation_id: recommendationId, status: "reserved", generation: 1,
          consumer: { version: compatibility.version, protocol: CONTROL_PROTOCOL },
          worktree_requested: false, terminal_requested: false, worktree: null, terminal: null, session_id: null,
          created_at: now(), updated_at: now(),
        };
        this.writeDelivery(record);
        recommendation.state = "consumed";
        recommendation.delivery_id = deliveryId;
        recommendation.consumed_at = now();
        atomicWriteJson(path.join(this.home, "recommendations", `${recommendationId}.json`), recommendation);
      } else {
        if (record.recommendation_id !== recommendationId || record.project_id !== project.id ||
            record.issue?.number !== recommendation.issue.number) {
          throw new Error("delivery reservation identity conflicts with recommendation");
        }
        if (recommendation.delivery_id && recommendation.delivery_id !== deliveryId) {
          throw new Error("recommendation is bound to another delivery");
        }
        if (recommendation.state !== "consumed" || recommendation.delivery_id !== deliveryId) {
          recommendation.state = "consumed";
          recommendation.delivery_id = deliveryId;
          recommendation.consumed_at ??= now();
          delete recommendation.superseded_at;
          delete recommendation.replaced_by;
          atomicWriteJson(path.join(this.home, "recommendations", `${recommendationId}.json`), recommendation);
        }
        ensurePrivateDirectory(deliveryDir);
        ensurePrivateDirectory(path.join(deliveryDir, "inbox"));
        ensurePrivateDirectory(path.join(deliveryDir, "inbox", "handled"));
      }
      const result = await this.ensureDeliveryStarted(project, record);
      return { ...result, replay };
    });
  }

  async resumeDelivery({ delivery_id: deliveryId, instruction, authorization }) {
    requireExplicitAuthorization(authorization, "resume");
    if (this.settings().enabled !== true) return { ok: false, reason: "control-plane-disabled" };
    const initial = this.readDelivery(deliveryId);
    if (initial.observation_mode === "external-readonly") {
      return { ok: false, reason: "tracked-run-is-observation-only", delivery: this.projectDelivery(initial) };
    }
    const project = this.resolveProject(initial.project_id).project;
    return withLock(this.home, `project-${project.id}`, async () => {
      const record = this.readDelivery(deliveryId);
      const projection = this.projectDelivery(record);
      if (record.resume_pending === true) {
        const identity = await this.verifyProjectIdentity(project);
        if (!identity.ok) return { ...identity, project: project.id, delivery: projection };
        const compatibility = await this.consumerCapabilities(record.worktree.path)
          .catch((error) => ({ ok: false, reason: safeDiagnostic(error) }));
        if (!compatibility.ok) {
          return { ok: false, reason: "consumer-incompatible", diagnostic: compatibility.reason, delivery: projection };
        }
        return this.ensureDeliveryStarted(project, record);
      }
      if (!["interrupted", "blocked", "failed", "launch-unknown"].includes(projection.state)) {
        return { ok: false, reason: "delivery-not-resumable", delivery: projection };
      }
      if (!record.session_id || !record.worktree || !record.terminal?.handle) {
        return { ok: false, reason: "exact-resume-identity-missing", delivery: projection };
      }
      const identity = await this.verifyProjectIdentity(project);
      if (!identity.ok) return { ...identity, project: project.id, delivery: projection };
      const compatibility = await this.consumerCapabilities(record.worktree.path)
        .catch((error) => ({ ok: false, reason: safeDiagnostic(error) }));
      if (!compatibility.ok) {
        return { ok: false, reason: "consumer-incompatible", diagnostic: compatibility.reason, delivery: projection };
      }
      let wait;
      try {
        wait = await this.external.orca([
          "terminal", "wait", "--terminal", record.terminal.handle,
          "--for", "exit", "--timeout-ms", "1",
        ], { cwd: record.worktree.path });
      } catch (error) {
        return { ok: false, reason: error?.code === "timeout" ? "previous-parent-still-active" : "previous-parent-exit-unknown", diagnostic: safeDiagnostic(error), delivery: projection };
      }
      if (wait?.wait?.satisfied !== true) return { ok: false, reason: "previous-parent-exit-unconfirmed", delivery: projection };
      const nextGeneration = record.generation + 1;
      const bridge = readBridge(this.deliveryDir(deliveryId), { sessionId: record.session_id });
      if (bridge.generation === record.generation) {
        await prepareBridgeResume(this.deliveryDir(deliveryId), { sessionId: record.session_id, nextGeneration });
      } else if (bridge.generation !== nextGeneration || !bridge.resumed_at) {
        return { ok: false, reason: "resume-generation-conflict", delivery: projection };
      }
      record.generation = nextGeneration;
      record.terminal = null;
      record.terminal_requested = false;
      record.status = "worktree-ready";
      record.resume_pending = true;
      record.resume_instruction = typeof instruction === "string" && instruction.trim()
        ? instruction.trim().slice(0, 4000)
        : "Reconcile the interrupted delivery from its exact session and durable harness evidence. Do not repeat completed work or invent approvals.";
      this.writeDelivery(record);
      return this.ensureDeliveryStarted(project, record);
    });
  }

  async ensureDeliveryStarted(project, record) {
    if (!record.worktree) {
      const marker = `harness-control:${record.delivery_id}:g${record.generation}`;
      const listed = await this.external.orca(["worktree", "list", "--repo", `id:${project.orca_repo_id}`, "--limit", "200"], { cwd: project.repo_path });
      if (!Array.isArray(listed.worktrees) || listed.truncated === true) return { ok: false, reason: "worktree-inventory-incomplete", delivery: this.projectDelivery(record) };
      const matches = listed.worktrees.filter((item) => item.comment === marker);
      if (matches.length > 1) return { ok: false, reason: "duplicate-worktree-conflict", delivery: this.projectDelivery(record) };
      if (listed.worktrees.some((item) => worktreeIssueNumber(item) === record.issue.number && item.comment !== marker)) {
        return { ok: false, reason: "issue-already-in-execution", delivery: this.projectDelivery(record) };
      }
      let worktree = matches[0];
      if (!worktree) {
        if (record.worktree_requested) return { ok: false, reason: "worktree-creation-unresolved", delivery: this.projectDelivery(record) };
        await this.external.git(["-C", project.repo_path, "fetch", "origin", project.base_branch, "--quiet"]);
        record.worktree_requested = true;
        record.status = "worktree-requested";
        this.writeDelivery(record);
        try {
          const created = await this.external.orca([
            "worktree", "create", "--repo", `id:${project.orca_repo_id}`,
            // The existing review automation selects harness-<issue> branches.
            // Keep that owner contract; the delivery marker supplies control-plane identity.
            "--name", `harness-${record.issue.number}`,
            "--issue", String(record.issue.number), "--base-branch", `origin/${project.base_branch}`,
            "--no-parent", "--setup", project.setup, "--comment", marker,
          ], { cwd: project.repo_path });
          worktree = created.worktree;
        } catch (error) {
          record.status = "launch-unknown";
          this.writeDelivery(record);
          return { ok: false, reason: "worktree-creation-unresolved", diagnostic: safeDiagnostic(error), delivery: this.projectDelivery(record) };
        }
      }
      if (!worktree?.id || worktree.repoId !== project.orca_repo_id || worktree.comment !== marker || !path.isAbsolute(worktree.path)) {
        return { ok: false, reason: "worktree-identity-mismatch", delivery: this.projectDelivery(record) };
      }
      const worktreePath = fs.realpathSync(worktree.path);
      const [sourceCommon, worktreeCommon, baseSha, worktreeSha, branch] = await Promise.all([
        this.external.git(["-C", project.repo_path, "rev-parse", "--path-format=absolute", "--git-common-dir"]),
        this.external.git(["-C", worktreePath, "rev-parse", "--path-format=absolute", "--git-common-dir"]),
        this.external.git(["-C", project.repo_path, "rev-parse", `origin/${project.base_branch}`]),
        this.external.git(["-C", worktreePath, "rev-parse", "HEAD"]),
        this.external.git(["-C", worktreePath, "branch", "--show-current"]),
      ]);
      if (!sourceCommon || sourceCommon !== worktreeCommon || !/^[0-9a-f]{40}$/i.test(baseSha) ||
          worktreeSha !== baseSha || branch !== `harness-${record.issue.number}`) {
        return { ok: false, reason: "worktree-git-postcondition-failed", delivery: this.projectDelivery(record) };
      }
      record.worktree = { id: worktree.id, instance_id: worktree.instanceId ?? null, path: worktreePath, branch, base_sha: baseSha, marker };
      record.status = "worktree-ready";
      this.writeDelivery(record);
    }

    const compatibility = await this.consumerCapabilities(record.worktree.path).catch((error) => ({ ok: false, reason: safeDiagnostic(error) }));
    if (!compatibility.ok) {
      record.status = "blocked";
      record.blocked_reason = `created worktree consumer incompatible: ${compatibility.reason}`;
      this.writeDelivery(record);
      return { ok: false, reason: "consumer-incompatible", diagnostic: compatibility.reason, delivery: this.projectDelivery(record) };
    }
    const bindingPath = path.join(this.deliveryDir(record.delivery_id), "bridge.json");
    let bridge = readPrivateJson(bindingPath, { optional: true });
    if (!bridge) {
      bridge = {
        schema: BRIDGE_SCHEMA, protocol: CONTROL_PROTOCOL, project_id: project.id, delivery_id: record.delivery_id,
        binding_token: token(16), generation: record.generation, session_id: record.session_id,
        cwd: record.worktree.path, worktree_id: record.worktree.id, created_at: now(),
      };
      atomicWriteJson(bindingPath, bridge);
    }

    if (!record.terminal) {
      const title = `HARNESS CONTROL ${record.delivery_id} g${record.generation}`;
      const listed = await this.external.orca(["terminal", "list", "--worktree", `id:${record.worktree.id}`, "--limit", "100"], { cwd: record.worktree.path });
      if (!Array.isArray(listed.terminals) || listed.truncated === true) return { ok: false, reason: "terminal-inventory-incomplete", delivery: this.projectDelivery(record) };
      const matches = listed.terminals.filter((item) => item.title === title);
      if (matches.length > 1) return { ok: false, reason: "duplicate-terminal-conflict", delivery: this.projectDelivery(record) };
      let terminal = matches[0];
      if (!terminal) {
        if (record.terminal_requested) return { ok: false, reason: "terminal-creation-unresolved", delivery: this.projectDelivery(record) };
        record.terminal_requested = true;
        record.status = "terminal-requested";
        this.writeDelivery(record);
        const fresh = `Implemente a issue #${record.issue.number}: ${record.issue.title}. Esta é uma entrega autorizada do control plane. O pai global mantém toda decomposição, testes, revisões e shipping; não peça ao control plane para despachar filhos.`;
        const brief = record.session_id
          ? `${record.resume_instruction ?? "Retome esta entrega exata e reconcilie suas evidências."}`
          : fresh;
        const command = terminalCommand("env", [
          `HARNESS_CONTROL_BINDING=${this.deliveryDir(record.delivery_id)}`,
          process.execPath, ".pi/harness/pi-harness.mjs",
          ...(record.session_id ? ["--harness-resume", record.session_id] : []),
          "--", brief,
        ]);
        try {
          const created = await this.external.orca([
            "terminal", "create", "--worktree", `id:${record.worktree.id}`, "--title", title, "--command", command,
          ], { cwd: record.worktree.path });
          terminal = created.terminal;
        } catch (error) {
          record.status = "launch-unknown";
          this.writeDelivery(record);
          return { ok: false, reason: "terminal-creation-unresolved", diagnostic: safeDiagnostic(error), delivery: this.projectDelivery(record) };
        }
      }
      if (!terminal?.handle || terminal.worktreeId !== record.worktree.id) return { ok: false, reason: "terminal-identity-mismatch", delivery: this.projectDelivery(record) };
      record.terminal = { handle: terminal.handle, title, worktree_id: terminal.worktreeId, surface: terminal.surface ?? "unknown" };
      record.status = "launch-unknown";
      this.writeDelivery(record);
    }

    const started = await this.waitForSessionStart(record.delivery_id, record.generation);
    if (!started) return { ok: false, reason: "session-start-unconfirmed", delivery: this.projectDelivery(record) };
    record.session_id = started.session_id;
    record.status = "running";
    delete record.resume_instruction;
    delete record.resume_pending;
    this.writeDelivery(record);
    let inboxWakeup = null;
    const pendingInbox = inboxMessages(this.deliveryDir(record.delivery_id))
      .filter((message) => message.transport_state === "queued");
    if (pendingInbox.length) {
      try {
        await this.external.orca([
          "terminal", "send", "--terminal", record.terminal.handle,
          "--text", "Control-plane inbox pendente. Use harness_control_bridge com action=inbox.", "--enter",
        ], { cwd: record.worktree.path });
        inboxWakeup = "sent";
      } catch {
        // The durable inbox remains authoritative. Do not turn a confirmed
        // session start into success for message application.
        inboxWakeup = "unknown";
      }
    }
    return { ok: true, outcome: "started", ...(inboxWakeup ? { inbox_wakeup: inboxWakeup } : {}), delivery: this.projectDelivery(record) };
  }

  async waitForSessionStart(deliveryId, generation) {
    const dir = this.deliveryDir(deliveryId);
    const deadline = Date.now() + this.startWaitMs;
    while (Date.now() <= deadline) {
      const event = listBridgeEvents(dir).find((entry) => entry.type === "session.started" && entry.generation === generation);
      if (event) return event;
      await this.sleep(Math.min(100, Math.max(1, deadline - Date.now())));
    }
    // Include an event that arrived during the final bounded sleep even when
    // filesystem scheduling resumed just past the deadline.
    return listBridgeEvents(dir).find((entry) => entry.type === "session.started" && entry.generation === generation) ?? null;
  }

  decisionProjection(delivery) {
    const events = listBridgeEvents(this.deliveryDir(delivery.delivery_id));
    const decisions = new Map();
    for (const event of events) {
      const payload = event.payload ?? {};
      if (event.type === "decision.opened") {
        const current = decisions.get(payload.decision_id);
        if (!current || payload.revision >= current.revision) decisions.set(payload.decision_id, {
          decision_id: payload.decision_id, revision: payload.revision, summary: payload.summary,
          options: payload.options, recommendation: payload.recommendation, state: "open", session_id: event.session_id,
        });
      } else if (event.type === "decision.response-received") {
        const current = decisions.get(payload.decision_id);
        if (current?.revision === payload.revision) Object.assign(current, { state: "received", message_id: payload.message_id });
      } else if (event.type === "decision.applied") {
        const current = decisions.get(payload.decision_id);
        if (current?.revision === payload.revision && current.message_id === payload.message_id) Object.assign(current, { state: "applied", evidence: payload.evidence });
      }
    }
    for (const message of inboxMessages(this.deliveryDir(delivery.delivery_id))) {
      const current = decisions.get(message.decision_id);
      if (!current || current.revision !== message.revision || current.state === "applied") continue;
      current.message_id = message.message_id;
      if (message.transport_state === "received") current.state = "received";
      else current.state = message.sent_at ? "sent" : "queued";
    }
    return { events, decisions: [...decisions.values()] };
  }

  projectDelivery(delivery) {
    let projection = { events: [], decisions: [] };
    try { projection = this.decisionProjection(delivery); } catch { /* Newly reserved deliveries have no event log yet. */ }
    const latest = projection.events.at(-1);
    const currentGenerationEvents = projection.events.filter((event) => event.generation === delivery.generation);
    const lifecycle = currentGenerationEvents.filter((event) => [
      "session.started", "session.stopped", "delivery.failed", "delivery.blocked",
    ].includes(event.type)).at(-1);
    let state = delivery.status;
    if (lifecycle?.type === "session.stopped" && !projection.events.some((event) => event.type.startsWith("result."))) state = "interrupted";
    if (lifecycle?.type === "delivery.failed") state = "failed";
    if (lifecycle?.type === "delivery.blocked") state = "blocked";
    if (projection.events.some((event) => event.type === "result.completed")) state = "completed";
    const prEvent = projection.events.filter((event) => event.type === "result.pr-available").at(-1);
    if (prEvent) {
      state = delivery.result_verification?.event_id === prEvent.event_id &&
        delivery.result_verification?.content_sha256 === prEvent.content_sha256
        ? "pr-available"
        : "result-unverified";
    }
    if (projection.decisions.some((decision) => decision.state !== "applied") &&
        !["interrupted", "failed", "blocked", "completed", "pr-available"].includes(state)) {
      state = "waiting-decision";
    }
    const externalActivity = delivery.observation_mode === "external-readonly"
      ? externalActiveActivity(delivery.worktree?.path, delivery.session_id)
      : null;
    return {
      delivery_id: delivery.delivery_id, project_id: delivery.project_id, issue: delivery.issue, state,
      generation: delivery.generation, session_id: delivery.session_id, worktree: delivery.worktree, terminal: delivery.terminal,
      ...(delivery.observation_mode ? {
        tracking: {
          mode: delivery.observation_mode,
          source: delivery.observation?.source,
          bridge: delivery.observation?.bridge,
          decisions: delivery.observation?.decisions,
          phase: delivery.observation?.phase ?? null,
          activity: externalActivity?.ok
            ? {
                state: externalActivity.children.length ? "child-running" : "parent-only",
                active_children: externalActivity.children,
              }
            : { state: "unknown", active_children: [] },
        },
      } : {}),
      decisions: projection.decisions,
      latest_event: latest && NOTIFIABLE_EVENTS.has(latest.type)
        ? { type: latest.type, sequence: latest.sequence, generation: latest.generation, payload: latest.payload }
        : null,
      result: prEvent && state === "result-unverified"
        ? { type: "pr", verified: false, event_id: prEvent.event_id }
        : projection.events.filter((event) => event.type.startsWith("result.")).at(-1)?.payload ?? null,
    };
  }

  async verifyResultEvent(delivery, event) {
    if (event.type !== "result.pr-available") return { ok: true, verified: true };
    if (delivery.result_verification?.event_id === event.event_id &&
        delivery.result_verification?.content_sha256 === event.content_sha256) {
      return { ok: true, verified: true, replay: true };
    }
    const payload = event.payload ?? {};
    if (typeof payload.url !== "string" || typeof payload.draft !== "boolean" ||
        !/^[0-9a-f]{40}$/i.test(payload.head_sha ?? "")) {
      return { ok: false, reason: "pr-postcondition-invalid" };
    }
    const project = this.resolveProject(delivery.project_id).project;
    const identity = await this.verifyProjectIdentity(project);
    if (!identity.ok) return { ok: false, reason: identity.reason, diagnostic: identity.diagnostic };
    if (!prUrlMatchesProject(payload.url, project.gh_repo)) {
      return { ok: false, reason: "pr-project-mismatch" };
    }
    let worktreeHead;
    try {
      worktreeHead = await this.external.git(["-C", delivery.worktree.path, "rev-parse", "HEAD"]);
    } catch (error) {
      return { ok: false, reason: "pr-worktree-head-unknown", diagnostic: safeDiagnostic(error) };
    }
    if (worktreeHead !== payload.head_sha) {
      return { ok: false, reason: "pr-worktree-head-mismatch" };
    }
    let observed;
    try {
      observed = await this.external.gh([
        "pr", "view", payload.url, "--repo", project.gh_repo,
        "--json", "url,isDraft,headRefOid,state",
      ], { cwd: delivery.worktree?.path ?? project.repo_path });
    } catch (error) {
      return { ok: false, reason: "pr-postcondition-unknown", diagnostic: safeDiagnostic(error) };
    }
    if (observed?.url !== payload.url || observed?.isDraft !== payload.draft ||
        observed?.headRefOid !== payload.head_sha || observed?.state !== "OPEN") {
      return { ok: false, reason: "pr-postcondition-mismatch" };
    }
    await withLock(this.home, `project-${project.id}`, async () => {
      const current = this.readDelivery(delivery.delivery_id);
      current.result_verification = {
        kind: "github-pr", event_id: event.event_id,
        content_sha256: event.content_sha256, verified_at: now(),
      };
      this.writeDelivery(current);
    });
    return { ok: true, verified: true };
  }

  async verifiedPortfolio(projectQuery) {
    const snapshot = this.portfolio(projectQuery);
    if (!snapshot.ok) return snapshot;
    if (this.settings().enabled !== true) return snapshot;
    for (const projected of snapshot.deliveries) {
      const delivery = this.readDelivery(projected.delivery_id);
      if (delivery.observation_mode === "external-readonly") continue;
      const event = listBridgeEvents(this.deliveryDir(delivery.delivery_id))
        .filter((entry) => entry.type === "result.pr-available")
        .at(-1);
      if (event && projected.state === "result-unverified") await this.verifyResultEvent(delivery, event);
    }
    return this.portfolio(projectQuery);
  }

  async observedEvent(deliveryId, event) {
    const verification = await this.verifyResultEvent(this.readDelivery(deliveryId), event);
    if (!verification.ok) {
      return {
        ok: false, reason: verification.reason, diagnostic: verification.diagnostic,
        event: { type: event.type, event_id: event.event_id, sequence: event.sequence },
        delivery: this.projectDelivery(this.readDelivery(deliveryId)),
      };
    }
    return { ok: true, outcome: "changed", event, delivery: this.projectDelivery(this.readDelivery(deliveryId)) };
  }

  async acknowledgeNotification(notification) {
    assertPlainObject(notification, "notification");
    assertSafeId(notification.delivery_id, "notification delivery id");
    const initial = this.readDelivery(notification.delivery_id);
    const project = this.resolveProject(initial.project_id).project;
    return withLock(this.home, `project-${project.id}`, async () => {
      const record = this.readDelivery(notification.delivery_id);
      if (notification.kind === "event") {
        if (!Number.isInteger(notification.sequence) || notification.sequence < 1) throw new Error("notification sequence invalid");
        const event = listBridgeEvents(this.deliveryDir(record.delivery_id))
          .find((entry) => entry.sequence === notification.sequence && entry.event_id === notification.event_id);
        if (!event) throw new Error("notification event identity changed");
        record.notification_cursor = Math.max(record.notification_cursor ?? 0, notification.sequence);
        if (event.type === "session.stopped") record.terminal_exit_notified_generation = event.generation;
        if (notification.type === "result.pr-available") {
          record.result_verification_notified_sha256 = event.content_sha256;
        }
      } else if (notification.kind === "verified-result") {
        if (record.result_verification?.content_sha256 !== notification.content_sha256) {
          throw new Error("verified result notification identity changed");
        }
        record.result_verification_notified_sha256 = notification.content_sha256;
      } else if (notification.kind === "terminal-exit") {
        if (record.generation !== notification.generation || record.terminal?.handle !== notification.terminal_handle) {
          throw new Error("terminal notification identity changed");
        }
        record.terminal_exit_notified_generation = notification.generation;
      } else if (notification.kind === "terminal-unknown") {
        if (record.generation !== notification.generation || record.terminal?.handle !== notification.terminal_handle) {
          throw new Error("terminal observation notification identity changed");
        }
        record.terminal_unknown_notified_generation = notification.generation;
      } else if (notification.kind === "terminal-idle") {
        if (record.generation !== notification.generation || record.terminal?.handle !== notification.terminal_handle ||
            record.observation_mode !== "external-readonly" ||
            typeof notification.content_fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(notification.content_fingerprint)) {
          throw new Error("terminal idle notification identity changed");
        }
        record.terminal_idle_notified_fingerprint = notification.content_fingerprint;
      } else if (notification.kind === "bridge-unknown") {
        if (record.generation !== notification.generation) throw new Error("bridge observation notification identity changed");
        record.bridge_unknown_notified_generation = notification.generation;
      } else throw new Error("notification kind unsupported");
      this.writeDelivery(record);
      return { ok: true };
    });
  }

  async nextNotification() {
    if (this.settings().enabled !== true) return null;
    const deliveries = this.deliveries().sort((a, b) => a.created_at.localeCompare(b.created_at));
    for (const initial of deliveries) {
      let record = initial;
      const project = this.resolveProject(record.project_id).project;
      let events;
      if (record.observation_mode === "external-readonly") {
        events = [];
      } else try {
        events = listBridgeEvents(this.deliveryDir(record.delivery_id));
      } catch {
        if (record.bridge_unknown_notified_generation !== record.generation) {
          return {
            kind: "bridge-unknown", type: "delivery.observation-unknown",
            project_id: record.project_id, delivery_id: record.delivery_id, issue: record.issue,
            generation: record.generation,
          };
        }
        events = [];
      }
      let cursor = Number.isInteger(record.notification_cursor) ? record.notification_cursor : 0;
      for (const event of events.filter((entry) => entry.sequence > cursor)) {
        const alreadyReportedExit = event.type === "session.stopped" &&
          record.terminal_exit_notified_generation === event.generation;
        if (!NOTIFIABLE_EVENTS.has(event.type) || alreadyReportedExit) {
          await withLock(this.home, `project-${project.id}`, async () => {
            const current = this.readDelivery(record.delivery_id);
            current.notification_cursor = Math.max(current.notification_cursor ?? 0, event.sequence);
            this.writeDelivery(current);
          });
          cursor = event.sequence;
          continue;
        }
        let type = event.type;
        if (event.type === "result.pr-available") {
          const verified = await this.verifyResultEvent(record, event);
          if (!verified.ok) type = "result.unverified";
          record = this.readDelivery(record.delivery_id);
        }
        return {
          kind: "event", type, event_id: event.event_id, sequence: event.sequence,
          project_id: record.project_id, delivery_id: record.delivery_id, issue: record.issue,
          generation: event.generation,
        };
      }

      record = this.readDelivery(record.delivery_id);
      if (record.result_verification?.content_sha256 &&
          record.result_verification_notified_sha256 !== record.result_verification.content_sha256) {
        return {
          kind: "verified-result", type: "result.pr-available",
          project_id: record.project_id, delivery_id: record.delivery_id, issue: record.issue,
          generation: record.generation, content_sha256: record.result_verification.content_sha256,
        };
      }

      const projection = this.projectDelivery(record);
      const canObserveTerminal = record.terminal?.handle && record.worktree?.path &&
        !["completed", "pr-available"].includes(projection.state) &&
        record.terminal_exit_notified_generation !== record.generation;
      if (!canObserveTerminal) continue;
      try {
        const observed = await this.external.orca([
          "terminal", "wait", "--terminal", record.terminal.handle,
          "--for", "exit", "--timeout-ms", "1",
        ], { cwd: record.worktree.path });
        if (observed?.wait?.satisfied === true) {
          await withLock(this.home, `project-${project.id}`, async () => {
            const current = this.readDelivery(record.delivery_id);
            if (current.generation === record.generation && current.terminal?.handle === record.terminal.handle) {
              current.status = "interrupted";
              current.terminal_exit_observed_at = now();
              this.writeDelivery(current);
            }
          });
          return {
            kind: "terminal-exit", type: "session.interrupted",
            project_id: record.project_id, delivery_id: record.delivery_id, issue: record.issue,
            generation: record.generation, terminal_handle: record.terminal.handle,
          };
        }
      } catch (error) {
        if (error?.code === "timeout" || /\btimeout\b/i.test(error?.message ?? "")) {
          if (record.observation_mode === "external-readonly") {
            const childActivity = externalActiveActivity(record.worktree.path, record.session_id);
            if (!childActivity.ok) {
              if (record.terminal_unknown_notified_generation !== record.generation) {
                return {
                  kind: "terminal-unknown", type: "session.observation-unknown",
                  project_id: record.project_id, delivery_id: record.delivery_id, issue: record.issue,
                  generation: record.generation, terminal_handle: record.terminal.handle,
                };
              }
              continue;
            }
            // A TUI do pai fica ociosa enquanto aguarda um subagente. O registro host-owned de
            // child-identity é a autoridade para esse intervalo; não acorde o modelo para fazer
            // polling de uma run que o Harness prova estar ativa.
            if (childActivity.children.length) continue;
            try {
              const idle = await this.external.orca([
                "terminal", "wait", "--terminal", record.terminal.handle,
                "--for", "tui-idle", "--timeout-ms", "1",
              ], { cwd: record.worktree.path });
              if (idle?.wait?.satisfied === true) {
                const shown = await this.external.orca([
                  "terminal", "show", "--terminal", record.terminal.handle,
                ], { cwd: record.worktree.path });
                const activity = shown?.terminal?.lastOutputAt;
                const fingerprint = terminalAttentionFingerprint(shown?.terminal?.preview);
                if (fingerprint && fingerprint !== record.terminal_idle_notified_fingerprint) {
                  // Um pai em execução passa por intervalos breves de TUI ociosa enquanto
                  // despacha um filho, recebe um resultado ou escolhe o próximo passo. Confirme
                  // que a mesma saída continua estável e que nenhum trabalho filho apareceu
                  // antes de transformar esse intervalo normal em atenção do operador.
                  await this.sleep(this.attentionConfirmMs);
                  const current = this.readDelivery(record.delivery_id);
                  if (current.generation !== record.generation || current.session_id !== record.session_id ||
                      current.terminal?.handle !== record.terminal.handle || current.status !== record.status) continue;
                  const confirmedActivity = externalActiveActivity(current.worktree.path, current.session_id);
                  if (!confirmedActivity.ok || confirmedActivity.children.length) continue;
                  let confirmedIdle;
                  try {
                    confirmedIdle = await this.external.orca([
                      "terminal", "wait", "--terminal", current.terminal.handle,
                      "--for", "tui-idle", "--timeout-ms", "1",
                    ], { cwd: current.worktree.path });
                  } catch (confirmError) {
                    if (confirmError?.code === "timeout" || /\btimeout\b/i.test(confirmError?.message ?? "")) continue;
                    throw confirmError;
                  }
                  if (confirmedIdle?.wait?.satisfied !== true) continue;
                  const confirmedShown = await this.external.orca([
                    "terminal", "show", "--terminal", current.terminal.handle,
                  ], { cwd: current.worktree.path });
                  const confirmedOutputAt = confirmedShown?.terminal?.lastOutputAt;
                  const confirmedFingerprint = terminalAttentionFingerprint(confirmedShown?.terminal?.preview);
                  if (confirmedFingerprint !== fingerprint || confirmedOutputAt !== activity) continue;
                  return {
                    kind: "terminal-idle", type: "session.attention-needed",
                    project_id: record.project_id, delivery_id: record.delivery_id, issue: record.issue,
                    generation: record.generation, terminal_handle: record.terminal.handle,
                    ...(Number.isFinite(confirmedOutputAt) ? { last_output_at: confirmedOutputAt } : {}),
                    content_fingerprint: confirmedFingerprint,
                  };
                }
              }
            } catch (idleError) {
              if (idleError?.code !== "timeout" && !/\btimeout\b/i.test(idleError?.message ?? "") &&
                  record.terminal_unknown_notified_generation !== record.generation) {
                return {
                  kind: "terminal-unknown", type: "session.observation-unknown",
                  project_id: record.project_id, delivery_id: record.delivery_id, issue: record.issue,
                  generation: record.generation, terminal_handle: record.terminal.handle,
                };
              }
            }
          }
          continue;
        }
        if (record.terminal_unknown_notified_generation !== record.generation) {
          return {
            kind: "terminal-unknown", type: "session.observation-unknown",
            project_id: record.project_id, delivery_id: record.delivery_id, issue: record.issue,
            generation: record.generation, terminal_handle: record.terminal.handle,
          };
        }
      }
    }
    return null;
  }

  portfolio(projectQuery) {
    let projectId = null;
    if (projectQuery) {
      const resolved = this.resolveProject(projectQuery);
      if (!resolved.ok) return resolved;
      projectId = resolved.project.id;
    }
    const projects = this.projects()
      .filter((project) => !projectId || project.id === projectId)
      .map(({ id, name, aliases }) => ({ id, name, aliases }));
    const recommendations = this.recommendations()
      .filter((entry) => entry.state === "recommended" && (!projectId || entry.project_id === projectId))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map(({ recommendation_id, project_id, issue, reason, created_at }) => ({ recommendation_id, project_id, issue, reason, created_at }));
    return {
      ok: true, projects, recommendations,
      deliveries: this.deliveries().filter((entry) => !projectId || entry.project_id === projectId).map((entry) => this.projectDelivery(entry)),
    };
  }

  async answerDecision({ delivery_id: deliveryId, decision_id: decisionId, revision, answer, authorization }) {
    requireExplicitAuthorization(authorization, "decision answer");
    if (this.settings().enabled !== true) return { ok: false, reason: "control-plane-disabled" };
    const delivery = this.readDelivery(deliveryId);
    if (delivery.observation_mode === "external-readonly") {
      return { ok: false, reason: "tracked-run-has-no-control-bridge", delivery: this.projectDelivery(delivery) };
    }
    const projected = this.projectDelivery(delivery);
    const decision = projected.decisions.find((entry) => entry.decision_id === decisionId && entry.revision === revision);
    if (!decision || decision.state === "applied") return { ok: false, reason: "decision-not-open-at-revision" };
    if (!delivery.session_id || decision.session_id !== delivery.session_id) return { ok: false, reason: "decision-session-mismatch" };
    const messageId = `answer-${digest(`${deliveryId}:${decisionId}:${revision}`).slice(0, 24)}`;
    const queued = await enqueueInboxMessage(this.deliveryDir(deliveryId), {
      message_id: messageId, decision_id: decisionId, revision, answer,
    });
    try {
      await this.external.orca([
        "terminal", "send", "--terminal", delivery.terminal.handle,
        "--text", "Control-plane inbox pendente. Use harness_control_bridge com action=inbox.", "--enter",
      ], { cwd: delivery.worktree.path });
      await markInboxSent(this.deliveryDir(deliveryId), messageId);
      return { ok: true, state: "sent", message_id: messageId, replay: queued.replay, applied: false };
    } catch (error) {
      return { ok: true, state: "queued", message_id: messageId, replay: queued.replay, applied: false, diagnostic: safeDiagnostic(error) };
    }
  }

  async waitForChange({ delivery_id: deliveryId, after_sequence = 0, timeout_ms = 1_800_000 }) {
    if (this.settings().enabled !== true) return { ok: false, reason: "control-plane-disabled" };
    if (!Number.isInteger(after_sequence) || after_sequence < 0) throw new Error("after_sequence invalid");
    if (!Number.isInteger(timeout_ms) || timeout_ms < 1 || timeout_ms > 3_600_000) throw new Error("timeout_ms must be 1..3600000");
    const initial = this.readDelivery(deliveryId);
    if (initial.observation_mode === "external-readonly") {
      if (!initial.terminal?.handle || !initial.worktree?.path) {
        return { ok: false, reason: "tracked-run-terminal-identity-missing", delivery: this.projectDelivery(initial) };
      }
      const boundedTimeoutMs = Math.min(timeout_ms, 30_000);
      try {
        const value = await this.external.orca([
          "terminal", "wait", "--terminal", initial.terminal.handle,
          "--for", "exit", "--timeout-ms", String(boundedTimeoutMs),
        ], { cwd: initial.worktree.path, timeout: boundedTimeoutMs + 15_000 });
        if (value?.wait?.satisfied !== true) {
          return { ok: true, outcome: "timeout", delivery: this.projectDelivery(initial) };
        }
        const project = this.resolveProject(initial.project_id).project;
        const delivery = await withLock(this.home, `project-${project.id}`, async () => {
          const current = this.readDelivery(deliveryId);
          if (current.session_id === initial.session_id && current.terminal?.handle === initial.terminal.handle) {
            current.status = "interrupted";
            current.terminal_exit_observed_at = now();
            this.writeDelivery(current);
          }
          return this.projectDelivery(current);
        });
        return { ok: true, outcome: "terminal-exited", consequence: "tracked parent stopped; completion and child state remain unknown without a control bridge", delivery };
      } catch (error) {
        if (error?.code === "timeout" || /\btimeout\b/i.test(error?.message ?? "")) {
          return { ok: true, outcome: "timeout", delivery: this.projectDelivery(this.readDelivery(deliveryId)) };
        }
        return { ok: false, reason: "terminal-observation-unknown", diagnostic: safeDiagnostic(error), delivery: this.projectDelivery(this.readDelivery(deliveryId)) };
      }
    }
    const initialEvents = listBridgeEvents(this.deliveryDir(deliveryId));
    const immediate = initialEvents.find((entry) => entry.sequence > after_sequence);
    if (immediate) return this.observedEvent(deliveryId, immediate);
    const deadline = Date.now() + timeout_ms;
    const controller = new AbortController();
    const watchEvents = async () => {
      while (!controller.signal.aborted && Date.now() <= deadline) {
        const events = listBridgeEvents(this.deliveryDir(deliveryId));
        const event = events.find((entry) => entry.sequence > after_sequence);
        if (event) return { kind: "event", event };
        await this.sleep(Math.min(250, Math.max(1, deadline - Date.now())));
      }
      const event = listBridgeEvents(this.deliveryDir(deliveryId)).find((entry) => entry.sequence > after_sequence);
      return event ? { kind: "event", event } : { kind: "timeout" };
    };
    const watchTerminal = async () => {
      if (!initial.terminal?.handle || !initial.worktree?.path) return { kind: "no-terminal" };
      try {
        const value = await this.external.orca([
          "terminal", "wait", "--terminal", initial.terminal.handle,
          "--for", "exit", "--timeout-ms", String(timeout_ms),
        ], { cwd: initial.worktree.path, timeout: timeout_ms + 15_000, signal: controller.signal });
        return value?.wait?.satisfied === true ? { kind: "terminal-exited" } : { kind: "timeout" };
      } catch (error) {
        if (controller.signal.aborted || error?.code === "ABORT_ERR") return { kind: "cancelled" };
        if (error?.code === "timeout" || /\btimeout\b/i.test(error?.message ?? "")) return { kind: "timeout" };
        return { kind: "terminal-unknown", diagnostic: safeDiagnostic(error) };
      }
    };
    const eventPromise = watchEvents();
    let observed = await Promise.race([eventPromise, watchTerminal()]);
    // A backend that reports an early bounded timeout (or a delivery that has
    // no terminal yet) must not suppress a later bridge event in this wait.
    if (["timeout", "no-terminal", "cancelled"].includes(observed.kind) && Date.now() < deadline) {
      observed = await eventPromise;
    }
    controller.abort();
    if (observed.kind === "event") {
      return this.observedEvent(deliveryId, observed.event);
    }
    if (observed.kind === "terminal-exited") {
      const lateEvent = listBridgeEvents(this.deliveryDir(deliveryId)).find((entry) => entry.sequence > after_sequence);
      if (lateEvent) return this.observedEvent(deliveryId, lateEvent);
      const project = this.resolveProject(initial.project_id).project;
      const delivery = await withLock(this.home, `project-${project.id}`, async () => {
        const current = this.readDelivery(deliveryId);
        if (current.generation === initial.generation && current.terminal?.handle === initial.terminal.handle) {
          current.status = "interrupted";
          current.terminal_exit_observed_at = now();
          this.writeDelivery(current);
        }
        return this.projectDelivery(current);
      });
      return { ok: true, outcome: "terminal-exited", consequence: "parent interrupted; child completion is unknown", delivery };
    }
    if (observed.kind === "terminal-unknown") {
      return { ok: false, reason: "terminal-observation-unknown", diagnostic: observed.diagnostic, delivery: this.projectDelivery(this.readDelivery(deliveryId)) };
    }
    return { ok: true, outcome: "timeout", delivery: this.projectDelivery(this.readDelivery(deliveryId)) };
  }
}

export const CONTROL_CAPABILITIES = Object.freeze({
  schema: CAPABILITIES_SCHEMA,
  protocol: CONTROL_PROTOCOL,
  capabilities: REQUIRED_CAPABILITIES,
});
