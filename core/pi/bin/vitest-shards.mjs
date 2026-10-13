#!/usr/bin/env node
/** Run every Vitest shard in separate processes, preserving the npm test verdict. */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function parseShardOptions(argv, env = process.env) {
  const separator = argv.indexOf("--");
  const options = separator < 0 ? argv : argv.slice(0, separator);
  const args = separator < 0 ? [] : argv.slice(separator + 1);
  let shards = env.HARNESS_TEST_SHARDS ?? "2";
  let timeoutSeconds = env.HARNESS_TEST_TIMEOUT_SECONDS ?? "3600";
  for (let i = 0; i < options.length; i += 2) {
    if (options[i] === "--shards") shards = options[i + 1];
    else if (options[i] === "--timeout-seconds") timeoutSeconds = options[i + 1];
    else throw new Error(`Unknown runner option: ${options[i]}`);
  }
  if (!/^\d+$/.test(shards ?? "") || Number(shards) < 1 || Number(shards) > 32) {
    throw new Error("Shards must be an integer from 1 to 32");
  }
  if (!/^\d+$/.test(timeoutSeconds ?? "") || Number(timeoutSeconds) < 1 || Number(timeoutSeconds) > 86400) {
    throw new Error("Timeout must be an integer from 1 to 86400 seconds");
  }
  if (args.some((arg) => /^(?:--shard|--watch|--run|--passWithNoTests)(?:=|$)/.test(arg) || arg === "-w")) {
    throw new Error("The runner owns sharding and run mode; empty suites must fail");
  }
  // Forward focused npm test arguments unchanged to ONE process. Sharding a
  // single selected file would create empty shards and a misleading verdict.
  return { shards: args.length ? 1 : Number(shards), timeoutSeconds: Number(timeoutSeconds), args };
}

export async function runVitestShards({ cwd = process.cwd(), vitest = path.join(cwd, "node_modules/vitest/vitest.mjs"),
  worker = fileURLToPath(new URL("./vitest-shard-worker.mjs", import.meta.url)),
  shards, timeoutSeconds, args = [], stdout = process.stdout, stderr = process.stderr }) {
  if (!Number.isInteger(shards) || shards < 1 || shards > 32 ||
      !Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 86400) {
    throw new Error("Invalid shard count or timeout");
  }
  if (!existsSync(vitest)) throw new Error("Project-local Vitest is missing; install declared dependencies first");
  const groups = new Set();
  const started = Date.now();
  let cancelled = false;
  let escalation;
  const kill = (pid, signal) => {
    try { process.kill(process.platform === "win32" ? pid : -pid, signal); }
    catch (error) { if (error.code !== "ESRCH") stderr.write(`[harness-tests] ${error.message}\n`); }
  };
  const cancel = (reason) => {
    if (cancelled) return;
    cancelled = true;
    stderr.write(`[harness-tests] ${reason}; cancelling all shards\n`);
    for (const pid of groups) kill(pid, "SIGTERM");
    escalation = setTimeout(() => { for (const pid of groups) kill(pid, "SIGKILL"); }, 5000);
  };
  const interrupt = () => cancel("Interrupted");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  const timeout = setTimeout(() => cancel(`Timeout after ${timeoutSeconds}s`), timeoutSeconds * 1000);
  try {
    const results = await Promise.all(Array.from({ length: shards }, (_, i) => new Promise((resolve) => {
      const index = i + 1;
      // A broken storage teardown can poison every later file in one worker.
      // Stop at the first failure instead of spending minutes on its cascade.
      const flags = shards > 1 ? [`--bail=1`, `--shard=${index}/${shards}`] : [];
      stdout.write(`[harness-tests] Starting shard ${index}/${shards}\n`);
      const command = shards > 1 ? [worker, ...args, ...flags] : [vitest, "run", ...args];
      const child = spawn(process.execPath, command, {
        cwd, detached: process.platform !== "win32",
        // Only the sharded API worker sends failure notifications. Opening an
        // unused IPC channel for the native CLI can keep Workers listeners alive
        // after its tests finish, producing a false Vite close timeout.
        stdio: shards > 1 ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
      });
      if (child.pid) groups.add(child.pid);
      child.stdout.pipe(stdout, { end: false });
      child.stderr.pipe(stderr, { end: false });
      child.on("message", (message) => {
        if (message?.type === "harness-vitest-failure") {
          const identity = typeof message.identity === "string" && message.identity ? `: ${message.identity}` : "";
          cancel(`Shard ${index}/${shards} reported a failed test${identity}`);
        }
      });
      child.once("error", (error) => {
        stderr.write(`[harness-tests] Shard ${index}/${shards}: ${error.message}\n`);
        cancel("Shard failed to start");
      });
      child.once("close", (code, signal) => {
        if (child.pid) {
          // Vitest may exit while a workerd descendant is still alive. Clean
          // the process group even when its leader has already exited.
          kill(child.pid, "SIGKILL");
          groups.delete(child.pid);
        }
        stdout.write(`[harness-tests] Shard ${index}/${shards} finished: ${signal ?? code}\n`);
        if (code !== 0 || signal) cancel(`Shard ${index}/${shards} failed`);
        // Vitest can return zero during graceful cancellation even after an
        // error. Cancellation never counts as a successful shard.
        resolve(!cancelled && code === 0 && !signal);
      });
    })));
    const passed = !cancelled && results.every(Boolean);
    stdout.write(`[harness-tests] ${passed ? "PASS" : "FAIL"}: ${results.filter(Boolean).length}/${shards} shards passed in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
    return passed ? 0 : 1;
  } finally {
    clearTimeout(timeout);
    clearTimeout(escalation);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    for (const pid of groups) kill(pid, "SIGKILL");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await runVitestShards(parseShardOptions(process.argv.slice(2))); }
  catch (error) { console.error(`[harness-tests] ${error.message}`); process.exitCode = 1; }
}
