/** One local admission queue for Verboo HTTP attempts. No prompts or keys cross this socket. */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { readProviderControlConfig } from "./provider-control-config.mjs";

export const CONTROL_SOCKET_ENV = "PI_HARNESS_VERBOO_CONTROL_SOCKET";

export function createAdmissionServer({ maxConcurrent = 2, requestsPerWindow = 38, windowMs = 60000, maxQueued = 128, idleMs = 300000 } = {}) {
  const active = new Set();
  const queued = [];
  let starts = [], wake, idle;
  const server = net.createServer((socket) => {
    clearTimeout(idle);
    if (queued.length >= maxQueued) { socket.end('{"error":"queue_full"}\n'); return; }
    queued.push(socket);
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      active.delete(socket);
      const index = queued.indexOf(socket);
      if (index >= 0) queued.splice(index, 1);
      drain();
    });
    drain();
  });
  function drain() {
    clearTimeout(wake);
    starts = starts.filter((at) => at > Date.now() - windowMs);
    while (queued.length && active.size < maxConcurrent && starts.length < requestsPerWindow) {
      const socket = queued.shift();
      if (socket.destroyed) continue;
      active.add(socket);
      starts.push(Date.now());
      socket.write('{"ok":true}\n');
    }
    if (queued.length && starts.length >= requestsPerWindow) wake = setTimeout(drain, Math.max(1, starts[0] + windowMs - Date.now()));
    if (!queued.length && !active.size && idleMs) {
      clearTimeout(idle);
      idle = setTimeout(() => server.close(), Math.max(idleMs, windowMs));
      idle.unref();
    }
  }
  server.on("close", () => { clearTimeout(wake); clearTimeout(idle); });
  server.closeAdmissions = () => {
    clearTimeout(wake); clearTimeout(idle);
    for (const socket of [...active, ...queued]) socket.destroy();
    server.close();
  };
  return server;
}

export function startCoordinator(socketPath, { maxConcurrent = readProviderControlConfig().maxConcurrent } = {}) {
  const directory = path.dirname(socketPath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) throw new Error("Unsafe Verboo control directory");
  fs.chmodSync(directory, 0o700);
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--serve", socketPath, String(maxConcurrent)], {
    detached: true, stdio: "ignore", env: {},
  });
  child.on("error", () => {});
  child.unref();
  return child;
}

function controlError(message) { return new Error(`503 local Verboo admission unavailable: ${message}`); }

/** The connection is the lease: cancellation or process death automatically releases a slot. */
export async function acquireAdmission(socketPath, { signal, waitMs = 900000, start = startCoordinator } = {}) {
  const deadline = Date.now() + Math.min(waitMs, 10000);
  for (;;) {
    signal?.throwIfAborted();
    try { return await connectAdmission(socketPath, { signal, waitMs }); }
    catch (error) {
      if (!["ENOENT", "ECONNREFUSED"].includes(error.code) || Date.now() >= deadline) throw error;
      if (error.code === "ECONNREFUSED") {
        // SIGKILL can leave the pathname behind. Never remove a newly starting listener.
        try {
          const before = fs.lstatSync(socketPath);
          const current = fs.lstatSync(socketPath);
          if (before.isSocket() && before.ino === current.ino && Date.now() - current.mtimeMs > 5000) fs.unlinkSync(socketPath);
        } catch (problem) { if (problem.code !== "ENOENT") throw problem; }
      }
      start(socketPath);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

function connectAdmission(socketPath, { signal, waitMs }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const controller = new AbortController();
    let acquired = false, released = false, buffer = "";
    const timer = setTimeout(() => fail(controlError("queue wait expired")), waitMs);
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); };
    const release = () => { if (!released) { released = true; cleanup(); socket.destroy(); } };
    const fail = (error) => { controller.abort(error); release(); if (!acquired) reject(error); };
    const onAbort = () => fail(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    socket.on("error", fail);
    socket.on("close", () => { if (!released) fail(controlError("coordinator disconnected")); });
    socket.on("data", (chunk) => {
      if (acquired) return;
      buffer += chunk.toString("utf8");
      if (buffer.length > 1024) { fail(controlError("invalid admission response")); return; }
      if (!buffer.includes("\n")) return;
      try {
        if (JSON.parse(buffer).ok !== true) throw controlError("queue capacity exceeded");
        acquired = true;
        clearTimeout(timer);
        resolve({ release, signal: controller.signal });
      } catch (error) { fail(error); }
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === "--serve") {
  const socketPath = process.argv[3];
  process.umask(0o077);
  const maxConcurrent = Number(process.argv[4] ?? 2);
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 6) process.exit(2);
  const server = createAdmissionServer({ maxConcurrent });
  server.on("error", () => process.exit(1));
  server.listen(socketPath);
}
