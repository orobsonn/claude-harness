/** @description Materialização mínima dos papéis do harness para `pi install <pacote>`. */
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { RUNTIME_ROLES } from "./roles.mjs";
import { materializePiReviewConfig } from "./pi-review-config.mjs";

export const NATIVE_BOOTSTRAP_MARKER = "claude-harness-native-bootstrap:v1";

const DEFAULT_ASSETS_DIR = fileURLToPath(new URL("../runtime/", import.meta.url));
const DEFAULT_PROMPT_PATH = fileURLToPath(new URL("../prompts/harness-runtime.md", import.meta.url));

/** @param {unknown} value */
function nonEmptyPath(value) {
  return typeof value === "string" && value.trim() ? resolve(value) : null;
}

/** @param {string} path */
function safeFile(path) {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/** @param {string} path */
function safeExistingDirectory(path) {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/** @param {string} role */
export function nativeAgentOwnershipMarker(role) {
  return `<!-- ${NATIVE_BOOTSTRAP_MARKER} role=${JSON.stringify(role)} -->`;
}

/** @param {string} source @param {string} role */
export function markNativeHarnessAgent(source, role) {
  const marker = nativeAgentOwnershipMarker(role);
  const close = source.indexOf("\n---\n", 4);
  if (!source.startsWith("---\n") || close === -1) {
    throw new Error(`invalid-agent-frontmatter:${role}`);
  }
  const bodyStart = close + "\n---\n".length;
  return `${source.slice(0, bodyStart)}\n${marker}\n${source.slice(bodyStart)}`;
}

/**
 * Materializa somente arquivos que levam a marca exata deste bootstrap. A pré-validação ocorre
 * antes de mkdir/write para que uma colisão do usuário não deixe um conjunto parcial de papéis.
 * Não lê nem grava settings, auth, modelos ou subagents.json.
 *
 * @param {{agentDir?: string, assetsDir?: string, promptPath?: string}} [options]
 */
export function installNativeHarnessAgents(options = {}) {
  const agentDir = nonEmptyPath(options.agentDir);
  const assetsDir = nonEmptyPath(options.assetsDir) ?? DEFAULT_ASSETS_DIR;
  const promptPath = nonEmptyPath(options.promptPath) ?? DEFAULT_PROMPT_PATH;
  if (!agentDir) return { ok: false, reason: "native-agent-dir-invalid" };
  if (!safeFile(promptPath)) return { ok: false, reason: "native-runtime-prompt-missing" };

  let runtimePrompt;
  try {
    runtimePrompt = readFileSync(promptPath, "utf8").trim();
  } catch {
    return { ok: false, reason: "native-runtime-prompt-missing" };
  }

  const agentsDir = join(agentDir, "agents");
  if (existsSync(agentDir) && !safeExistingDirectory(agentDir)) {
    return { ok: false, reason: "native-agent-dir-unsafe" };
  }
  if (existsSync(agentsDir) && !safeExistingDirectory(agentsDir)) {
    return { ok: false, reason: "native-agents-dir-unsafe" };
  }

  /** @type {Array<{role: string, target: string, content: string}>} */
  const agents = [];
  try {
    for (const role of RUNTIME_ROLES) {
      const source = join(assetsDir, "agents", `${role}.md`);
      if (!safeFile(source)) return { ok: false, reason: `native-agent-source-missing:${role}` };
      const target = join(agentsDir, `${role}.md`);
      agents.push({ role, target, content: markNativeHarnessAgent(readFileSync(source, "utf8"), role) });
    }
  } catch {
    return { ok: false, reason: "native-agent-source-invalid" };
  }

  for (const agent of agents) {
    if (!existsSync(agent.target)) continue;
    if (!safeFile(agent.target)) return { ok: false, reason: `native-agent-collision:${agent.role}` };
    try {
      if (!readFileSync(agent.target, "utf8").includes(nativeAgentOwnershipMarker(agent.role))) {
        return { ok: false, reason: `native-agent-collision:${agent.role}` };
      }
    } catch {
      return { ok: false, reason: `native-agent-collision:${agent.role}` };
    }
  }

  try {
    materializePiReviewConfig(agentDir, join(assetsDir, "harness.json"));
  } catch (error) {
    return { ok: false, reason: `harness-config: ${error instanceof Error ? error.message : String(error)}` };
  }
  try {
    mkdirSync(agentsDir, { recursive: true, mode: 0o700 });
    if (!safeExistingDirectory(agentsDir)) return { ok: false, reason: "native-agents-dir-unsafe" };
    for (const agent of agents) writeFileSync(agent.target, agent.content, { mode: 0o600 });
    return {
      ok: true,
      agentDir,
      roles: [...RUNTIME_ROLES],
      runtimePrompt,
    };
  } catch {
    return { ok: false, reason: "native-agent-write-failed" };
  }
}
