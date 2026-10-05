#!/usr/bin/env node
/** Run the installed Vitest directly; npm script chains cannot swallow the file filter. */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

export function verificationInvocation(argv, cwd = process.cwd()) {
  const [lane, ...files] = argv;
  if (!["--pool", "--node"].includes(lane) || !files.length) throw new Error("Usage: node .pi/harness/bin/pi-verify.mjs --pool|--node test/path.test.ts [...]");
  const root = fs.realpathSync(cwd);
  for (const file of files) {
    if (!/^test\/[A-Za-z0-9_./-]+\.test\.[cm]?[jt]s$/.test(file) || file.split("/").includes("..")) throw new Error("Verification requires literal project test paths");
    const target = fs.realpathSync(path.join(root, file));
    if (!target.startsWith(root + path.sep) || !fs.statSync(target).isFile()) throw new Error("Test must be a regular file inside the project");
    if (lane === "--node" && !file.startsWith("test/node/")) throw new Error("Node lane requires test/node paths");
    if (lane === "--pool" && file.startsWith("test/node/")) throw new Error("Pool lane excludes test/node paths");
  }
  const runner = path.join(root, "node_modules/vitest/vitest.mjs");
  if (!fs.existsSync(runner)) throw new Error("Installed Vitest is missing; install project dependencies first");
  const args = [runner, "run"];
  if (lane === "--node") {
    if (!fs.existsSync(path.join(root, "vitest.config.node.ts"))) throw new Error("Node lane requires vitest.config.node.ts");
    args.push("--config", "vitest.config.node.ts");
  }
  return { command: process.execPath, args: [...args, ...files], cwd: root };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const invocation = verificationInvocation(process.argv.slice(2));
    const child = spawn(invocation.command, invocation.args, { cwd: invocation.cwd, stdio: "inherit" });
    for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
    child.on("error", () => { console.error("Installed Vitest could not start"); process.exitCode = 1; });
    child.on("exit", (code, signal) => { process.exitCode = code ?? (signal === "SIGINT" ? 130 : 143); });
  } catch (error) { console.error(error.message); process.exitCode = 2; }
}
