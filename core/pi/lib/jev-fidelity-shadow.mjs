/**
 * Shadow-only Jev judgment for the Pi test-fidelity review.
 *
 * This module never grants pipeline authority. It sends the already frozen review
 * packet to TypeSafe, records only hashes/metrics, and compares the answer with the
 * native reviewer after that reviewer has completed normally.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import { isSafeSessionId } from "../../shared/lib/feature-id.mjs";
import { parseTestReviewVerdict } from "../../shared/lib/test-review-verdict.mjs";

export const JEV_SHADOW_ENV = "HARNESS_JEV_FIDELITY_SHADOW";
export const JEV_API_KEY_ENV = "TYPESAFE_API_KEY";
export const JEV_MODEL = "jev-1.13.0";
const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MAX_PROMPT_CHARS = 12_000;
const MAX_DIFF_CHARS = 32_000;
const MAX_COMMAND_CHARS = 24_000;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_EVENT_LOG_BYTES = 16 * 1024 * 1024;

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function enabled(env) {
  return /^(?:1|true|yes|on)$/i.test(String(env?.[JEV_SHADOW_ENV] ?? ""));
}

function redactSecrets(value) {
  return String(value)
    .replace(/-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\n]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]")
    .replace(/\bapikey_[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_API_KEY]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,})\b/gi, "[REDACTED_TOKEN]")
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, "[REDACTED_AWS_KEY]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED_JWT]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, "Bearer [REDACTED_TOKEN]")
    .replace(/((?:api[_-]?key|access[_-]?token|auth[_-]?token|token|password|secret|private[_-]?key)\s*[:=]\s*["']?)[^\s,"']{8,}/gi, "$1[REDACTED]");
}

function bounded(value, limit) {
  const text = redactSecrets(value);
  if (text.length <= limit) return text;
  const half = Math.floor((limit - 80) / 2);
  return `${text.slice(0, half)}\n[...TRUNCATED ${text.length - (half * 2)} CHARS...]\n${text.slice(-half)}`;
}

function block(prompt, name) {
  const matches = [...String(prompt).matchAll(new RegExp(`\\[${name}\\]\\s*([\\s\\S]*?)\\s*\\[\\/${name}\\]`, "g"))];
  return matches.at(-1)?.[1]?.trim() ?? "";
}

function parseJson(value) {
  try { return JSON.parse(value); } catch { return null; }
}

function safeRegularText(file, root, limit) {
  if (typeof file !== "string" || !path.isAbsolute(file)) return "";
  const resolvedRoot = fs.realpathSync(root);
  const resolved = fs.realpathSync(file);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) return "";
  const info = fs.lstatSync(resolved);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES) return "";
  return bounded(fs.readFileSync(resolved, "utf8"), limit);
}

function packetFromPrompt(prompt) {
  const packet = parseJson(block(prompt, "HARNESS_REVIEW_EVIDENCE"));
  return packet && packet.status === "available" ? packet : null;
}

function reviewerBrief(prompt) {
  return bounded(String(prompt)
    .replace(/\[HARNESS_CANONICAL_TASK\][\s\S]*?\[\/HARNESS_CANONICAL_TASK\]/g, "")
    .replace(/\[HARNESS_REVIEW_EVIDENCE\][\s\S]*?\[\/HARNESS_REVIEW_EVIDENCE\]/g, "")
    .trim(), MAX_PROMPT_CHARS);
}

function commandExecution(packet, evidenceRoot) {
  const manifestText = safeRegularText(packet?.command_evidence_path, evidenceRoot, MAX_COMMAND_CHARS);
  const manifest = parseJson(manifestText);
  if (!manifest) return { status: "unavailable" };
  const selected = [...(manifest.exact_current ?? []), ...(manifest.supplied ?? [])];
  const seen = new Set();
  const runs = [];
  let remaining = MAX_COMMAND_CHARS;
  for (const record of selected) {
    if (!record || seen.has(record.output_path) || remaining <= 0) continue;
    seen.add(record.output_path);
    let output = "";
    try { output = safeRegularText(record.output_path, evidenceRoot, remaining); } catch { /* unavailable */ }
    remaining -= output.length;
    runs.push({
      command: bounded(record.command ?? "", 2_000),
      original_status: record.original_status ?? null,
      freshness: record.freshness ?? "unknown",
      output,
    });
  }
  return {
    status: runs.length ? "available" : "unavailable",
    runs,
    supplied_unavailable: Array.isArray(manifest.supplied_unavailable) ? manifest.supplied_unavailable.length : 0,
  };
}

export function buildJevFidelityState({ projectRoot, sessionId, prompt } = {}) {
  const packet = packetFromPrompt(prompt);
  if (!packet) return { ok: false, reason: "review-packet-unavailable" };
  try {
    if (!isSafeSessionId(sessionId)) return { ok: false, reason: "invalid-session" };
    const evidenceRoot = fs.realpathSync(path.join(projectRoot, ".pi", "harness", "state", sessionId, "evidence"));
    const packetDirectory = fs.realpathSync(path.dirname(packet.diff_path));
    const reviewPacketsRoot = fs.realpathSync(path.join(evidenceRoot, "review-packets"));
    if (path.dirname(packetDirectory) !== reviewPacketsRoot ||
        path.dirname(packet.snapshot_path) !== packetDirectory ||
        path.dirname(packet.command_evidence_path) !== packetDirectory ||
        path.basename(packet.diff_path) !== "review.diff" ||
        path.basename(packet.snapshot_path) !== "snapshot.json" ||
        path.basename(packet.command_evidence_path) !== "command-evidence.json") {
      return { ok: false, reason: "review-packet-invalid" };
    }
    const canonical = parseJson(block(prompt, "HARNESS_CANONICAL_TASK"));
    const snapshotText = safeRegularText(packet.snapshot_path, packetDirectory, 8_000);
    const snapshot = parseJson(snapshotText);
    const diff = safeRegularText(packet.diff_path, packetDirectory, MAX_DIFF_CHARS);
    if (!diff) return { ok: false, reason: "review-diff-unavailable" };
    const state = {
      obligation: canonical ?? { status: "unavailable", reviewer_brief: reviewerBrief(prompt) },
      representation: {
        reviewer_brief: reviewerBrief(prompt),
        snapshot: snapshot ? {
          baseline: snapshot.baseline ?? null,
          status: snapshot.status ?? [],
          index_paths: snapshot.index_paths ?? [],
          worktree_paths: snapshot.worktree_paths ?? [],
          untracked_paths: snapshot.untracked_paths ?? [],
        } : { status: "unavailable" },
        exact_review_diff: diff,
      },
      execution: commandExecution(packet, evidenceRoot),
    };
    return { ok: true, state, sha256: hash(JSON.stringify(state)) };
  } catch {
    return { ok: false, reason: "review-packet-invalid" };
  }
}

function observabilityDirectory(projectRoot) {
  const root = fs.realpathSync(projectRoot);
  let current = root;
  for (const part of [".pi", "harness", "observability"]) {
    current = path.join(current, part);
    try { fs.mkdirSync(current, { mode: 0o700 }); }
    catch (error) { if (error?.code !== "EEXIST") throw error; }
    const info = fs.lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("redirected shadow directory");
  }
  return current;
}

function pathsFor(projectRoot) {
  const directory = observabilityDirectory(projectRoot);
  return {
    events: path.join(directory, "jev-fidelity-shadow.jsonl"),
    summary: path.join(directory, "jev-fidelity-shadow-summary.json"),
  };
}

export function summarizeJevFidelityRecords(records) {
  const byCall = new Map();
  for (const record of records) {
    if (!record || typeof record.call_id !== "string") continue;
    const key = `${record.session_id ?? ""}\u0000${record.call_id}`;
    const item = byCall.get(key) ?? {};
    if (record.type === "prediction") item.prediction = record;
    if (record.type === "native-verdict") item.native = record;
    byCall.set(key, item);
  }
  const predictions = [...byCall.values()].filter((item) => item.prediction?.status === "ok");
  const errors = [...byCall.values()].filter((item) => item.prediction && item.prediction.status !== "ok");
  const paired = [...byCall.values()].filter((item) => item.prediction?.status === "ok" && item.native?.verdict);
  const matches = paired.filter((item) => item.prediction.choice === item.native.verdict);
  const falseApproves = paired.filter((item) => item.prediction.choice === "APPROVE" && item.native.verdict !== "APPROVE");
  const falseRejects = paired.filter((item) => item.prediction.choice !== "APPROVE" && item.native.verdict === "APPROVE");
  const inputTokens = predictions.reduce((sum, item) => sum + Number(item.prediction.usage?.input_tokens ?? 0), 0);
  const outputTokens = predictions.reduce((sum, item) => sum + Number(item.prediction.usage?.output_tokens ?? 0), 0);
  const timestamps = records.map((record) => Date.parse(record?.at)).filter(Number.isFinite).sort((a, b) => a - b);
  return {
    version: 1,
    mode: "shadow-only",
    authority: "none",
    model: JEV_MODEL,
    started_at: timestamps.length ? new Date(timestamps[0]).toISOString() : null,
    updated_at: timestamps.length ? new Date(timestamps.at(-1)).toISOString() : null,
    predictions_ok: predictions.length,
    prediction_errors: errors.length,
    paired_reviews: paired.length,
    exact_matches: matches.length,
    agreement_rate: paired.length ? matches.length / paired.length : null,
    false_approves: falseApproves.length,
    false_rejects: falseRejects.length,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

function readRecords(file) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch { return []; }
}

function appendRecord(projectRoot, record) {
  const files = pathsFor(projectRoot);
  const fd = fs.openSync(files.events,
    fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW,
    0o600);
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.size > MAX_EVENT_LOG_BYTES) {
      throw new Error("shadow event log invalid");
    }
    fs.writeFileSync(fd, `${JSON.stringify(record)}\n`);
  } finally {
    fs.closeSync(fd);
  }
  const summary = summarizeJevFidelityRecords(readRecords(files.events));
  const temporary = `${files.summary}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  fs.renameSync(temporary, files.summary);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestJev({ state, apiKey, fetchImpl, signal }) {
  const body = {
    state,
    model: JEV_MODEL,
    questions: {
      fidelity_verdict: {
        type: "choice",
        instructions: {
          question: "Which verdict should the test-fidelity review receive? Judge whether `representation` faithfully and observably encodes every material requirement in `obligation`, using `execution` as runtime evidence.",
          rules: "Do not infer repository facts outside the supplied state. Missing or unusable evidence is BLOCKED.",
        },
        criteria: {
          APPROVE: "Every material obligation is asserted by a test that distinguishes the intended behavior from a materially weaker implementation, and the supplied execution evidence is sufficient.",
          REVISE: "The test representation is present but misses, weakens, or contradicts at least one material obligation.",
          BLOCKED: "The supplied representation or execution evidence is insufficient to judge fidelity.",
        },
      },
    },
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (![429, 529].includes(response.status) || attempt === 2) {
      if (!response.ok) throw new Error(`http-${response.status}`);
      return response.json();
    }
    await delay(250 * (2 ** attempt));
  }
  throw new Error("retry-exhausted");
}

export function startJevFidelityShadow({ projectRoot, sessionId, callId, dispatch, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  if (!enabled(env) || dispatch?.subagent_type !== "harness-test-reviewer") return false;
  if (!isSafeSessionId(sessionId) || typeof callId !== "string" || !callId || typeof fetchImpl !== "function") return false;
  const apiKey = env?.[JEV_API_KEY_ENV];
  const built = buildJevFidelityState({ projectRoot, sessionId, prompt: dispatch.prompt });
  const base = {
    version: 1,
    type: "prediction",
    at: new Date().toISOString(),
    session_id: sessionId,
    call_id: callId,
    task_id: typeof dispatch.task_id === "string" ? dispatch.task_id : null,
    feature_id: typeof dispatch.feature_id === "string" ? dispatch.feature_id : null,
    model_requested: JEV_MODEL,
  };
  if (typeof apiKey !== "string" || !apiKey) {
    try { appendRecord(projectRoot, { ...base, status: "error", error: "missing-api-key" }); } catch { /* shadow only */ }
    return true;
  }
  if (!built.ok) {
    try { appendRecord(projectRoot, { ...base, status: "error", error: built.reason }); } catch { /* shadow only */ }
    return true;
  }
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  void requestJev({ state: built.state, apiKey, fetchImpl, signal: controller.signal })
    .then((result) => {
      const answer = result?.answers?.fidelity_verdict;
      if (answer?.type !== "choice" || !["APPROVE", "REVISE", "BLOCKED"].includes(answer.choice)) {
        throw new Error("invalid-response");
      }
      appendRecord(projectRoot, {
        ...base,
        at: new Date().toISOString(),
        status: "ok",
        state_sha256: built.sha256,
        model: typeof result.model === "string" ? result.model : null,
        choice: answer.choice,
        probabilities: answer.probabilities ?? null,
        confidence: typeof answer.confidence === "number" ? answer.confidence : null,
        usage: result.usage ?? null,
        latency_ms: Date.now() - started,
      });
    })
    .catch((error) => {
      try {
        appendRecord(projectRoot, {
          ...base,
          at: new Date().toISOString(),
          status: "error",
          state_sha256: built.sha256,
          error: error?.name === "AbortError" ? "timeout" : String(error?.message ?? "request-failed").slice(0, 80),
          latency_ms: Date.now() - started,
        });
      } catch { /* shadow only */ }
    })
    .finally(() => clearTimeout(timeout));
  return true;
}

export function finishJevFidelityShadow({ projectRoot, sessionId, callId, responseText } = {}) {
  if (!isSafeSessionId(sessionId) || typeof callId !== "string" || !callId) return;
  const verdict = parseTestReviewVerdict(responseText)?.verdict ?? null;
  try {
    appendRecord(projectRoot, {
      version: 1,
      type: "native-verdict",
      at: new Date().toISOString(),
      session_id: sessionId,
      call_id: callId,
      verdict,
    });
  } catch { /* shadow only */ }
}

export const testApi = Object.freeze({ redactSecrets, requestJev });
