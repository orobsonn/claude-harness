#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { PI_AUTH_PATH_ENV } from "../../pi/lib/pi-auth-path-patch.mjs";
import { resolveVerifiedPiRuntime } from "../../pi/lib/pi-runtime-cache.mjs";
import { atomicWriteJson, controlHome, ensureControlHome, readPrivateJson, withLock } from "../lib/storage.mjs";

const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const AGENT_PROFILE_REVISION = 10;

export const HELP_TEXT = `Uso: harness-control-plane [opções]

Inicia a conversa dedicada do agente geral. O agente recebe as ferramentas
nativas do Pi para operar a VPS e a tool harness_control para os fluxos
estruturados do Claude Harness.

Opções:
  --provider <nome>   Seleciona um provider Pi já configurado
  --model <id>        Seleciona um modelo Pi já configurado
  --thinking <nível>  Seleciona o nível de raciocínio do Pi
  --tui-mode <modo>   Seleciona o modo da TUI do Pi
  --offline           Desativa descoberta de providers pela rede
  --verbose           Exibe diagnósticos detalhados do Pi
  -h, --help          Exibe esta ajuda

O estado fica por padrão em $XDG_STATE_HOME/claude-harness/control-plane ou
~/.local/state/claude-harness/control-plane. HARNESS_CONTROL_HOME permite
selecionar outro diretório absoluto, privado e dedicado.
`;

function parseSafeArgs(argv) {
  const withValue = new Set(["--provider", "--model", "--thinking", "--tui-mode"]);
  const flags = new Set(["--offline", "--verbose"]);
  const result = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (flags.has(arg)) result.push(arg);
    else if (withValue.has(arg) && argv[index + 1] && !argv[index + 1].startsWith("-")) result.push(arg, argv[++index]);
    else throw new Error(`unsupported control-plane launcher argument: ${arg}`);
  }
  return result;
}

function materializeAgentRuntime(home) {
  const runtimeDir = path.join(home, "runtime");
  const settingsPath = path.join(runtimeDir, "settings.json");
  if (!fs.existsSync(settingsPath)) {
    const defaults = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "core/pi/runtime/settings.json"), "utf8"));
    atomicWriteJson(settingsPath, defaults);
  }
  const identityPath = path.join(home, "agent-session.json");
  let identity = readPrivateJson(identityPath, { optional: true });
  if (!identity || identity.profile_revision !== AGENT_PROFILE_REVISION) {
    identity = {
      schema: "harness.control.agent-session.v1",
      profile_revision: AGENT_PROFILE_REVISION,
      session_id: randomUUID(),
      created_at: new Date().toISOString(),
      ...(identity?.session_id ? { supersedes_session_id: identity.session_id } : {}),
    };
    atomicWriteJson(identityPath, identity);
  }
  return { runtimeDir, sessionId: identity.session_id };
}

export function buildControlPlaneInvocation(argv, options = {}) {
  const home = ensureControlHome(options.home ?? controlHome(options.env));
  const runtime = options.runtime ?? resolveVerifiedPiRuntime();
  if (!runtime.ok) throw new Error(`${runtime.reason}. Prepare the pinned Pi runtime with harness init/update before launching the control plane.`);
  const agent = materializeAgentRuntime(home);
  const prompt = fs.readFileSync(path.join(PACKAGE_ROOT, "core/control-plane/prompts/general-agent.md"), "utf8");
  return {
    home,
    command: process.execPath,
    args: [
      runtime.paths.piCli,
      "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files",
      "--extension", path.join(PACKAGE_ROOT, "core/control-plane/extensions/control-plane-tools.ts"),
      "--system-prompt", prompt,
      "--session-dir", path.join(home, "sessions"),
      "--session-id", agent.sessionId,
      ...parseSafeArgs(argv),
    ],
    env: {
      ...(options.env ?? process.env),
      HARNESS_CONTROL_HOME: home,
      PI_CODING_AGENT_DIR: agent.runtimeDir,
      PI_CODING_AGENT_SESSION_DIR: path.join(home, "sessions"),
      [PI_AUTH_PATH_ENV]: path.join(os.homedir(), ".pi", "agent", "auth.json"),
    },
  };
}

export async function runControlPlane(argv = process.argv.slice(2), options = {}) {
  if (argv.length === 1 && ["-h", "--help"].includes(argv[0])) {
    (options.print ?? console.log)(HELP_TEXT.trimEnd());
    return 0;
  }
  const invocation = buildControlPlaneInvocation(argv, options);
  return withLock(invocation.home, "general-agent", async () => {
    const spawn = options.spawnSync ?? spawnSync;
    const result = spawn(invocation.command, invocation.args, { cwd: invocation.home, env: invocation.env, stdio: "inherit" });
    if (result.error) throw result.error;
    return result.status ?? 1;
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runControlPlane().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`Harness control plane: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
