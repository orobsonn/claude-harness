#!/usr/bin/env node
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

import { CANONICAL_ROLES, RUNTIME_ROLES } from "../lib/roles.mjs";
import { PI_AUTH_PATH_ENV, PI_RESUME_ENV, verifyPiAuthPathPatch } from "../lib/pi-auth-path-patch.mjs";
import { resolveVerifiedPiRuntime } from "../lib/pi-runtime-cache.mjs";
import { mergePiChildResourceSettings, piChildResourceSettings } from "../lib/pi-child-extensions.mjs";
import { materializePiReviewConfig } from "../lib/pi-review-config.mjs";
import { acquirePiParentWorktreeLock, recoverPiParentSession } from "../lib/parent-session-recovery.mjs";
import { admitTaskRun, inspectTaskAdmission, rollbackTaskAdmission, taskRunPrompt, TASK_RUN_ENV } from "../lib/task-run.mjs";

const PACKAGE_ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SUBAGENTS_BRIDGE = "extensions/harness-subagents.ts";

/**
 * Extensões carregadas ANTES do pi-subagents. `harness-policy` vem primeiro de propósito: hooks
 * `tool_call` rodam na ordem de carga e o primeiro `block` vence, então o deny de segredo/comando
 * destrutivo julga antes de qualquer rail de pipeline. `harness-bootstrap` é só a fronteira
 * ordenada imediatamente antes do pi-subagents.
 */
const EXTENSIONS_BEFORE_SUBAGENTS = [
  "extensions/harness-policy.ts",
  "extensions/harness-task-run.ts",
  "extensions/harness-bootstrap.ts",
];

/**
 * Extensões carregadas DEPOIS do pi-subagents (que registra a tool `subagent`): todo rail que
 * julga um dispatch precisa da tool já existente. Ordem = ordem de julgamento:
 * dispatch (contrato de papel) → entry-gate (estado do pipeline) → plan-gate (plano estável) →
 * plan-write-gate (anti-forja + escopo de escrita) → marker/classify (tools de estado) →
 * lavish → observabilidade e UI, que nunca bloqueiam. `harness-plan-tracker` fica por
 * último: é só UI.
 */
const EXTENSIONS_AFTER_SUBAGENTS = [
  "extensions/harness-dispatch.ts",
  "extensions/harness-memory.ts",
  "extensions/harness-tasks.ts",
  "extensions/harness-entry-gate.ts",
  "extensions/harness-reviews.ts",
  "extensions/harness-plan-gate.ts",
  "extensions/harness-plan-write-gate.ts",
  "extensions/harness-marker.ts",
  "extensions/harness-classify.ts",
  "extensions/harness-spec.ts",
  "extensions/harness-lavish-gate.ts",
  "extensions/harness-obs.ts",
  "extensions/harness-idle-nudge.ts",
  "extensions/harness-reinject-state.ts",
  "extensions/harness-version-check.ts",
  "extensions/harness-context-files.ts",
  "extensions/harness-plan-tracker.ts",
];

/** Libs host-agnósticas que as extensões acima importam; ausência de qualquer uma deixa um gate mudo. */
const REQUIRED_LIBS = [
  "lib/classify.mjs",
  "lib/task-contract.mjs",
  "lib/task-context.mjs",
  "lib/task-coordinator.mjs",
  "lib/task-orca.mjs",
  "lib/task-process.mjs",
  "lib/task-receipts.mjs",
  "lib/task-runtime-assets.mjs",
  "lib/task-run.mjs",
  "lib/ceremony-mode.mjs",
  "lib/context-files.mjs",
  "lib/dispatch-rail.mjs",
  "lib/entry-gate.mjs",
  "lib/marker-authority.mjs",
  "lib/memory-cycle.mjs",
  "lib/native-bootstrap.mjs",
  "lib/obs.mjs",
  "lib/parent-session-recovery.mjs",
  "lib/pi-adapter-map.mjs",
  "lib/pi-auth-path-patch.mjs",
  "lib/pi-child-identity.mjs",
  "lib/pi-child-extensions.mjs",
  "lib/pi-gate-state.mjs",
  "lib/pi-paths.mjs",
  "lib/pi-review-config.mjs",
  "lib/pi-review-concurrency.mjs",
  "lib/pi-review-evidence.mjs",
  "lib/pi-result-text.mjs",
  "lib/pi-runtime-cache.mjs",
  "lib/pi-state-records.mjs",
  "lib/plan-gate.mjs",
  "lib/plan-tracker.mjs",
  "lib/plan-write-decide.mjs",
  "lib/policy.mjs",
  "lib/roles.mjs",
  "lib/release-only.mjs",
  "lib/session-state.mjs",
  "lib/spec-approval.mjs",
  "lib/version-check.mjs",
];

/** Defaults imutáveis do pacote materializados no data dir do Pi na primeira execução. */
const RUNTIME_DEFAULTS = ["agents", "models-store.json", "settings.json", "subagents.json"];

// Formato anterior do harness, antes de o Pi exigir provider e id separados. Só estes
// defaults emitidos pelo harness podem ser migrados sem substituir uma escolha do operador.
const LEGACY_HARNESS_DEFAULT_MODELS = new Set([
  "openai-codex/gpt-5.6-terra",
  "openai-codex/gpt-5.6-sol",
]);

const PI_SESSION_CONTROL_FLAGS = Object.freeze([
  "--continue",
  "-c",
  "--resume",
  "-r",
  "--session",
  "--session-id",
  "--fork",
  "--no-session",
]);

const PI_SESSIONLESS_FLAGS = Object.freeze(["--help", "-h", "--version", "-v", "--list-models", "--export"]);
const PI_ADMIN_COMMANDS = new Set(["install", "remove", "uninstall", "update", "list", "config", "auth"]);
const HARNESS_RESUME_FLAG = "--harness-resume";

/**
 * @description Every autonomous ceremony needs a fresh root session. Pi may otherwise recover
 * the last session in the same local store, which would mix a prior gate-state into a new run.
 * An explicit Pi session selection always wins; informational/admin commands do not create one.
 * @param {unknown} argv
 * @returns {boolean}
 */
export function shouldCreateFreshPiSession(argv) {
  const args = Array.isArray(argv) ? argv.filter((entry) => typeof entry === "string") : [];
  if (PI_ADMIN_COMMANDS.has(args[0])) return false;
  for (const entry of args) {
    // After `--`, every token is prompt content; `--continue` in a user's request must not
    // silently resurrect a ceremony.
    if (entry === "--") break;
    if (PI_SESSION_CONTROL_FLAGS.includes(entry) || PI_SESSIONLESS_FLAGS.includes(entry)) {
      return false;
    }
  }
  return true;
}

/**
 * Parseia a retomada do harness sem deixar o host escolher uma sessão aproximada.
 * Seletores nativos de sessão não entram no caminho operacional do launcher; a retomada
 * passa exclusivamente pelo preflight exato e pelo lock do pai.
 */
export function parseHarnessResume(argv) {
  const args = Array.isArray(argv) ? [...argv] : [];
  const marker = args.indexOf("--");
  const end = marker === -1 ? args.length : marker;
  const operationalArgs = args.slice(0, end);
  const indexes = [];
  for (let i = 0; i < end; i++) if (args[i] === HARNESS_RESUME_FLAG) indexes.push(i);
  const informational = PI_ADMIN_COMMANDS.has(operationalArgs[0]) || operationalArgs.some((entry) =>
    PI_SESSIONLESS_FLAGS.includes(entry) || entry.startsWith("--export="));
  const sessionSelector = operationalArgs.find((entry) => {
    const value = String(entry);
    return [...PI_SESSION_CONTROL_FLAGS, "--session-dir"].some((flag) =>
      value === flag || (flag.startsWith("--") && value.startsWith(`${flag}=`)));
  });
  const selectorReason = "Pi session controls are disabled by the harness; use --harness-resume <exact-session-id>";
  if (indexes.length === 0) {
    if (!informational && sessionSelector) return { ok: false, reason: selectorReason };
    return { ok: true, resumeSessionId: null, argv: args };
  }
  if (indexes.length !== 1 || indexes[0] + 1 >= end || !args[indexes[0] + 1] || String(args[indexes[0] + 1]).startsWith("-")) {
    return { ok: false, reason: "--harness-resume requires one exact session id" };
  }
  const at = indexes[0];
  const sessionId = args[at + 1];
  const remaining = [...args.slice(0, at), ...args.slice(at + 2)];
  const remainingEnd = remaining.indexOf("--") === -1 ? remaining.length : remaining.indexOf("--");
  if (informational || remaining.slice(0, remainingEnd).some((entry) => {
    const value = String(entry);
    return [...PI_SESSION_CONTROL_FLAGS, "--session-dir"].some((flag) =>
      value === flag || (flag.startsWith("--") && value.startsWith(`${flag}=`)));
  })) {
    return { ok: false, reason: selectorReason };
  }
  return { ok: true, resumeSessionId: sessionId, argv: remaining };
}

function isDirectCli(scriptPath) {
  if (!scriptPath) return false;
  try {
    return realpathSync(scriptPath) === SCRIPT_PATH;
  } catch {
    return scriptPath === SCRIPT_PATH;
  }
}

/**
 * Resolve only the lifecycle-provisioned user/host runtime, without modifying it.
 * Project packages, npx hoisting and the operator's global Pi are not fallback sources.
 * The root argument is retained for callers that also use it for harness assets.
 */
export function resolvePiDependencyPaths(_root, cacheOptions = {}) {
  const runtime = resolveVerifiedPiRuntime(cacheOptions);
  if (!runtime.ok) throw new Error(`${runtime.reason}. Run harness init/update with target pi or all on this host to prepare the runtime.`);
  return runtime.paths;
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

/** Resolve only Orca's own managed Pi status extension for an Orca terminal. */
export function resolveOrcaStatusExtension(env) {
  if (!env?.ORCA_WORKTREE_ID || !env?.ORCA_PI_SOURCE_AGENT_DIR) return null;
  try {
    const source = realpathSync(env.ORCA_PI_SOURCE_AGENT_DIR);
    const candidate = join(source, "extensions", "orca-agent-status.ts");
    const resolved = realpathSync(candidate);
    const rel = relative(source, resolved);
    if (!rel || rel.startsWith("..") || resolve(source, rel) !== resolved)
      return null;
    if (lstatSync(candidate).isSymbolicLink()) return null;
    if (readFileSync(resolved, "utf8").split(/\r?\n/, 1)[0] !== "// @orca-managed-pi-extension")
      return null;
    return resolved;
  } catch {
    return null;
  }
}

/**
 * @param {{root: string, argv: string[], env: NodeJS.ProcessEnv, runtimePrompt?: string, dependencyPaths?: ReturnType<typeof resolvePiDependencyPaths>, userHome?: string, sessionId?: string, resumeSessionFile?: string}} options
 */
export function buildPiHarnessInvocation({ root, argv, env, runtimePrompt = "", dependencyPaths = resolvePiDependencyPaths(root), userHome = homedir(), sessionId = randomUUID(), resumeSessionFile }) {
  const runtimeDir = resolve(process.cwd(), ".pi/harness/runtime");
  const sessionDir = resolve(process.cwd(), ".pi/harness/sessions");
  const authPath = join(resolve(userHome), ".pi", "agent", "auth.json");
  const { [PI_RESUME_ENV]: ignoredResume, ...cleanEnv } = env;
  const orcaStatusExtension = resolveOrcaStatusExtension(cleanEnv);
  const extensionArgs = [
    ...EXTENSIONS_BEFORE_SUBAGENTS.flatMap((rel) => ["-e", join(root, rel)]),
    "-e",
    join(root, SUBAGENTS_BRIDGE),
    ...EXTENSIONS_AFTER_SUBAGENTS.flatMap((rel) => ["-e", join(root, rel)]),
    ...(orcaStatusExtension ? ["-e", orcaStatusExtension] : []),
  ];
  return {
    command: process.execPath,
    args: [
      dependencyPaths.piCli,
      "--no-extensions",
      "--no-skills",
      "--no-context-files",
      ...extensionArgs,
      ...[...new Set([join(root, "skills"), join(root, "skills")])].flatMap((dir) => ["--skill", dir]),
      "--append-system-prompt",
      runtimePrompt,
      // Exact path plus the pinned resume guard prevents Pi's missing-file fallback.
      ...(resumeSessionFile ? ["--session", resumeSessionFile]
        : shouldCreateFreshPiSession(argv) ? ["--session-id", sessionId] : []),
      ...argv,
    ],
    env: {
      ...cleanEnv,
      // Operational signal: native bootstrap must not duplicate launcher setup.
      // PI_CODING_AGENT_DIR alone is also valid for native Pi installations.
      PI_HARNESS_LAUNCHER: "1",
      PI_CODING_AGENT_DIR: runtimeDir,
      PI_CODING_AGENT_SESSION_DIR: sessionDir,
      // The launcher replaces any inherited path. This is a single operator
      // credential, never a worktree file or a value from the project.
      [PI_AUTH_PATH_ENV]: authPath,
      ...(resumeSessionFile ? {
        [PI_RESUME_ENV]: JSON.stringify({ file: resumeSessionFile, id: sessionId, cwd: realpathSync(process.cwd()) }),
      } : {}),
    },
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
  materializePiReviewConfig(runtimeDir, join(root, "runtime-defaults/harness.json"));
  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  for (const name of RUNTIME_DEFAULTS) {
    const source = join(root, "runtime-defaults", name);
    const target = join(runtimeDir, name);
    // Agents are locked harness assets. Unlike operator settings, stale copies
    // change workflow behavior across a launcher restart, so refresh them on
    // every launch. They never contain auth or user-owned runtime state.
    if (name === "agents") cpSync(source, target, { recursive: true, force: true });
    else if (!existsSync(target)) cpSync(source, target, { recursive: true });
  }
  // settings.json é um artefato do harness, não credencial do operador. O formato anterior
  // combinava provider/model em defaultModel, mas Pi exige ambos separados. Migramos somente
  // os valores históricos emitidos pelo harness e preservamos defaults explícitos do operador.
  const settingsSource = join(root, "runtime-defaults/settings.json");
  const settingsTarget = join(runtimeDir, "settings.json");
  try {
    const expected = JSON.parse(readFileSync(settingsSource, "utf8"));
    const current = JSON.parse(readFileSync(settingsTarget, "utf8"));
    const childResources = mergePiChildResourceSettings(current, piChildResourceSettings(root));
    const legacyHarnessDefault =
      current && typeof current === "object" && !Array.isArray(current) &&
      current.defaultProvider === undefined &&
      LEGACY_HARNESS_DEFAULT_MODELS.has(current.defaultModel);
    const needsIdleTimeout = current?.httpIdleTimeoutMs !== expected?.httpIdleTimeoutMs;
    const needsChildResources =
      JSON.stringify(current?.extensions) !== JSON.stringify(childResources.extensions) ||
      JSON.stringify(current?.skills) !== JSON.stringify(childResources.skills) ||
      JSON.stringify(current?.harnessChildResources) !== JSON.stringify(childResources.harnessChildResources);
    if (legacyHarnessDefault || needsIdleTimeout || needsChildResources) {
      writeFileSync(
        settingsTarget,
        `${JSON.stringify({
          ...current,
          ...(legacyHarnessDefault ? {
            defaultProvider: expected.defaultProvider,
            defaultModel: expected.defaultModel,
          } : {}),
          ...(needsIdleTimeout ? { httpIdleTimeoutMs: expected.httpIdleTimeoutMs } : {}),
          ...(needsChildResources ? childResources : {}),
        }, null, 2)}\n`,
        "utf8",
      );
    }
  } catch (error) {
    // Invalid resource configuration must not silently erase an operator's permission extension.
    throw new Error(`harness-child-resources: ${error instanceof Error ? error.message : String(error)}`);
  }
  // defaultMaxTurns é um rail de entrega. Atualizamos só esse teto nos runtimes já
  // materializados: os demais campos continuam pertencendo ao operador/local.
  const subagentsSource = join(root, "runtime-defaults/subagents.json");
  const subagentsTarget = join(runtimeDir, "subagents.json");
  try {
    const expected = JSON.parse(readFileSync(subagentsSource, "utf8"));
    const current = JSON.parse(readFileSync(subagentsTarget, "utf8"));
    if (current?.defaultMaxTurns !== expected?.defaultMaxTurns) {
      writeFileSync(
        subagentsTarget,
        `${JSON.stringify({ ...current, defaultMaxTurns: expected.defaultMaxTurns }, null, 2)}\n`,
        "utf8",
      );
    }
  } catch {
    // Como nos settings, preservamos um runtime que o operador eventualmente customizou.
  }
}

/** @param {string} root */
export function verifyPiHarness(root, cacheOptions = {}) {
  let dependencies;
  try {
    dependencies = resolvePiDependencyPaths(root, cacheOptions);
  } catch (error) {
    return { ok: false, reason: `missing-dependency:${error instanceof Error ? error.message : String(error)}` };
  }
  const requiredPaths = [
    dependencies.piCli,
    dependencies.piPackage,
    dependencies.subagentsPackage,
    dependencies.subagentsExtension,
    ...EXTENSIONS_BEFORE_SUBAGENTS.map((rel) => join(root, rel)),
    join(root, SUBAGENTS_BRIDGE),
    ...EXTENSIONS_AFTER_SUBAGENTS.map((rel) => join(root, rel)),
    ...REQUIRED_LIBS.map((rel) => join(root, rel)),
    join(root, "bin/pi-task-worker.mjs"),
    join(root, "skills"),
    join(root, "skills/harness-grill/SKILL.md"),
    join(root, "skills/harness-grill/references/lavish-usage.md"),
    join(root, "prompts/harness-runtime.md"),
    join(root, "prompts/harness-task-runtime.md"),
    join(root, "runtime-defaults/subagents.json"),
    join(root, "runtime-defaults/harness.json"),
    join(root, "runtime-defaults/models-store.json"),
    join(root, "runtime-defaults/settings.json"),
    ...RUNTIME_ROLES.map((role) => join(root, "runtime-defaults/agents", `${role}.md`)),
  ];
  const missing = requiredPaths.find((path) => !existsSync(path));
  if (missing) return { ok: false, reason: `missing:${missing}` };
  const runtime = JSON.parse(readFileSync(dependencies.piPackage, "utf8"));
  const subagents = JSON.parse(readFileSync(dependencies.subagentsPackage, "utf8"));
  if (runtime.version !== "0.84.4") return { ok: false, reason: `runtime-version:${runtime.version}` };
  if (subagents.version !== "21.2.0") return { ok: false, reason: `subagents-version:${subagents.version}` };
  const authPatch = verifyPiAuthPathPatch(dependencies.piPackage, dependencies.subagentsPackage);
  if (!authPatch.ok) return { ok: false, reason: `auth-path-patch:${authPatch.reason}` };
  return { ok: true, runtimeVersion: runtime.version, subagentsVersion: subagents.version, roles: CANONICAL_ROLES.length };
}

function dispatchedChild(env) {
  return typeof env?.HARNESS_DISPATCH_PARENT_SESSION_ID === "string" &&
    env.HARNESS_DISPATCH_PARENT_SESSION_ID.length > 0 &&
    typeof env?.HARNESS_DISPATCH_CALL_ID === "string" &&
    env.HARNESS_DISPATCH_CALL_ID.length > 0;
}

/**
 * @description Run one launcher invocation with exact session selection and worktree-wide
 * parent exclusivity. Dependencies are injectable only so failures can be proven without
 * starting the real Pi runtime.
 */
export function runPiHarnessCli(argv, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const env = { ...(options.env ?? process.env) };
  // A task environment is inherited by native children. A new launcher invocation may only
  // establish it again after an exact grant admission or exact task-session recovery.
  delete env[TASK_RUN_ENV];
  const packageRoot = options.packageRoot ?? PACKAGE_ROOT;
  const errorSink = options.errorSink ?? ((message) => console.error(message));
  const acquireParentLockFn = options.acquireParentLockFn ?? acquirePiParentWorktreeLock;
  const recoverParentSessionFn = options.recoverParentSessionFn ?? recoverPiParentSession;
  const buildInvocationFn = options.buildInvocationFn ?? buildPiHarnessInvocation;
  const materializeRuntimeFn = options.materializeRuntimeFn ?? materializeRuntime;
  const spawnSyncFn = options.spawnSyncFn ?? spawnSync;
  const randomSessionIdFn = options.randomSessionIdFn ?? randomUUID;

  const marker = argv.indexOf("--");
  const operationalEnd = marker < 0 ? argv.length : marker;
  const taskIndexes = [];
  for (let index = 0; index < operationalEnd; index += 1) {
    if (argv[index] === "--harness-task") taskIndexes.push(index);
  }
  let taskGrant = null;
  if (taskIndexes.length > 0) {
    const at = taskIndexes[0];
    if (taskIndexes.length !== 1 || at + 1 >= operationalEnd || !argv[at + 1] || String(argv[at + 1]).startsWith("-") ||
        argv.slice(0, operationalEnd).includes("--harness-resume")) {
      errorSink("Pi harness: one task grant required; resume an existing task with --harness-resume alone");
      return { exitCode: 2 };
    }
    taskGrant = String(argv[at + 1]);
    argv = [...argv.slice(0, at), ...argv.slice(at + 2)];
    if (!shouldCreateFreshPiSession(argv)) {
      errorSink("Pi harness: task mode requires a fresh operational session");
      return { exitCode: 2 };
    }
  }

  const parsed = parseHarnessResume(argv);
  if (!parsed.ok) {
    errorSink(`Pi harness: ${parsed.reason}`);
    return { exitCode: 2 };
  }

  const sessionId = parsed.resumeSessionId ?? randomSessionIdFn();
  const parentOperation = Boolean(taskGrant) || Boolean(parsed.resumeSessionId) ||
    (shouldCreateFreshPiSession(parsed.argv) && !dispatchedChild(env));
  let parentLock;
  try {
    if (parentOperation) {
      parentLock = acquireParentLockFn(cwd, { sessionId });
      if (!parentLock.ok) {
        errorSink(`Pi harness: cannot ${parsed.resumeSessionId ? "resume" : "start"} ceremony: ${parentLock.reason}`);
        return { exitCode: 2 };
      }
    }

    let runtimePrompt = options.runtimePrompt ??
      readFileSync(join(packageRoot, "prompts/harness-runtime.md"), "utf8").trim();
    const readTaskRuntimePrompt = () => options.taskRuntimePrompt ??
      readFileSync(join(packageRoot, "prompts/harness-task-runtime.md"), "utf8").trim();
    let taskAdmissionPreview;
    let taskRuntimePrompt;
    if (taskGrant) {
      taskRuntimePrompt = readTaskRuntimePrompt();
      taskAdmissionPreview = inspectTaskAdmission(taskGrant, { cwd, sessionId });
      if (!taskAdmissionPreview.ok) {
        errorSink(`Pi harness: ${taskAdmissionPreview.reason}`);
        return { exitCode: 2 };
      }
      runtimePrompt = taskRunPrompt(taskRuntimePrompt, taskAdmissionPreview);
      env[TASK_RUN_ENV] = JSON.stringify({ cwd: taskAdmissionPreview.root, sessionId });
    }
    let resumeSessionFile;
    if (parsed.resumeSessionId) {
      const recovery = recoverParentSessionFn(cwd, parsed.resumeSessionId);
      if (!recovery.ok) {
        errorSink(`Pi harness: cannot resume ceremony: ${recovery.reason}`);
        return { exitCode: 2 };
      }
      if (recovery.taskAdmission) {
        taskRuntimePrompt = readTaskRuntimePrompt();
        runtimePrompt = `${taskRunPrompt(taskRuntimePrompt, recovery.taskAdmission)}\n\n${recovery.context}`;
        env[TASK_RUN_ENV] = JSON.stringify({ cwd: recovery.root, sessionId });
      } else {
        runtimePrompt = `${runtimePrompt}\n\n${recovery.context}`;
      }
      resumeSessionFile = recovery.sessionFile;
    }

    const invocation = buildInvocationFn({
      root: packageRoot,
      argv: parsed.argv,
      env,
      runtimePrompt,
      resumeSessionFile,
      sessionId,
    });
    materializeRuntimeFn(packageRoot, invocation.env.PI_CODING_AGENT_DIR);
    let taskAdmission;
    if (taskGrant) {
      // Claim only after dependency resolution, prompt/resource reads and runtime materialization
      // have succeeded. From this point the next operation is the actual Pi process spawn.
      taskAdmission = admitTaskRun(taskGrant, { cwd, sessionId });
      if (!taskAdmission.ok) {
        errorSink(`Pi harness: ${taskAdmission.reason}`);
        return { exitCode: 2 };
      }
      if (taskRunPrompt(taskRuntimePrompt, taskAdmission) !== runtimePrompt) {
        rollbackTaskAdmission(taskAdmission);
        taskAdmission = null;
        throw new Error("task grant changed between preflight and admission");
      }
    }
    let result;
    try {
      result = spawnSyncFn(invocation.command, invocation.args, {
        env: invocation.env,
        stdio: "inherit",
      });
    } catch (error) {
      if (taskAdmission) rollbackTaskAdmission(taskAdmission);
      throw error;
    }
    if (result.error) {
      if (taskAdmission) rollbackTaskAdmission(taskAdmission);
      throw result.error;
    }
    return { exitCode: result.status ?? 1 };
  } catch (error) {
    errorSink(`Pi harness: ${error instanceof Error ? error.message : String(error)}`);
    return { exitCode: 1 };
  } finally {
    parentLock?.release?.();
  }
}

function main() {
  if (process.argv.slice(2).length === 1 && process.argv[2] === "--verify") {
    const result = verifyPiHarness(PACKAGE_ROOT);
    console.log(JSON.stringify(result));
    process.exitCode = result.ok ? 0 : 1;
    return;
  }
  process.exitCode = runPiHarnessCli(process.argv.slice(2)).exitCode;
}

if (isDirectCli(process.argv[1])) main();
