#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { CANONICAL_ROLES } from "../lib/roles.mjs";

const PACKAGE_ROOT = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const resolveFromHarness = (specifier) => fileURLToPath(import.meta.resolve(specifier));

/**
 * Extensões carregadas ANTES do pi-subagents. `harness-policy` vem primeiro de propósito: hooks
 * `tool_call` rodam na ordem de carga e o primeiro `block` vence, então o deny de segredo/comando
 * destrutivo julga antes de qualquer rail de pipeline. `harness-bootstrap` é só a fronteira
 * ordenada imediatamente antes do pi-subagents.
 */
const EXTENSIONS_BEFORE_SUBAGENTS = [
  "core/pi/extensions/harness-policy.ts",
  "core/pi/extensions/harness-bootstrap.ts",
];

/**
 * Extensões carregadas DEPOIS do pi-subagents (que registra a tool `subagent`): todo rail que
 * julga um dispatch precisa da tool já existente. Ordem = ordem de julgamento:
 * dispatch (contrato de papel) → entry-gate (estado do pipeline) → plan-gate (plano estável) →
 * plan-write-gate (anti-forja + escopo de escrita) → marker/classify (tools de estado) →
 * lavish/run-hand → observabilidade e UI, que nunca bloqueiam. `harness-plan-tracker` fica por
 * último: é só UI.
 */
const EXTENSIONS_AFTER_SUBAGENTS = [
  "core/pi/extensions/harness-dispatch.ts",
  "core/pi/extensions/harness-entry-gate.ts",
  "core/pi/extensions/harness-plan-gate.ts",
  "core/pi/extensions/harness-plan-write-gate.ts",
  "core/pi/extensions/harness-marker.ts",
  "core/pi/extensions/harness-classify.ts",
  "core/pi/extensions/harness-lavish-gate.ts",
  "core/pi/extensions/harness-run-hand.ts",
  "core/pi/extensions/harness-obs.ts",
  "core/pi/extensions/harness-idle-nudge.ts",
  "core/pi/extensions/harness-reinject-state.ts",
  "core/pi/extensions/harness-version-check.ts",
  "core/pi/extensions/harness-context-files.ts",
  "core/pi/extensions/harness-plan-tracker.ts",
];

/** Libs host-agnósticas que as extensões acima importam; ausência de qualquer uma deixa um gate mudo. */
const REQUIRED_LIBS = [
  "core/pi/lib/classify.mjs",
  "core/pi/lib/context-files.mjs",
  "core/pi/lib/dispatch-rail.mjs",
  "core/pi/lib/entry-gate.mjs",
  "core/pi/lib/marker-authority.mjs",
  "core/pi/lib/obs.mjs",
  "core/pi/lib/pi-adapter-map.mjs",
  "core/pi/lib/pi-child-identity.mjs",
  "core/pi/lib/pi-gate-state.mjs",
  "core/pi/lib/pi-paths.mjs",
  "core/pi/lib/pi-result-text.mjs",
  "core/pi/lib/pi-state-records.mjs",
  "core/pi/lib/plan-gate.mjs",
  "core/pi/lib/plan-tracker.mjs",
  "core/pi/lib/plan-write-decide.mjs",
  "core/pi/lib/policy.mjs",
  "core/pi/lib/roles.mjs",
  "core/pi/lib/run-hand.mjs",
  "core/pi/lib/session-state.mjs",
  "core/pi/lib/version-check.mjs",
];

/** Defaults imutáveis do pacote materializados no data dir do Pi na primeira execução. */
const RUNTIME_DEFAULTS = ["agents", "models-store.json", "settings.json", "subagents.json"];

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
 * @description Diretório de estado do harness na worktree corrente (`<cwd>/.pi/harness/state`),
 * irmão do data dir do Pi. É a raiz de gate-state, dispatch/hand-records e locks da lane.
 * @param {string} runtimeDir
 * @returns {string}
 */
export function harnessStateDir(runtimeDir) {
  return join(dirname(runtimeDir), "state");
}

/**
 * @param {{root: string, argv: string[], env: NodeJS.ProcessEnv, runtimePrompt?: string, dependencyPaths?: ReturnType<typeof resolvePiDependencyPaths>}} options
 */
export function buildPiHarnessInvocation({ root, argv, env, runtimePrompt = "", dependencyPaths = resolvePiDependencyPaths(root) }) {
  const runtimeDir = resolve(process.cwd(), ".pi/harness/runtime");
  const extensionArgs = [
    ...EXTENSIONS_BEFORE_SUBAGENTS.flatMap((rel) => ["-e", join(root, rel)]),
    "-e",
    dependencyPaths.subagentsExtension,
    ...EXTENSIONS_AFTER_SUBAGENTS.flatMap((rel) => ["-e", join(root, rel)]),
  ];
  return {
    command: process.execPath,
    args: [
      dependencyPaths.piCli,
      "--no-extensions",
      "--no-skills",
      "--no-context-files",
      ...extensionArgs,
      "--skill",
      join(root, "core/codex/skills"),
      "--append-system-prompt",
      runtimePrompt,
      ...argv,
    ],
    env: { ...env, PI_CODING_AGENT_DIR: runtimeDir },
  };
}

/**
 * Materializes immutable package defaults in the project's ignored Pi runtime and creates the
 * harness state root, so the first gate never fails for a missing directory.
 * @param {string} root
 * @param {string} runtimeDir
 * @param {string} [stateDir]
 */
export function materializeRuntime(root, runtimeDir, stateDir = harnessStateDir(runtimeDir)) {
  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  for (const name of RUNTIME_DEFAULTS) {
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
    ...EXTENSIONS_BEFORE_SUBAGENTS.map((rel) => join(root, rel)),
    ...EXTENSIONS_AFTER_SUBAGENTS.map((rel) => join(root, rel)),
    ...REQUIRED_LIBS.map((rel) => join(root, rel)),
    join(root, "core/codex/skills"),
    join(root, "core/pi/prompts/harness-runtime.md"),
    join(root, "core/pi/runtime/subagents.json"),
    join(root, "core/pi/runtime/models-store.json"),
    join(root, "core/pi/runtime/settings.json"),
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
