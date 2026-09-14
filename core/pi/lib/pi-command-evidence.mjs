/** Make native shell output readable by project-scoped eyes, without changing its verdict. */
import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { isPiBashTool, piSessionId } from "./pi-adapter-map.mjs";
import { isSafeSessionId, isSafeFeatureId } from "../../shared/lib/feature-id.mjs";
import { parseTaskDispatchIdentity } from "../../opencode/lib/task-dispatch-identity.mjs";
import { classifyPiReviewDispatch } from "./pi-review-concurrency.mjs";
import { readTaskRunBinding } from "./task-run.mjs";

const INLINE_OUTPUT_MAX_BYTES = 128 * 1024;
const COMMAND_MAX_BYTES = 32 * 1024;
const REVIEW_DIFF_MAX_BYTES = 64 * 1024 * 1024;
const FULL_GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function evidenceDirectory(cwd, sessionId, create = true) {
  if (!isSafeSessionId(sessionId)) throw new Error("invalid session");
  let directory = fs.realpathSync(cwd);
  for (const part of [".pi", "harness", "state", sessionId, "evidence"]) {
    directory = path.join(directory, part);
    try { if (create) fs.mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    const info = fs.lstatSync(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("redirected evidence directory");
  }
  return directory;
}

async function copyOutput(source, destination) {
  // This path comes from native tool metadata, never a pathname parsed from stdout.
  if (fs.realpathSync(path.dirname(source)) !== fs.realpathSync(tmpdir()) ||
      !/^pi-(?:bash|powershell)-[a-f0-9]+\.log$/.test(path.basename(source))) {
    throw new Error("not a native shell spool");
  }
  const fd = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error("output is not a regular file");
    const digest = createHash("sha256");
    let bytes = 0;
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        digest.update(chunk);
        callback(null, chunk);
      },
    });
    // Stream rather than loading an arbitrarily large test output into agent memory.
    await pipeline(
      fs.createReadStream(source, { fd, autoClose: false }),
      meter,
      fs.createWriteStream(destination, { flags: "wx", mode: 0o600 }),
    );
    return { output_bytes: bytes, output_sha256: digest.digest("hex") };
  } finally {
    fs.closeSync(fd);
  }
}

function inlineOutput(event) {
  if (!Array.isArray(event?.content) || event.content.some((part) => part?.type !== "text" || typeof part.text !== "string")) {
    throw new Error("native text output unavailable");
  }
  const output = event.content.map((part) => part.text).join("");
  if (Buffer.byteLength(output) > INLINE_OUTPUT_MAX_BYTES) throw new Error("inline output exceeds evidence limit");
  return output;
}

function originalStatus(event) {
  if (event?.isError !== true) return { kind: "success", is_error: false, exit_code: 0 };
  const text = Array.isArray(event?.content)
    ? event.content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n")
    : "";
  const exited = /Command exited with code (\d+)\s*$/.exec(text);
  if (exited) return { kind: "exit", is_error: true, exit_code: Number(exited[1]) };
  const timeout = /Command timed out after ([0-9]+(?:\.[0-9]+)?) seconds\s*$/.exec(text);
  if (timeout) return { kind: "timeout", is_error: true, timeout_seconds: Number(timeout[1]) };
  if (/Command aborted\s*$/.test(text)) return { kind: "aborted", is_error: true };
  return { kind: "error", is_error: true };
}

function worktreeIdentity(cwd) {
  try {
    const [rootText, headSha, ...extra] = execFileSync("git", ["rev-parse", "--show-toplevel", "HEAD"], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000,
    }).trim().split("\n");
    if (extra.length > 0 || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(headSha)) throw new Error("invalid git identity");
    const status = execFileSync("git", [
      "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ".",
      ":(exclude).pi/harness/", ":(exclude)node_modules/",
    ], {
      cwd, encoding: "buffer", stdio: ["ignore", "pipe", "ignore"], timeout: 10000,
    });
    return {
      worktree_identity_status: "available",
      worktree_root: fs.realpathSync(rootText),
      head_sha: headSha,
      worktree_dirty: status.length > 0,
      worktree_status_sha256: hash(status),
      freshness: "observed-at-tool-result-only",
    };
  } catch {
    return {
      worktree_identity_status: "unavailable",
      freshness: "observed-at-tool-result-only",
    };
  }
}

function splitZero(value) {
  return Buffer.isBuffer(value) ? value.toString("utf8").split("\0").filter(Boolean) : [];
}

function gitBuffer(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "buffer",
    env: { ...process.env, GIT_LITERAL_PATHSPECS: "1", GIT_EXTERNAL_DIFF: "" },
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 15000,
    maxBuffer: REVIEW_DIFF_MAX_BYTES,
  });
}

function reviewAudience(role, prompt) {
  const classified = classifyPiReviewDispatch(role, prompt);
  if (classified) return classified;
  if (role !== "harness-test-reviewer") return null;
  const task = parseTaskDispatchIdentity(prompt);
  return task.ok ? { phase: "test-fidelity", taskId: task.taskId } : null;
}

function reviewBaseline(root, sessionId, audience, headSha) {
  if (audience.phase === "test-fidelity") {
    return { status: "available", sha: headSha, source: "current-head-before-freeze" };
  }
  if (audience.phase === "task") {
    const binding = readTaskRunBinding(root, sessionId);
    const sha = binding?.ok === true ? binding.grant?.base_sha : "";
    if (FULL_GIT_SHA.test(sha ?? "")) {
      try {
        execFileSync("git", ["merge-base", "--is-ancestor", sha, headSha], {
          cwd: root, stdio: "ignore", timeout: 10000,
        });
        return { status: "available", sha, source: "host-task-grant" };
      } catch { /* report unavailable below */ }
    }
    return { status: "unavailable", reason: "host task baseline unavailable" };
  }
  for (const candidate of ["refs/remotes/origin/HEAD", "refs/remotes/origin/main"]) {
    try {
      const sha = execFileSync("git", ["merge-base", headSha, candidate], {
        cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000,
      }).trim();
      if (FULL_GIT_SHA.test(sha)) return { status: "available", sha, source: candidate };
    } catch { /* try the next explicit remote baseline */ }
  }
  return { status: "unavailable", reason: "remote review baseline unavailable" };
}

function sensitiveEvidencePath(value) {
  if (typeof value !== "string") return true;
  const normalized = value.replaceAll("\\", "/");
  return normalized === "node_modules" || normalized.startsWith("node_modules/") ||
    normalized === ".pi/harness" || normalized.startsWith(".pi/harness/") ||
    sensitiveCommand(`git diff -- ${normalized}`);
}

function safeReviewPaths(root, args) {
  return splitZero(gitBuffer(root, args)).filter((relative) => !sensitiveEvidencePath(relative));
}

function statusSnapshot(root) {
  const records = splitZero(gitBuffer(root, [
    "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--", ".",
  ])).map((record) => ({ code: record.slice(0, 2), path: record.slice(3) }))
    .filter((record) => !sensitiveEvidencePath(record.path));
  const indexPaths = safeReviewPaths(root, ["diff", "--cached", "--name-only", "-z", "--no-renames", "HEAD", "--"]);
  const worktreePaths = safeReviewPaths(root, ["diff", "--name-only", "-z", "--no-renames", "--"]);
  const untrackedPaths = safeReviewPaths(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  return { records, indexPaths, worktreePaths, untrackedPaths };
}

function untrackedPatch(root, relativePath) {
  const args = ["diff", "--no-index", "--binary", "--no-ext-diff", "--no-textconv", "--", "/dev/null"];
  args.push(relativePath);
  try {
    return gitBuffer(root, args);
  } catch (error) {
    if (error?.status === 1 && Buffer.isBuffer(error.stdout)) return error.stdout;
    throw error;
  }
}

function exactReviewDiff(root, baseline, headSha, untrackedPaths) {
  const baseSha = baseline.status === "available" ? baseline.sha : headSha;
  const namesArgs = ["diff", "--name-only", "-z", "--no-renames"];
  namesArgs.push(baseSha, "--");
  const trackedPaths = safeReviewPaths(root, namesArgs);
  const diffArgs = ["diff", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "--no-renames"];
  diffArgs.push(baseSha, "--", ...trackedPaths);
  const tracked = trackedPaths.length === 0 ? Buffer.alloc(0) : gitBuffer(root, diffArgs);
  const header = Buffer.from(`# Harness review diff\n# identity: ${JSON.stringify({ baseline, head_sha: headSha })}\n`);
  const chunks = [header, tracked];
  const appendUntracked = untrackedPatch;
  for (const item of untrackedPaths) chunks.push(appendUntracked(root, item));
  const result = Buffer.concat(chunks);
  if (result.length > REVIEW_DIFF_MAX_BYTES) throw new Error("review diff exceeds transport limit");
  return result;
}

function regularFileDigest(file) {
  const open = fs.openSync;
  const fd = open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1) throw new Error("review evidence is not a regular file");
    const digest = createHash("sha256");
    const chunk = Buffer.alloc(64 * 1024);
    let offset = 0;
    for (;;) {
      const size = fs.readSync(fd, chunk, 0, chunk.length, offset);
      if (size === 0) break;
      digest.update(chunk.subarray(0, size));
      offset += size;
    }
    return { bytes: offset, sha256: digest.digest("hex") };
  } finally {
    fs.closeSync(fd);
  }
}

function readRegularJson(file) {
  const open = fs.openSync;
  const fd = open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.size > 1024 * 1024) throw new Error("review metadata is not bounded regular JSON");
    return JSON.parse(fs.readFileSync(fd, "utf8"));
  } finally {
    fs.closeSync(fd);
  }
}

function evidenceRecord(evidenceRoot, metadataPath, currentIdentity, sessionId, verifyOutput = true) {
  if (path.dirname(metadataPath) !== evidenceRoot || !/^[0-9a-f-]{36}\.json$/.test(path.basename(metadataPath))) {
    throw new Error("review evidence metadata path invalid");
  }
  const metadata = readRegularJson(metadataPath);
  const outputPath = metadata?.output_path;
  if (typeof metadata?.command !== "string" || typeof outputPath !== "string" || path.dirname(outputPath) !== evidenceRoot ||
      !/^[0-9a-f-]{36}\.log$/.test(path.basename(outputPath)) ||
      path.basename(metadataPath, ".json") !== path.basename(outputPath, ".log") ||
      metadata.session_id !== sessionId || metadata.worktree_root !== currentIdentity.worktree_root ||
      sensitiveCommand(metadata?.command)) {
    throw new Error("review evidence identity invalid");
  }
  if (verifyOutput) {
    const inspectOutput = regularFileDigest;
    const output = inspectOutput(outputPath);
    if (output.bytes !== metadata.output_bytes || output.sha256 !== metadata.output_sha256) {
      throw new Error("review evidence output changed");
    }
  }
  const freshness = metadata.worktree_identity_status === "available" &&
    metadata.worktree_root === currentIdentity.worktree_root &&
    metadata.head_sha === currentIdentity.head_sha &&
    metadata.worktree_status_sha256 === currentIdentity.worktree_status_sha256
    ? "exact-current"
    : "different-head-or-status";
  return {
    command: metadata.command,
    started_identity: metadata.started_identity,
    original_status: metadata.original_status,
    observed_head_sha: metadata.head_sha,
    observed_worktree_status_sha256: metadata.worktree_status_sha256,
    automatic: automaticReviewCommand(metadata.command),
    freshness,
    output_path: outputPath,
    metadata_path: metadataPath,
    output_bytes: metadata.output_bytes,
    output_sha256: metadata.output_sha256,
  };
}

function suppliedEvidencePaths(prompt, evidenceRoot) {
  const escaped = evidenceRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const separator = path.sep === "\\" ? "\\\\" : path.sep;
  const expression = new RegExp(`${escaped}${separator}([0-9a-f-]{36})\\.(?:log|json)`, "g");
  return [...String(prompt).matchAll(expression)].map((match) => path.join(evidenceRoot, `${match[1]}.json`));
}

function commandEvidenceManifest(evidenceRoot, prompt, currentIdentity, sessionId) {
  const candidates = new Map();
  const inspectRecord = evidenceRecord;
  for (const entry of fs.readdirSync(evidenceRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !/^[0-9a-f-]{36}\.json$/.test(entry.name)) continue;
    const metadataPath = path.join(evidenceRoot, entry.name);
    try { candidates.set(metadataPath, inspectRecord(evidenceRoot, metadataPath, currentIdentity, sessionId, false)); }
    catch { /* invalid or changed evidence is never transported */ }
  }
  const suppliedPaths = new Set(suppliedEvidencePaths(prompt, evidenceRoot));
  const selectedPaths = [...candidates.entries()]
    .filter(([metadataPath, record]) => suppliedPaths.has(metadataPath) ||
      record.freshness === "exact-current" && record.automatic)
    .map(([metadataPath]) => metadataPath);
  const records = new Map();
  for (const metadataPath of selectedPaths) {
    try { records.set(metadataPath, inspectRecord(evidenceRoot, metadataPath, currentIdentity, sessionId)); }
    catch { /* inaccessible or changed output is never transported */ }
  }
  const exactCurrent = [...records.values()]
    .filter((record) => record.freshness === "exact-current" && record.automatic)
    .sort((left, right) => left.metadata_path.localeCompare(right.metadata_path));
  const supplied = [...suppliedPaths]
    .map((metadataPath) => records.get(metadataPath))
    .filter(Boolean)
    .sort((left, right) => left.metadata_path.localeCompare(right.metadata_path));
  const suppliedUnavailable = [...suppliedPaths]
    .filter((metadataPath) => !records.has(metadataPath))
    .sort()
    .map((metadataPath) => ({
      status: "unavailable",
      metadata_path: metadataPath,
      reason: "explicitly referenced command evidence is inaccessible or changed",
    }));
  return { exact_current: exactCurrent, supplied, supplied_unavailable: suppliedUnavailable };
}

/** Read existing native output for declared final checks; never execute or approve a command. */
export function checkPiFinalCommands({ projectRoot, sessionId, commands } = {}) {
  if (commands === undefined) return { ok: true };
  if (!Array.isArray(commands) || commands.length > 100 || commands.some((command) =>
    typeof command !== "string" || !command.trim() || command.length > COMMAND_MAX_BYTES || sensitiveCommand(command))) {
    return { ok: false, reason: "final_review.verification_commands must contain bounded, non-sensitive command strings" };
  }
  if (!commands.length) return { ok: true };
  const missing = new Set(commands);
  try {
    const identity = worktreeIdentity(projectRoot);
    if (identity.worktree_identity_status !== "available" || identity.worktree_dirty) throw new Error("clean HEAD required");
    const directory = evidenceDirectory(projectRoot, sessionId, false);
    const latest = new Map();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !/^[0-9a-f-]{36}\.json$/.test(entry.name)) continue;
      try {
        const metadataPath = path.join(directory, entry.name);
        const record = evidenceRecord(directory, metadataPath, identity, sessionId, false);
        if (record.freshness !== "exact-current" || !missing.has(record.command)) continue;
        const modified = fs.statSync(metadataPath, { bigint: true }).mtimeNs;
        if (!latest.has(record.command) || latest.get(record.command).modified < modified) latest.set(record.command, { metadataPath, modified });
      } catch { /* altered, foreign or stale evidence cannot satisfy preparation */ }
    }
    for (const { metadataPath } of latest.values()) {
      try {
        const record = evidenceRecord(directory, metadataPath, identity, sessionId);
        const start = record.started_identity;
        if (record.freshness === "exact-current" && record.original_status?.kind === "success" &&
          record.original_status.is_error === false && record.original_status.exit_code === 0 &&
          start?.worktree_identity_status === "available" && start.worktree_dirty === false &&
          start.worktree_root === identity.worktree_root && start.head_sha === identity.head_sha &&
          start.worktree_status_sha256 === identity.worktree_status_sha256) missing.delete(record.command);
      } catch { /* unreadable latest output cannot fall back to an older success */ }
    }
  } catch { /* missing native evidence is reported with the exact next commands */ }
  return missing.size ? { ok: false, commands: [...missing], reason:
    `Run the pending final verification commands on the current committed HEAD before final eyes: ${JSON.stringify([...missing])}. Reuse passing current evidence; fix failures before retrying. This does not approve reviews or shipping.` } : { ok: true };
}

function reviewPacketDirectory(evidenceRoot) {
  const parent = path.join(evidenceRoot, "review-packets");
  try { fs.mkdirSync(parent, { mode: 0o700 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  const info = fs.lstatSync(parent);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("redirected review packet directory");
  const directory = path.join(parent, randomUUID());
  fs.mkdirSync(directory, { mode: 0o700 });
  return directory;
}

function createReviewEvidencePacket({ projectRoot, sessionId, audience, prompt }) {
  const root = fs.realpathSync(projectRoot);
  const identity = worktreeIdentity(root);
  if (identity.worktree_identity_status !== "available") throw new Error("git snapshot unavailable");
  const status = statusSnapshot(root);
  const baseline = reviewBaseline(root, sessionId, audience, identity.head_sha);
  const diff = exactReviewDiff(root, baseline, identity.head_sha, status.untrackedPaths);
  const evidenceRoot = evidenceDirectory(root, sessionId);
  const commands = commandEvidenceManifest(evidenceRoot, prompt, identity, sessionId);
  const directory = reviewPacketDirectory(evidenceRoot);
  const snapshotPath = path.join(directory, "snapshot.json");
  const diffPath = path.join(directory, "review.diff");
  const commandEvidencePath = path.join(directory, "command-evidence.json");
  const snapshot = {
    version: 1,
    session_id: sessionId,
    audience,
    worktree_root: root,
    head_sha: identity.head_sha,
    worktree_dirty: identity.worktree_dirty,
    worktree_status_sha256: identity.worktree_status_sha256,
    baseline,
    status: status.records,
    index_paths: status.indexPaths,
    worktree_paths: status.worktreePaths,
    untracked_paths: status.untrackedPaths,
  };
  fs.writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  fs.writeFileSync(diffPath, diff, { flag: "wx", mode: 0o600 });
  fs.writeFileSync(commandEvidencePath, `${JSON.stringify({
    version: 1,
    session_id: sessionId,
    worktree_root: root,
    head_sha: identity.head_sha,
    worktree_status_sha256: identity.worktree_status_sha256,
    exact_current: commands.exact_current,
    supplied: commands.supplied,
    supplied_unavailable: commands.supplied_unavailable,
    freshness_note: "exact_current matches this packet HEAD/status; supplied preserves only explicit brief references and may be stale",
  }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return {
    status: "available",
    snapshot_path: snapshotPath,
    diff_path: diffPath,
    command_evidence_path: commandEvidencePath,
    baseline_status: baseline.status,
  };
}

function sensitiveCommand(command) {
  return /(?:^|[\s/'"`])(?:\.env(?:\.[^\s/'"`]*)?|\.dev\.vars(?:\.[^\s/'"`]*)?|\.ssh|\.aws|\.npmrc|\.netrc|\.pypirc|\.git-credentials|auth\.json|credentials(?:\.json)?|shared_context\.md)(?:$|[\s/'"`])/i.test(command) ||
    /(?:^|[;&|]\s*)(?:env|printenv|set|export\s+-p|gh\s+auth\s+token)(?:\s|$)/i.test(command);
}

// Archive intended verification/inspection output, not every opaque interpreter or
// executable. This selects automatic transport, not permission to run a command,
// and does not prove that project scripts cannot print private data.
function shortEvidenceCommand(command) {
  if (typeof command !== "string" || /[;&|`$\n\r]/.test(command)) return false;
  return /^(?:git\s+(?:diff|status|log|show|rev-parse)|rg|(?:vitest|jest|mocha|tsc)|(?:npm|pnpm|yarn|bun)\s+(?:test|run(?:-script)?|typecheck)|npx\s+(?:--no-install\s+)?(?:vitest|jest|mocha|tsc))\b/.test(command.trim()) ||
    /^(?:\S*\/)?node\s+(?=[^\n]*--test(?:[=\s]|$))/.test(command.trim());
}

function automaticReviewCommand(command) {
  return shortEvidenceCommand(command) && !/^(?:git|rg)\b/.test(command.trim());
}

function declaredVerificationCommand(cwd, sessionId, command) {
  try {
    if (!isSafeSessionId(sessionId)) return false;
    const root = fs.realpathSync(cwd);
    const stateDirectory = path.join(root, ".pi/harness/state", sessionId);
    if (fs.realpathSync(stateDirectory) !== stateDirectory) return false;
    const state = readRegularJson(path.join(stateDirectory, "gate-state.json"));
    if (state.session_id !== sessionId || !isSafeFeatureId(state.feature_id)) return false;
    const planDirectory = path.join(root, ".pi/harness/plans", state.feature_id);
    if (fs.realpathSync(planDirectory) !== planDirectory) return false;
    const plan = readRegularJson(path.join(planDirectory, "execution-plan.json"));
    return plan.feature_id === state.feature_id && Array.isArray(plan.final_review?.verification_commands) &&
      plan.final_review.verification_commands.includes(command);
  } catch { return false; }
}

function publicFailureReason(error) {
  const message = error instanceof Error ? error.message : "";
  return new Set([
    "complete native output unavailable",
    "inline output exceeds evidence limit",
    "native text output unavailable",
    "originating command unavailable",
    "tool call identity unavailable",
  ]).has(message) ? message : "evidence persistence failed";
}

async function persistEvidence({ source, output, cwd, sessionId, event, startedIdentity }) {
  const command = event?.input?.command;
  if (typeof command !== "string" || command.length === 0 || Buffer.byteLength(command) > COMMAND_MAX_BYTES) {
    throw new Error("originating command unavailable");
  }
  if (typeof event?.toolCallId !== "string" || event.toolCallId.length === 0 || event.toolCallId.length > 512) {
    throw new Error("tool call identity unavailable");
  }
  const identity = worktreeIdentity(cwd);
  const directory = evidenceDirectory(cwd, sessionId);
  const id = randomUUID();
  const outputPath = path.join(directory, `${id}.log`);
  const metadataPath = path.join(directory, `${id}.json`);
  try {
    let outputIdentity;
    if (typeof source === "string") outputIdentity = await copyOutput(source, outputPath);
    else {
      const buffer = Buffer.from(output, "utf8");
      fs.writeFileSync(outputPath, buffer, { flag: "wx", mode: 0o600 });
      outputIdentity = { output_bytes: buffer.length, output_sha256: hash(buffer) };
    }
    const metadata = {
      version: 1,
      session_id: sessionId,
      tool_call_id: event.toolCallId,
      tool_name: event.toolName,
      command,
      original_status: originalStatus(event),
      ...(startedIdentity ? { started_identity: startedIdentity } : {}),
      ...identity,
      output_path: outputPath,
      ...outputIdentity,
    };
    fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    return { ...metadata, path: outputPath, metadata_path: metadataPath };
  } catch (error) {
    for (const candidate of [metadataPath, outputPath]) {
      try { fs.unlinkSync(candidate); } catch (cleanupError) { if (cleanupError.code !== "ENOENT") { /* best effort */ } }
    }
    throw error;
  }
}

/** Append readable, host-observed artifacts to review briefs without deciding or approving anything. */
export function attachPiReviewEvidencePacket({ projectRoot, sessionId, event } = {}) {
  const input = event?.input;
  const role = input?.subagent_type;
  const prompt = input?.prompt;
  const audience = reviewAudience(role, prompt);
  if (!audience || !input || typeof prompt !== "string") return { status: "not-applicable" };
  let packet;
  try {
    packet = createReviewEvidencePacket({ projectRoot, sessionId, audience, prompt });
    input.prompt = `${prompt.trimEnd()}\n\n[HARNESS_REVIEW_EVIDENCE]\n${JSON.stringify({
      ...packet,
      authority: "data-transport-only; not approval, receipt, or freshness beyond the recorded snapshot",
    }, null, 2)}\n[/HARNESS_REVIEW_EVIDENCE]`;
  } catch {
    packet = { status: "unavailable", reason: "review evidence transport unavailable" };
    input.prompt = `${prompt.trimEnd()}\n\n[HARNESS_REVIEW_EVIDENCE]\n${JSON.stringify({
      ...packet,
      authority: "dispatch remains unchanged; inspect the named brief/repository evidence directly",
    }, null, 2)}\n[/HARNESS_REVIEW_EVIDENCE]`;
  }
  return packet;
}

export function registerPiCommandEvidence(pi) {
  const pending = new Map();
  const starts = new Map();
  const key = (event, ctx) => JSON.stringify([ctx?.cwd, piSessionId(ctx), event?.toolCallId]);
  pi.on("tool_execution_start", (event, ctx) => {
    if (isPiBashTool(event?.toolName)) starts.set(key(event, ctx), worktreeIdentity(ctx.cwd));
  });
  pi.on("tool_execution_update", (event, ctx) => {
    if (!isPiBashTool(event?.toolName)) return;
    const output = event?.partialResult?.details?.fullOutputPath;
    if (typeof output === "string") pending.set(key(event, ctx), output);
  });
  pi.on("session_start", () => { pending.clear(); starts.clear(); });
  pi.on("session_shutdown", () => { pending.clear(); starts.clear(); });
  pi.on("tool_result", async (event, ctx) => {
    if (!isPiBashTool(event?.toolName)) return;
    // Pi's nonzero/abort/timeout exception drops final details, but the last native
    // update carries the spool path. Copy only now, after the native writer closes.
    const callKey = key(event, ctx);
    const source = event?.details?.fullOutputPath ?? pending.get(callKey);
    pending.delete(callKey);
    const startedIdentity = starts.get(callKey);
    starts.delete(callKey);
    let evidence, note;
    if (typeof event?.input?.command === "string" && sensitiveCommand(event.input.command)) {
      evidence = { status: "not-archived", reason: "credential-or-diary-command" };
      note = "[harness-evidence] Output intentionally not archived because this command targets credential or private run context. The native result is unchanged; use no archived artifact from this call.";
      return {
        content: [...event.content, { type: "text", text: note }],
        details: { ...event.details, command_evidence: evidence },
      };
    }
    if (typeof source !== "string" && typeof event?.input?.command === "string" && !shortEvidenceCommand(event.input.command) &&
        !declaredVerificationCommand(ctx.cwd, piSessionId(ctx), event.input.command)) {
      return {
        content: [...event.content, { type: "text", text: "[harness-evidence] Short output was not automatically archived for this command. The native result is unchanged; include complete safe inline evidence when relevant." }],
        details: { ...event.details, command_evidence: { status: "not-archived", reason: "not-verification-or-inspection" } },
      };
    }
    try {
      if (typeof source !== "string" && event?.details?.truncation?.truncated === true) {
        throw new Error("complete native output unavailable");
      }
      evidence = {
        status: "available",
        ...(await persistEvidence({
          source,
          output: typeof source === "string" ? undefined : inlineOutput(event),
          cwd: ctx?.cwd ?? process.cwd(),
          sessionId: piSessionId(ctx),
          event,
          startedIdentity,
        })),
      };
      note = "[harness-evidence] Exact command evidence: metadata " + evidence.metadata_path +
        "; complete raw output " + evidence.path +
        ". Identity is observed at the tool-result boundary, not an approval or freshness guarantee.";
    } catch (error) {
      evidence = { status: "unavailable", reason: publicFailureReason(error) };
      note = "[harness-evidence] Project evidence unavailable: " + evidence.reason +
        ". The native result is unchanged. Use complete safe inline evidence when sufficient; repair transport only if required evidence is actually inaccessible. Do not rerun solely to move output, infer approval, or rewrite tests.";
    }
    return {
      content: [...event.content, { type: "text", text: note }],
      details: { ...event.details, command_evidence: evidence },
    };
  });
}
