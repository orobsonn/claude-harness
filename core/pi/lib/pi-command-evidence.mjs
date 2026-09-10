/** Make native shell output readable by project-scoped eyes, without changing its verdict. */
import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { isPiBashTool, piSessionId } from "./pi-adapter-map.mjs";
import { isSafeSessionId } from "../../shared/lib/feature-id.mjs";

const INLINE_OUTPUT_MAX_BYTES = 128 * 1024;
const COMMAND_MAX_BYTES = 32 * 1024;

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function evidenceDirectory(cwd, sessionId) {
  if (!isSafeSessionId(sessionId)) throw new Error("invalid session");
  let directory = fs.realpathSync(cwd);
  for (const part of [".pi", "harness", "state", sessionId, "evidence"]) {
    directory = path.join(directory, part);
    try { fs.mkdirSync(directory, { mode: 0o700 }); }
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

function sensitiveCommand(command) {
  return /(?:^|[\s/'"`])(?:\.env(?:\.[^\s/'"`]*)?|\.dev\.vars(?:\.[^\s/'"`]*)?|\.ssh|\.aws|\.git-credentials|auth\.json|credentials(?:\.json)?|shared_context\.md)(?:$|[\s/'"`])/i.test(command) ||
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

async function persistEvidence({ source, output, cwd, sessionId, event }) {
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

export function registerPiCommandEvidence(pi) {
  const pending = new Map();
  const key = (event, ctx) => JSON.stringify([ctx?.cwd, piSessionId(ctx), event?.toolCallId]);
  pi.on("tool_execution_update", (event, ctx) => {
    if (!isPiBashTool(event?.toolName)) return;
    const output = event?.partialResult?.details?.fullOutputPath;
    if (typeof output === "string") pending.set(key(event, ctx), output);
  });
  pi.on("session_start", () => pending.clear());
  pi.on("session_shutdown", () => pending.clear());
  pi.on("tool_result", async (event, ctx) => {
    if (!isPiBashTool(event?.toolName)) return;
    // Pi's nonzero/abort/timeout exception drops final details, but the last native
    // update carries the spool path. Copy only now, after the native writer closes.
    const callKey = key(event, ctx);
    const source = event?.details?.fullOutputPath ?? pending.get(callKey);
    pending.delete(callKey);
    let evidence, note;
    if (typeof event?.input?.command === "string" && sensitiveCommand(event.input.command)) {
      evidence = { status: "not-archived", reason: "credential-or-diary-command" };
      note = "[harness-evidence] Output intentionally not archived because this command targets credential or private run context. The native result is unchanged; use no archived artifact from this call.";
      return {
        content: [...event.content, { type: "text", text: note }],
        details: { ...event.details, command_evidence: evidence },
      };
    }
    if (typeof source !== "string" && typeof event?.input?.command === "string" && !shortEvidenceCommand(event.input.command)) {
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
