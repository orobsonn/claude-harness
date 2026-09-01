#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { CANONICAL_ROLES } from "../lib/roles.mjs";

const PACKAGE_ROOT = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const resolveFromHarness = (specifier) => fileURLToPath(import.meta.resolve(specifier));

function isDirectCli(scriptPath) {
  if (!scriptPath) return false;
  try {
    return realpathSync(scriptPath) === SCRIPT_PATH;
  } catch {
    return scriptPath === SCRIPT_PATH;
  }
}

function packageRootFromEntry(packageName, entryPath) {
  let candidate = dirname(entryPath);
  while (candidate !== dirname(candidate)) {
    const manifest = join(candidate, "package.json");
    if (existsSync(manifest)) {
      const parsed = JSON.parse(readFileSync(manifest, "utf8"));
      if (parsed.name === packageName) return candidate;
    }
    candidate = dirname(candidate);
  }
  throw new Error(`package root not found for ${packageName}`);
}

/**
 * Resolves Pi's pinned packages from the harness package when it was normally installed, or from
 * npx's hoisted package set when the harness was installed directly from a Git ref.
 * @param {string} root
 * @param {(specifier: string) => string} [resolveModule]
 * @param {(packageName: string, entryPath: string) => string} [resolvePackageRoot]
 */
export function resolvePiDependencyPaths(root, resolveModule = resolveFromHarness, resolvePackageRoot = packageRootFromEntry) {
  const dependencyPath = (packageName, path) => {
    const nested = join(root, "node_modules", packageName, path);
    if (existsSync(nested)) return nested;
    return join(resolvePackageRoot(packageName, resolveModule(packageName)), path);
  };
  return {
    piCli: dependencyPath("@earendil-works/pi-coding-agent", "dist/bundle/cli.js"),
    piPackage: dependencyPath("@earendil-works/pi-coding-agent", "package.json"),
    subagentsExtension: dependencyPath("@gotgenes/pi-subagents", "src/index.ts"),
    subagentsPackage: dependencyPath("@gotgenes/pi-subagents", "package.json"),
  };
}

/**
 * @param {{root: string, argv: string[], env: NodeJS.ProcessEnv, runtimePrompt?: string, dependencyPaths?: ReturnType<typeof resolvePiDependencyPaths>}} options
 */
export function buildPiHarnessInvocation({ root, argv, env, runtimePrompt = "", dependencyPaths = resolvePiDependencyPaths(root) }) {
  const runtimeDir = resolve(process.cwd(), ".pi/harness/runtime");
  return {
    command: process.execPath,
    args: [
      dependencyPaths.piCli,
      "--no-extensions",
      "--no-skills",
      "--no-context-files",
      "-e",
      join(root, "core/pi/extensions/harness-bootstrap.ts"),
      "-e",
      dependencyPaths.subagentsExtension,
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
  let dependencies;
  try {
    dependencies = resolvePiDependencyPaths(root);
  } catch (error) {
    return { ok: false, reason: `missing-dependency:${error instanceof Error ? error.message : String(error)}` };
  }
  const requiredPaths = [
    dependencies.piCli,
    dependencies.piPackage,
    dependencies.subagentsPackage,
    dependencies.subagentsExtension,
    join(root, "core/pi/extensions/harness-dispatch.ts"),
    join(root, "core/pi/extensions/harness-plan-tracker.ts"),
    join(root, "core/codex/skills"),
    join(root, "core/pi/prompts/harness-runtime.md"),
    join(root, "core/pi/runtime/subagents.json"),
    ...CANONICAL_ROLES.map((role) => join(root, "core/pi/runtime/agents", `${role}.md`)),
  ];
  const missing = requiredPaths.find((path) => !existsSync(path));
  if (missing) return { ok: false, reason: `missing:${missing}` };
  const runtime = JSON.parse(readFileSync(dependencies.piPackage, "utf8"));
  const subagents = JSON.parse(readFileSync(dependencies.subagentsPackage, "utf8"));
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

if (isDirectCli(process.argv[1])) main();
