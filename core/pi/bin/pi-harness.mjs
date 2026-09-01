#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

import { CANONICAL_ROLES } from "../lib/roles.mjs";

const PACKAGE_ROOT = resolve(fileURLToPath(new URL("../../../", import.meta.url)));

/**
 * @param {{root: string, argv: string[], env: NodeJS.ProcessEnv, runtimePrompt?: string}} options
 */
export function buildPiHarnessInvocation({ root, argv, env, runtimePrompt = "" }) {
  const runtimeDir = resolve(process.cwd(), ".pi/harness/runtime");
  return {
    command: process.execPath,
    args: [
      join(root, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"),
      "--no-extensions",
      "--no-skills",
      "--no-context-files",
      "-e",
      join(root, "core/pi/extensions/harness-bootstrap.ts"),
      "-e",
      join(root, "node_modules/@gotgenes/pi-subagents/src/index.ts"),
      "-e",
      join(root, "core/pi/extensions/harness-dispatch.ts"),
      "-e",
      join(root, "core/pi/extensions/harness-plan-tracker.ts"),
      "--skill",
      join(root, "core/codex/skills"),
      "--append-system-prompt",
      runtimePrompt,
      ...argv,
    ],
    env: { ...env, PI_CODING_AGENT_DIR: runtimeDir },
  };
}

/** Materializes immutable package defaults in the project's ignored Pi runtime. */
export function materializeRuntime(root, runtimeDir) {
  mkdirSync(runtimeDir, { recursive: true });
  for (const name of ["agents", "models-store.json", "subagents.json"]) {
    const source = join(root, "core/pi/runtime", name);
    const target = join(runtimeDir, name);
    if (!existsSync(target)) cpSync(source, target, { recursive: true });
  }
}

/** @param {string} root */
export function verifyPiHarness(root) {
  const runtimePackage = join(root, "node_modules/@earendil-works/pi-coding-agent/package.json");
  const subagentsPackage = join(root, "node_modules/@gotgenes/pi-subagents/package.json");
  const requiredPaths = [
    runtimePackage,
    subagentsPackage,
    join(root, "node_modules/@gotgenes/pi-subagents/src/index.ts"),
    join(root, "core/pi/extensions/harness-dispatch.ts"),
    join(root, "core/pi/extensions/harness-plan-tracker.ts"),
    join(root, "core/codex/skills"),
    join(root, "core/pi/prompts/harness-runtime.md"),
    join(root, "core/pi/runtime/subagents.json"),
    ...CANONICAL_ROLES.map((role) => join(root, "core/pi/runtime/agents", `${role}.md`)),
  ];
  const missing = requiredPaths.find((path) => !existsSync(path));
  if (missing) return { ok: false, reason: `missing:${missing}` };
  const runtime = JSON.parse(readFileSync(runtimePackage, "utf8"));
  const subagents = JSON.parse(readFileSync(subagentsPackage, "utf8"));
  if (runtime.version !== "0.84.4") return { ok: false, reason: `runtime-version:${runtime.version}` };
  if (subagents.version !== "21.2.0") return { ok: false, reason: `subagents-version:${subagents.version}` };
  return { ok: true, runtimeVersion: runtime.version, subagentsVersion: subagents.version, roles: CANONICAL_ROLES.length };
}

function main() {
  if (process.argv.slice(2).length === 1 && process.argv[2] === "--verify") {
    const result = verifyPiHarness(PACKAGE_ROOT);
    console.log(JSON.stringify(result));
    process.exitCode = result.ok ? 0 : 1;
    return;
  }
  const runtimePrompt = readFileSync(join(PACKAGE_ROOT, "core/pi/prompts/harness-runtime.md"), "utf8").trim();
  const invocation = buildPiHarnessInvocation({ root: PACKAGE_ROOT, argv: process.argv.slice(2), env: process.env, runtimePrompt });
  materializeRuntime(PACKAGE_ROOT, invocation.env.PI_CODING_AGENT_DIR);
  const result = spawnSync(invocation.command, invocation.args, { env: invocation.env, stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
