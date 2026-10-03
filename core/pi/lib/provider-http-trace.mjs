/** Opt-in HTTP metadata tracing. Never records bodies or authorization headers. */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { acquireAdmission, CONTROL_SOCKET_ENV } from "./provider-request-control.mjs";

export const TRACE_DIR_ENV = "PI_HARNESS_HTTP_TRACE_DIR";
const TRACE_SESSION_ENV = "PI_HARNESS_HTTP_TRACE_LAUNCHER_SESSION";
const INSTALLED = Symbol.for("pi.harness.verboo.http.trace");

export function providerTraceEnvironment(env, { userHome = homedir(), sessionId, providerId, modulePath = fileURLToPath(import.meta.url) } = {}) {
  let directory = env[TRACE_DIR_ENV];
  let controlSocket = env[CONTROL_SOCKET_ENV];
  if (!directory) {
    try {
      const config = JSON.parse(fs.readFileSync(path.join(userHome, ".config", "claude-harness", "provider-tracing.json"), "utf8"));
      directory = config.verboo?.directory;
    } catch { /* Metadata tracing is optional; admission has its own provider default. */ }
  }
  if (typeof directory !== "string" || !path.isAbsolute(directory)) directory = undefined;
  if (!controlSocket) {
    let enabled = providerId === "verboo";
    try {
      const config = JSON.parse(fs.readFileSync(path.join(userHome, ".config", "claude-harness", "provider-request-control.json"), "utf8"));
      if (typeof config.verboo === "boolean") enabled = config.verboo;
    } catch { /* Verboo launchers use safe admission by default. */ }
    if (enabled) controlSocket = path.join(userHome, ".cache", "claude-harness", "provider-control", "verboo.sock");
  }
  if (typeof controlSocket !== "string" || !path.isAbsolute(controlSocket)) controlSocket = undefined;
  if (!directory && !controlSocket) return env;
  const preload = `--import=${JSON.stringify(modulePath)}`;
  return {
    ...env,
    ...(directory ? { [TRACE_DIR_ENV]: directory } : {}),
    ...(controlSocket ? { [CONTROL_SOCKET_ENV]: controlSocket } : {}),
    [TRACE_SESSION_ENV]: sessionId,
    NODE_OPTIONS: env.NODE_OPTIONS?.includes(modulePath) ? env.NODE_OPTIONS : `${env.NODE_OPTIONS ?? ""} ${preload}`.trim(),
  };
}

export function installProviderHttpTrace({ target = globalThis, directory, sessionId, append, controlSocket, acquire = acquireAdmission, trackFetchReplacement = false } = {}) {
  if (!directory && !append && !controlSocket) return false;
  if (target[INSTALLED]) return false;
  let original = target.fetch;
  if (typeof original !== "function") return false;
  const record = (data) => {
    if (!append && !directory) return;
    try {
      if (append) append(data);
      else {
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        fs.appendFileSync(path.join(directory, `${process.pid}.jsonl`), `${JSON.stringify(data)}\n`, { mode: 0o600 });
      }
    } catch { /* Observability must not interrupt inference. */ }
  };
  target[INSTALLED] = true;
  const tracedFetch = async function (input, options) {
    let url;
    try { url = new URL(typeof input === "string" || input instanceof URL ? input : input.url); }
    catch { return original.call(target, input, options); }
    if (url.origin !== "https://code.verboo.ai" || url.pathname !== "/router/v1/chat/completions") {
      return original.call(target, input, options);
    }
    const id = randomUUID();
    const started = performance.now();
    const common = { request_id: id, pid: process.pid, cwd: process.cwd(), launcher_session_id: sessionId };
    const emit = (event, details = {}) => record({ ...common, event, at: new Date().toISOString(), elapsed_ms: performance.now() - started, ...details });
    let lease;
    try {
      if (controlSocket) {
        emit("queue_enter");
        lease = await acquire(controlSocket, { signal: options?.signal ?? input?.signal });
        emit("queue_admitted");
      }
      // Start HTTP timing after local admission; local wait has its own event.
      const responseStart = performance.now();
      emit("request");
      let response = await original.call(target, input, lease ? { ...options, signal: lease.signal } : options);
      const headers = {};
      for (const name of ["retry-after", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset", "x-request-id"]) {
        const value = response.headers.get(name);
        if (value !== null) headers[name] = value;
      }
      emit("headers", { status: response.status, headers, http_elapsed_ms: performance.now() - responseStart });
      if (lease) {
        if (!response.ok || !response.body) lease.release();
        else response = admissionResponse(response, lease);
      }
      if (!response.ok || !response.body || !response.headers.get("content-type")?.includes("text/event-stream")) return response;
      let first = true;
      let ended = false;
      let buffer = "";
      const decoder = new TextDecoder();
      const finish = (endType) => { if (!ended) { ended = true; emit("stream_end", { end_type: endType }); } };
      const body = response.body.pipeThrough(new TransformStream({
        transform(chunk, controller) {
          if (first) { first = false; emit("first_byte"); }
          buffer += decoder.decode(chunk, { stream: true });
          let index;
          while ((index = buffer.indexOf("\n")) >= 0) {
            if (buffer.slice(0, index).trim() === "data: [DONE]") finish("done");
            buffer = buffer.slice(index + 1);
          }
          // No payload retention: even malformed streams have a bounded scratch buffer.
          if (buffer.length > 65536) buffer = "";
          controller.enqueue(chunk);
        },
        flush: () => finish("eof"),
      }));
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) {
      lease?.release();
      emit("request_error", { error_type: error?.name ?? "Error" });
      throw error;
    }
  };
  if (trackFetchReplacement) {
    const descriptor = Object.getOwnPropertyDescriptor(target, "fetch");
    // Pi 0.99 installs npm Undici after preloads. Keep its chosen transport,
    // while retaining the metadata wrapper around subsequent assignments.
    Object.defineProperty(target, "fetch", {
      configurable: true,
      enumerable: descriptor?.enumerable ?? true,
      get: () => tracedFetch,
      set: (replacement) => { if (replacement !== tracedFetch) original = replacement; },
    });
  } else target.fetch = tracedFetch;
  return true;
}

/** Preserve streaming/backpressure and release the lease on EOF, read failure or cancel. */
function admissionResponse(response, lease) {
  const reader = response.body.getReader();
  reader.closed.then(lease.release, lease.release);
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) { lease.release(); controller.close(); }
        else controller.enqueue(value);
      } catch (error) { lease.release(); controller.error(error); }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); } finally { lease.release(); }
    },
  }, { highWaterMark: 0 });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

if (process.env[TRACE_DIR_ENV] || process.env[CONTROL_SOCKET_ENV]) installProviderHttpTrace({ directory: process.env[TRACE_DIR_ENV], controlSocket: process.env[CONTROL_SOCKET_ENV], sessionId: process.env[TRACE_SESSION_ENV], trackFetchReplacement: true });
