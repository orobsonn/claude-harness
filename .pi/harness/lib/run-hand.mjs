/**
 * @description Mão barata da lane Pi: dispara o launcher Pi local em modo headless, captura o
 * resultado de forma INDEPENDENTE (oráculo compartilhado) e aplica a política de worktree por
 * desfecho. DONE nunca vem de prosa nem do exit code do processo — só de capture-oracle.
 *
 * Reuso: TODO o oráculo (core/shared/lib/capture-oracle.mjs) e todas as funções puras de
 * core/opencode/hands/run-hand.mjs que não dependem do binário `opencode` são importadas e
 * re-exportadas aqui — zero cópia. Ganham contraparte Pi apenas as três famílias que a lane OC
 * amarra ao seu próprio host:
 *   (a) buildOpencodeRunArgs/defaultSpawnOpencode → buildPiRunArgs/spawnPiHand
 *       (`node <root>/bin/pi-harness.mjs -p <brief> --mode json --model openai-codex/<id>`);
 *   (b) gateStatePath/mergeGateState/claimDispatchForRuntime/removeDispatchRecord/writeHandRecord
 *       → as versões Pi de pi-paths/pi-gate-state/pi-state-records (raiz `.pi/harness/state/`);
 *   (c) defaultHasFidelityPass/defaultIsHandQuarantined/defaultMarkHandQuarantine lendo o
 *       gate-state em piGateStatePath.
 *
 * Divergência declarada de host (não de comportamento): o agente vendorizado do Pi
 * (core/pi/runtime/agents/harness-*.md) NÃO declara `model:` — sua própria prosa diz "The parent
 * supplies the model route explicitly" — e não existe `mode:`/`tools.task` no frontmatter do Pi.
 * Por isso o frontmatter Pi é autoritativo só para o LOCKDOWN (`locked: true`, sem tool de
 * despacho), e a rota de modelo vem do descriptor, restrita a `openai-codex/*`: o operador roda
 * exclusivamente OpenAI por assinatura Codex e NENHUM default Anthropic pode ser configurado aqui.
 *
 * Consequência que o lockdown TEM de cobrir: o Pi não tem flag `--agent` (dist/cli/args.js), logo o
 * arquivo validado nunca vira a persona do processo filho — validar o frontmatter, sozinho, seria
 * decorativo. Quem enforca o "sem tool de despacho" no filho é `--exclude-tools`
 * (PI_HAND_EXCLUDED_TOOLS) no argv do spawn, contraparte real do `--agent <x>` + `tools.task: false`
 * da lane OC. A prosa do agente vendorizado, essa sim, não alcança o filho: a tarefa viaja no brief.
 *
 * Mensagens de negação, marcadores (hand_quarantine, hand_finished, capture_verified),
 * VACUOUS_GREEN_EXIT e SPAWNABLE_HAND_ROLES são idênticos aos da lane OC. Papéis chegam
 * prefixados `harness-` no Pi e passam por toOcRole antes de qualquer comparação.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  OUTCOME,
  checkAllowedWrites,
  checkFrozen,
  checkScope,
  evaluateRun,
  excludeHarnessInternal,
  parseTestsCount,
  subtractUnchanged,
} from "../vendor/shared/lib/capture-oracle.mjs";
import { absolutionPrefix, formatFeatureTaskEntry } from "../vendor/shared/lib/absolution.mjs";
import { hasFidelityPass } from "../vendor/opencode/lib/entry-decide.mjs";
import {
  VACUOUS_GREEN_EXIT,
  SPAWNABLE_HAND_ROLES,
  applyWorktreePolicy,
  buildHandRunRecord,
  captureHandResult,
  cleanupWorktreeAfterNonDone,
  defaultLsAllOthers,
  extractFrontmatter,
  hashFileContents,
  isExecutorHandRole,
  isQuarantinedInGateState,
  quarantineMarkerKey,
  realGit,
  realTestRunner,
  snapshotPreUntracked,
  spawnAgentName,
  validateSpawnAgent,
} from "../vendor/opencode/hands/run-hand.mjs";
import { mergeGateState } from "./pi-gate-state.mjs";
import { piGateStatePath } from "./pi-paths.mjs";
import { toOcRole } from "./pi-adapter-map.mjs";
import {
  claimPiDispatchForRuntime,
  removePiDispatchRecord,
  writePiHandRecord,
} from "./pi-state-records.mjs";

/** Reuso literal da lane OC — mesma lógica, mesmas mensagens, sem cópia. */
export {
  OUTCOME,
  VACUOUS_GREEN_EXIT,
  SPAWNABLE_HAND_ROLES,
  applyWorktreePolicy,
  buildHandRunRecord,
  captureHandResult,
  checkAllowedWrites,
  checkFrozen,
  checkScope,
  cleanupWorktreeAfterNonDone,
  defaultLsAllOthers,
  evaluateRun,
  excludeHarnessInternal,
  extractFrontmatter,
  hashFileContents,
  isExecutorHandRole,
  isQuarantinedInGateState,
  parseTestsCount,
  quarantineMarkerKey,
  realGit,
  realTestRunner,
  snapshotPreUntracked,
  spawnAgentName,
  subtractUnchanged,
  validateSpawnAgent,
  writePiHandRecord,
};

/** @description Nome da tool nativa exposta ao modelo pelo adaptador Pi. */
export const RUN_HAND_TOOL_NAME = "run_hand";

/** @description Único prefixo de provedor aceito para uma mão do Pi (assinatura Codex do operador). */
export const PI_HAND_MODEL_PREFIX = "openai-codex/";

/** @description Diretório de agentes materializado pelo launcher (materializeRuntime). */
export const PI_AGENTS_DIR = join(".pi", "harness", "runtime", "agents");

/** @description Launcher headless da lane Pi: <core/pi>/bin/pi-harness.mjs. */
export const PI_HAND_LAUNCHER = fileURLToPath(new URL("../bin/pi-harness.mjs", import.meta.url));

/** Tiers que sufixam um papel de mão; o asset do Pi é sem tier (harness-executor.md). */
const TIER_SUFFIX_RE = /-(low|medium|high)$/;

/** Tools de despacho que uma mão nunca pode carregar (paridade com `tools.task: false` do OC). */
const PI_DISPATCH_TOOLS = Object.freeze(["subagent", "task", "dispatch"]);

/**
 * @description Tools desligadas no processo da mão, por argv. O Pi NÃO tem flag `--agent`
 * (dist/cli/args.js): o frontmatter vendorizado não vira persona do processo filho, então validar
 * "sem tool de despacho" no arquivo não bastaria — o launcher carrega pi-subagents e a mão ficaria
 * com a tool `subagent` em mãos. `--exclude-tools` é o que de fato ENFORCA na lane Pi o que
 * `--agent <x>` + `tools.task: false` enforcam na lane OC: mão barata nunca despacha mão barata.
 * `get_subagent_result`/`steer_subagent` entram junto porque sem `subagent` não têm alvo.
 */
export const PI_HAND_EXCLUDED_TOOLS = Object.freeze([
  "subagent",
  "get_subagent_result",
  "steer_subagent",
]);

/**
 * @description Nome do asset de agente do Pi para um papel de mão. O Pi vendoriza um arquivo por
 * papel-base, sem tier (`harness-executor.md` serve executor-low/medium/high), enquanto o RECORD
 * e o dispatch-record guardam o papel completo como veio do descriptor.
 * @param {unknown} role
 * @returns {string}
 */
export function piHandAgentName(role) {
  const bare = toOcRole(role).replace(/-spawn$/, "");
  if (!bare) return "";
  return `harness-${bare.replace(TIER_SUFFIX_RE, "")}`;
}

/**
 * @description Valida o agente de mão vendorizado do Pi. O frontmatter do Pi não tem `mode:`
 * nem `model:` — o que ele precisa provar é o LOCKDOWN: `locked: true` e nenhuma tool de
 * despacho (equivalente exato do `tools.task: false` que validateSpawnAgent exige na lane OC).
 * Nunca lança; toda recusa é CONFIG_ERROR.
 * @param {string} agentMd
 * @param {string} [agentName]
 * @returns {{ ok: true, agentName: string } | { ok: false, reason: string, outcome: string }}
 */
export function validatePiHandAgent(agentMd, agentName = "agent") {
  try {
    const fm = extractFrontmatter(agentMd);
    if (!fm) {
      return {
        ok: false,
        reason: `agent ${agentName}: missing frontmatter`,
        outcome: OUTCOME.CONFIG_ERROR,
      };
    }
    const lockedM = fm.match(/^locked:\s*(.+)$/m);
    const locked = lockedM ? lockedM[1].trim().replace(/^["']|["']$/g, "") : "";
    if (locked !== "true") {
      return {
        ok: false,
        reason: `agent ${agentName}: locked must be true for hand spawn`,
        outcome: OUTCOME.CONFIG_ERROR,
      };
    }
    const toolsM = fm.match(/^tools:\s*(.+)$/m);
    const tools = toolsM
      ? toolsM[1]
          .split(",")
          .map((t) => t.trim().replace(/^["']|["']$/g, "").toLowerCase())
          .filter(Boolean)
      : [];
    const dispatcher = tools.find((t) => PI_DISPATCH_TOOLS.includes(t));
    if (dispatcher) {
      return {
        ok: false,
        reason: `agent ${agentName}: tools must not include ${dispatcher} for hand spawn`,
        outcome: OUTCOME.CONFIG_ERROR,
      };
    }
    return { ok: true, agentName };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "validatePiHandAgent failed",
      outcome: OUTCOME.CONFIG_ERROR,
    };
  }
}

/**
 * @description Lê e valida o arquivo do agente de mão em <agentsDir>/<agentName>.md. Nunca lança.
 * @param {string} agentsDir
 * @param {string} agentName
 * @param {{ readFileSync?: typeof readFileSync, existsSync?: typeof existsSync }} [fs]
 * @returns {{ ok: true, agentName: string } | { ok: false, reason: string, outcome: string }}
 */
export function loadAndValidatePiHandAgent(agentsDir, agentName, fs = { readFileSync, existsSync }) {
  const path = join(agentsDir, `${agentName}.md`);
  if (!fs.existsSync(path)) {
    return {
      ok: false,
      reason: `agent file missing: ${path}`,
      outcome: OUTCOME.CONFIG_ERROR,
    };
  }
  let md;
  try {
    md = fs.readFileSync(path, "utf8");
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "read agent failed",
      outcome: OUTCOME.CONFIG_ERROR,
    };
  }
  return validatePiHandAgent(md, agentName);
}

/**
 * @description Resolve a rota de modelo da mão. Só `openai-codex/<id>` passa: o runtime Pi do
 * operador roda exclusivamente OpenAI por assinatura Codex e nenhum default Anthropic pode ser
 * configurado nesta lane. Nunca lança.
 * @param {unknown} model
 * @returns {{ ok: true, model: string } | { ok: false, reason: string }}
 */
export function resolvePiHandModel(model) {
  const value = typeof model === "string" ? model.trim() : "";
  if (!value) {
    return { ok: false, reason: `hand model is required and must start with ${PI_HAND_MODEL_PREFIX}` };
  }
  if (!value.startsWith(PI_HAND_MODEL_PREFIX) || value.length === PI_HAND_MODEL_PREFIX.length) {
    return { ok: false, reason: `hand model ${value}: only ${PI_HAND_MODEL_PREFIX}* routes are approved for the Pi lane` };
  }
  return { ok: true, model: value };
}

/**
 * @description argv do launcher headless do Pi (token nunca em argv). Contraparte de
 * buildOpencodeRunArgs: `node <root>/bin/pi-harness.mjs -p --mode json --model <model>
 * --exclude-tools <despacho> -- <brief>`.
 *
 * Duas exigências do parser do Pi (dist/cli/args.js), ambas load-bearing:
 *   • o brief vai DEPOIS de `--`. `-p` só adota o argumento seguinte como prompt quando ele não
 *     começa com `-` nem `@` — um brief em bullet ("- Implemente…") seria descartado em silêncio e
 *     a mão rodaria sem tarefa, terminando em NOT_DONE por diff vazio sem nenhum sinal do motivo.
 *     `--` é a receita do próprio help do Pi ("Prompt beginning with a dash").
 *   • `--exclude-tools` desliga o despacho de subagente no filho — ver PI_HAND_EXCLUDED_TOOLS.
 * @param {{ launcher?: string, model: string, prompt: string }} p
 * @returns {string[]}
 */
export function buildPiRunArgs({ launcher = PI_HAND_LAUNCHER, model, prompt }) {
  return [
    launcher,
    "-p",
    "--mode",
    "json",
    "--model",
    String(model ?? ""),
    "--exclude-tools",
    PI_HAND_EXCLUDED_TOOLS.join(","),
    "--",
    String(prompt ?? ""),
  ];
}

/**
 * @description Spawn real da mão do Pi (não exercitado por teste unitário). A autoridade de
 * dispatch viaja por env, nunca por argv; nenhum token de autenticação é lido aqui.
 * @param {{ projectDir: string, model: string, prompt: string, launcher?: string, dispatchAuthority?: { sessionId?: string, callId?: string } }} p
 * @returns {{ exitCode: number, stdout: string, stderr: string }}
 */
export function spawnPiHand({ projectDir, model, prompt, launcher = PI_HAND_LAUNCHER, dispatchAuthority }) {
  const args = buildPiRunArgs({ launcher, model, prompt });
  const r = spawnSync(process.execPath, args, {
    cwd: projectDir,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    env: {
      ...process.env,
      HARNESS_DISPATCH_PARENT_SESSION_ID: dispatchAuthority?.sessionId ?? "",
      HARNESS_DISPATCH_CALL_ID: dispatchAuthority?.callId ?? "",
    },
  });
  return {
    exitCode: typeof r.status === "number" ? r.status : 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

/**
 * @description Lê o gate-state Pi da sessão de disco; objeto vazio em qualquer erro (fail-closed
 * pelo consumidor: sem fatos, nenhum marcador está presente). Nunca lança.
 * @param {string} projectRoot
 * @param {string} sessionId
 * @returns {Record<string, unknown>}
 */
function readPiGateStateObject(projectRoot, sessionId) {
  try {
    const gp = piGateStatePath({ projectRoot, sessionId });
    if (!gp.ok || !existsSync(gp.path)) return {};
    const state = JSON.parse(readFileSync(gp.path, "utf8"));
    if (!state || typeof state !== "object" || Array.isArray(state)) return {};
    return /** @type {Record<string, unknown>} */ (state);
  } catch {
    return {};
  }
}

/**
 * @description Lê o gate-state Pi e checa hand_quarantine para feature+task. Nunca lança.
 * @param {{ projectRoot: string, sessionId: string, featureId: string, taskId: string }} args
 * @returns {boolean}
 */
export function defaultIsPiHandQuarantined({ projectRoot, sessionId, featureId, taskId }) {
  return isQuarantinedInGateState(
    readPiGateStateObject(projectRoot, sessionId),
    featureId,
    taskId,
  );
}

/**
 * @description Lê fidelity_pass do gate-state Pi para feature+task. Fail-closed (false) em
 * ausência ou erro. Exige o par EXATO <feature>/<task> (hasFidelityPass importada de entry-decide).
 * @param {{ projectRoot: string, sessionId: string, featureId: string, taskId: string }} args
 * @returns {boolean}
 */
export function defaultHasPiFidelityPass({ projectRoot, sessionId, featureId, taskId }) {
  const state = readPiGateStateObject(projectRoot, sessionId);
  return hasFidelityPass(state.fidelity_pass, featureId, taskId);
}

/**
 * @description Acrescenta o marcador hand_quarantine para feature+task no gate-state Pi, sob lock
 * (mergeGateState → mergeGateStatePatch). Nunca lança.
 * @param {{ projectRoot: string, sessionId: string, featureId: string, taskId: string }} args
 * @returns {{ ok: boolean, reason?: string }}
 */
export function defaultMarkPiHandQuarantine({ projectRoot, sessionId, featureId, taskId }) {
  try {
    const gp = piGateStatePath({ projectRoot, sessionId });
    if (!gp.ok) return { ok: false, reason: gp.reason };
    const key = quarantineMarkerKey(featureId, taskId);
    const merged = mergeGateState(gp.path, { hand_quarantine: [key] });
    if (!merged.ok) {
      return { ok: false, reason: merged.reason ?? "mergeGateState failed" };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "defaultMarkPiHandQuarantine failed",
    };
  }
}

/**
 * @description Leitor real do descriptor JSON (o mesmo arquivo que o `--descriptor` da lane OC
 * consome). Devolve o objeto ou null em QUALQUER erro; o chamador trata null como fail-CLOSED.
 * Nunca lança.
 * @param {string} descriptorPath
 * @returns {object|null}
 */
export function defaultReadPiDescriptor(descriptorPath) {
  try {
    const raw = readFileSync(descriptorPath, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * @description Rail de spawn do entry-gate, portado 1:1 de decideSpawnHandFidelity
 * (core/opencode/plugin/lib/bash-decide.mjs) — MESMAS mensagens, inclusive o literal
 * "spawn-hand.mjs" (paridade de mensagem de negação é contrato, não estética).
 * Diferenças de host, ambas obrigatórias:
 *   • na lane OC o rail é opcional (comando sem `--descriptor` fail-OPEN); aqui o descriptor É a
 *     entrada da tool, então um descriptor ausente/ilegível/inválido é sempre fail-CLOSED;
 *   • a checagem de fidelity só recai sobre papel executor (isExecutorHandRole), espelhando a
 *     isenção que runHand já aplica a test-author (o PRODUTOR do fato) e a sniper — na lane OC o
 *     script spawn-hand.mjs era executor-only, então o rail podia ser incondicional.
 * @param {{ descriptorPath?: unknown, descriptor?: unknown, gateState?: unknown }} input
 * @returns {{ ok: true, decision: "allow", reason: string, descriptor: object }
 *   | { ok: false, decision: "deny", reason: string }}
 */
export function decidePiRunHandSpawn(input = {}) {
  const descriptorPath = typeof input.descriptorPath === "string" ? input.descriptorPath : "";
  const descriptor = input.descriptor;
  if (
    descriptor === null ||
    typeof descriptor !== "object" ||
    Array.isArray(descriptor) ||
    typeof descriptor.feature_id !== "string" ||
    typeof descriptor.task_id !== "string"
  ) {
    return {
      ok: false,
      decision: "deny",
      reason:
        "[entry-gate] Blocked: spawn-hand.mjs dispatch denied — --descriptor flag was present " +
        `but the descriptor at '${descriptorPath}' could not be resolved to a qualified ` +
        "feature_id/task_id (missing file, invalid JSON, or non-string ids). " +
        "The fidelity check requires a readable descriptor with string feature_id and task_id. " +
        "Ensure the descriptor JSON exists and is well-formed before dispatching.",
    };
  }
  const role = descriptor.role ?? descriptor.agent ?? "";
  if (!isExecutorHandRole(toOcRole(role))) {
    return { ok: true, decision: "allow", reason: "spawn-hand-fidelity-exempt", descriptor };
  }
  const qualifiedId = formatFeatureTaskEntry(descriptor.feature_id, descriptor.task_id);
  const gs =
    input.gateState && typeof input.gateState === "object" && !Array.isArray(input.gateState)
      ? /** @type {Record<string, unknown>} */ (input.gateState)
      : {};
  const fidelityPrefixes = (Array.isArray(gs.fidelity_pass) ? gs.fidelity_pass : []).map(absolutionPrefix);
  if (!fidelityPrefixes.includes(qualifiedId)) {
    return {
      ok: false,
      decision: "deny",
      reason:
        `[entry-gate] Blocked: spawn-hand.mjs dispatch denied — fidelity-pass for task ` +
        `${qualifiedId} has not been stamped. Dispatch the test-author first to produce ` +
        "a failing locked test, then stamp fidelity-pass " +
        `(mark.mjs fidelity-pass --feature-id ${descriptor.feature_id} --task-id ${descriptor.task_id}) ` +
        "before dispatching the executor cheap-hand.",
    };
  }
  return { ok: true, decision: "allow", reason: "spawn-hand-fidelity-ok", descriptor };
}

/**
 * @description Orquestração completa de uma mão do Pi, com todas as costuras injetáveis
 * (unit-testável). Porte 1:1 de runHand (lane OC): mesmas pré-condições, mesma ordem de gates,
 * mesmas mensagens, mesmo formato de record. O adaptador nunca lê token de autenticação.
 * @param {object} descriptor
 * @param {object} [deps]
 * @returns {Promise<object>}
 */
export async function runPiHand(descriptor, deps = {}) {
  const startedAt = new Date().toISOString();
  const {
    spawn = spawnPiHand,
    git = null,
    testRunner = null,
    agentsDir = null,
    readAgent = null,
    lsUntracked = null,
    gitResetHard = null,
    removePath = null,
    writePath = null,
    isDirtyVsFreeze = null,
    writeRecord = writePiHandRecord,
    isHandQuarantined = null,
    markHandQuarantine = null,
    checkFidelityPass = null,
    now = () => new Date().toISOString(),
    dispatchCallId = () => `run-hand:${randomUUID()}`,
    claimDispatch = claimPiDispatchForRuntime,
    finishDispatch = removePiDispatchRecord,
    dispatchEnvironment = process.env,
    isReviewedShaAncestor = null,
  } = deps;

  const featureId = descriptor?.feature_id ?? descriptor?.featureId;
  const taskId = descriptor?.task_id ?? descriptor?.taskId;
  const sessionId = descriptor?.session_id ?? descriptor?.sessionId;
  const projectRoot = descriptor?.project_root ?? descriptor?.projectRoot ?? process.cwd();
  let freezeCommitSha = descriptor?.freeze_commit_sha ?? descriptor?.freezeCommitSha;
  const role = descriptor?.role ?? descriptor?.agent ?? "harness-executor-medium";
  const agent = spawnAgentName(role);
  const ocRole = toOcRole(role);
  const no_tests = descriptor?.no_tests === true;
  const brief = descriptor?.brief ?? descriptor?.prompt ?? "";
  const resolvedAgentsDir = agentsDir ?? join(projectRoot, PI_AGENTS_DIR);

  const checkQuarantine = () => {
    if (typeof isHandQuarantined === "function") {
      return isHandQuarantined({ featureId, taskId, sessionId, projectRoot });
    }
    return defaultIsPiHandQuarantined({ projectRoot, sessionId, featureId, taskId });
  };

  const writeQuarantineMarker = () => {
    if (typeof markHandQuarantine === "function") {
      return markHandQuarantine({ featureId, taskId, sessionId, projectRoot });
    }
    return defaultMarkPiHandQuarantine({ projectRoot, sessionId, featureId, taskId });
  };

  const failConfig = (reason, extra = {}) => {
    const outcome = OUTCOME.CONFIG_ERROR;
    const record = buildHandRunRecord({
      featureId,
      taskId,
      sessionId,
      freezeCommitSha,
      outcome,
      details: { reasons: [reason] },
      agent,
      timestamps: { startedAt, finishedAt: now() },
      ...extra,
    });
    let recordPath;
    if (featureId && taskId && sessionId) {
      const w = writeRecord({
        roots: { projectRoot, sessionId, featureId },
        taskId,
        record,
      });
      if (w.ok) recordPath = w.path;
    }
    // CONFIG_ERROR: reseta só se a árvore estiver suja em relação ao freeze.
    let worktree = { cleaned: false, hand_quarantine: false };
    if (
      freezeCommitSha &&
      gitResetHard &&
      lsUntracked &&
      removePath &&
      writePath &&
      typeof isDirtyVsFreeze === "function" &&
      isDirtyVsFreeze()
    ) {
      const policy = applyWorktreePolicy(outcome, {
        freezeCommitSha,
        preUntracked: extra.preUntracked ?? new Set(),
        preUntrackedContents: extra.preUntrackedContents ?? new Map(),
        projectRoot,
        gitResetHard,
        lsUntracked,
        removePath,
        writePath,
        isDirtyVsFreeze,
      });
      worktree = policy;
      record.worktree = policy;
      record.hand_quarantine = policy.hand_quarantine;
      if (policy.hand_quarantine === true && featureId && taskId && sessionId) {
        writeQuarantineMarker();
      }
      if (recordPath) {
        writeRecord({ roots: { projectRoot, sessionId, featureId }, taskId, record });
      }
    }
    return { ok: false, outcome, reason, record, recordPath, worktree };
  };

  if (!featureId || !taskId || !sessionId) {
    return failConfig("feature_id, task_id, and session_id are required");
  }
  if (!freezeCommitSha) {
    return failConfig("freeze_commit_sha is required");
  }
  if (!SPAWNABLE_HAND_ROLES.includes(ocRole)) {
    return failConfig(`role ${role}: not a CLI-spawnable hand`);
  }

  // Nega o spawn enquanto o marcador hand_quarantine estiver ativo para esta feature+task.
  if (checkQuarantine()) {
    return failConfig(
      `hand_quarantine active for ${quarantineMarkerKey(featureId, taskId)} — deny spawn until orchestrator clears marker`,
    );
  }

  // Rail de fidelidade: executor-* barrado até fidelity_pass; test-author (produtor) e sniper isentos.
  if (isExecutorHandRole(ocRole)) {
    const fidelityOk =
      typeof checkFidelityPass === "function"
        ? checkFidelityPass({ featureId, taskId, sessionId, projectRoot })
        : defaultHasPiFidelityPass({ projectRoot, sessionId, featureId, taskId });
    if (!fidelityOk) {
      return failConfig(
        `fidelity-pass missing for ${quarantineMarkerKey(featureId, taskId)} — dispatch test-author + compliance fidelity PASS and stamp before executor spawn`,
      );
    }
  }

  // Frontmatter vendorizado é autoritativo para o lockdown da mão.
  const agentAsset = piHandAgentName(role);
  let validation;
  if (readAgent) {
    const md = readAgent(agentAsset);
    if (md == null) {
      return failConfig(`agent ${agentAsset} not found`);
    }
    validation = validatePiHandAgent(md, agentAsset);
  } else {
    validation = loadAndValidatePiHandAgent(resolvedAgentsDir, agentAsset);
  }
  if (!validation.ok) {
    return failConfig(validation.reason);
  }

  // Rota de modelo: só openai-codex/* (assinatura Codex do operador; nunca default Anthropic).
  const resolvedModel = resolvePiHandModel(descriptor?.model);
  if (!resolvedModel.ok) {
    return failConfig(resolvedModel.reason);
  }
  const handModel = resolvedModel.model;

  // Snapshot pré-spawn: all-others (sem --exclude-standard) para que escritas gitignoradas da mão
  // (.env etc.) entrem no set-diff e sejam apagadas no cleanup de não-DONE.
  const ls = lsUntracked ?? (() => defaultLsAllOthers(projectRoot));
  const preSnap = snapshotPreUntracked({ lsUntracked: ls, projectRoot });
  const preUntrackedHashes = new Map(
    [...preSnap.contents.entries()].map(([p, v]) => [p, v.hash]),
  );

  const callId = dispatchCallId();
  const claimed = claimDispatch(
    projectRoot,
    { sessionId, callId, role, taskId, featureId },
    {
      env: dispatchEnvironment,
      isAncestorFn:
        isReviewedShaAncestor ??
        ((sha) => {
          try {
            const status = spawnSync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], {
              cwd: projectRoot,
              stdio: "ignore",
            }).status;
            return status === 0 ? true : status === 1 ? false : null;
          } catch {
            return null;
          }
        }),
    },
  );
  if (!claimed.ok) {
    return failConfig(`dispatch record claim failed: ${claimed.reason}`, {
      preUntracked: preSnap.paths,
      preUntrackedContents: preSnap.contents,
    });
  }
  if (typeof claimed.reviewedSha === "string" && freezeCommitSha !== claimed.reviewedSha) {
    const suppliedFreezeCommitSha = freezeCommitSha;
    freezeCommitSha = claimed.reviewedSha;
    const finished = finishDispatch(projectRoot, { sessionId, callId });
    return failConfig(
      finished.ok
        ? `descriptor freeze sha conflicts with fix-mode authority: ${suppliedFreezeCommitSha}`
        : `descriptor freeze sha conflicts with fix-mode authority and ${finished.reason}`,
      { preUntracked: preSnap.paths, preUntrackedContents: preSnap.contents },
    );
  }
  const dispatchScope = claimed.claim;

  // Spawn do subprocesso (injetável).
  let child;
  try {
    child = await spawn({
      projectDir: projectRoot,
      agent: agentAsset,
      model: handModel,
      prompt: brief,
      descriptor,
      dispatchAuthority: { sessionId, callId },
    });
  } catch (err) {
    const finished = finishDispatch(projectRoot, { sessionId, callId });
    if (!finished.ok) {
      return failConfig(`spawn failed and ${finished.reason}`, {
        preUntracked: preSnap.paths,
        preUntrackedContents: preSnap.contents,
      });
    }
    return failConfig(err instanceof Error ? err.message : "spawn failed", {
      preUntracked: preSnap.paths,
      preUntrackedContents: preSnap.contents,
    });
  }

  // Captura independente.
  const gitAdapter = git ?? realGit(projectRoot);
  const capture = captureHandResult({
    dispatch: {
      scope_paths: dispatchScope.scope_paths,
      frozen_paths: descriptor.frozen_paths ?? [],
      allowed_writes:
        dispatchScope.allowed_writes.length > 0
          ? dispatchScope.allowed_writes
          : dispatchScope.scope_paths,
      no_tests,
    },
    child: {
      exitCode: child?.exitCode ?? 0,
      stdout: child?.stdout ?? "",
      stderr: child?.stderr ?? "",
    },
    freezeCommitSha,
    testPath: descriptor.locked_test ?? descriptor.test_path ?? null,
    no_tests,
    git: gitAdapter,
    testRunner: testRunner ?? ((p) => realTestRunner(p, projectRoot)),
    preUntrackedHashes,
  });

  const outcome = capture.ok ? capture.outcome : capture.outcome ?? OUTCOME.CAPTURE_ERROR;
  const details = capture.ok ? capture.details : { reasons: [capture.reason] };
  const touchedPaths = capture.ok ? capture.child?.touchedPaths ?? [] : [];

  // Política de worktree.
  const resetHard =
    gitResetHard ??
    ((sha) => {
      try {
        const r = spawnSync("git", ["reset", "--hard", sha], { cwd: projectRoot, encoding: "utf8" });
        return r.status === 0 ? { ok: true } : { ok: false, reason: r.stderr || "reset failed" };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : "reset failed" };
      }
    });

  const rem =
    removePath ??
    ((rel) => {
      try {
        const abs = isAbsolute(rel) ? rel : join(projectRoot, rel);
        rmSync(abs, { recursive: true, force: true });
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : "remove failed" };
      }
    });

  const wr =
    writePath ??
    ((rel, bytes) => {
      try {
        const abs = isAbsolute(rel) ? rel : join(projectRoot, rel);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, bytes);
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : "write failed" };
      }
    });

  const dirtyFn =
    isDirtyVsFreeze ??
    (() => {
      try {
        const r = spawnSync("git", ["status", "--porcelain"], { cwd: projectRoot, encoding: "utf8" });
        return (r.stdout ?? "").trim().length > 0;
      } catch {
        return true;
      }
    });

  const worktree = applyWorktreePolicy(outcome, {
    freezeCommitSha,
    preUntracked: preSnap.paths,
    preUntrackedContents: preSnap.contents,
    projectRoot,
    gitResetHard: resetHard,
    lsUntracked: ls,
    removePath: rem,
    writePath: wr,
    isDirtyVsFreeze: dirtyFn,
  });

  if (worktree.hand_quarantine) {
    // Persiste o marcador para que o PRÓXIMO runPiHand desta feature+task seja negado.
    writeQuarantineMarker();
  }

  const record = buildHandRunRecord({
    featureId,
    taskId,
    sessionId,
    freezeCommitSha,
    outcome,
    touchedPaths,
    details,
    agent,
    timestamps: { startedAt, finishedAt: now() },
    hand_quarantine: worktree.hand_quarantine === true,
    worktree,
    producerCallId: callId,
  });

  const written = writeRecord({
    roots: { projectRoot, sessionId, featureId },
    taskId,
    record,
  });

  if (outcome !== OUTCOME.DONE || !written.ok) {
    const finished = finishDispatch(projectRoot, { sessionId, callId });
    if (!finished.ok) {
      return failConfig(finished.reason, {
        preUntracked: preSnap.paths,
        preUntrackedContents: preSnap.contents,
      });
    }
  }

  return {
    ok: outcome === OUTCOME.DONE,
    outcome,
    details,
    child: capture.ok ? capture.child : null,
    record,
    recordPath: written.ok ? written.path : null,
    recordWriteError: written.ok ? null : written.reason,
    worktree,
    // Explícito: o exit code do processo NÃO é o oráculo.
    processExitCode: child?.exitCode,
  };
}

/**
 * @description Autoridade da tool nativa `run_hand`. Espelha createPiMarkerAuthority: `authorize`
 * roda no hook `tool_call` (antes da execução) e é fail-CLOSED; `execute` consome a autorização
 * exatamente uma vez e só então dispara runPiHand. A identidade de sessão vem do RUNTIME
 * (ctx.sessionManager), nunca do descriptor — o campo session_id do descriptor é dica não-confiável.
 * @param {{
 *   projectRoot: string,
 *   readDescriptor?: (path: string) => object|null,
 *   readGateState?: (projectRoot: string, sessionId: string) => Record<string, unknown>,
 *   runHandFn?: (descriptor: object, deps?: object) => Promise<object>,
 *   deps?: object,
 * }} options
 * @returns {{
 *   authorize: (event: { toolName?: unknown, input?: unknown, sessionId?: unknown, toolCallId?: unknown }) =>
 *     undefined | { ok: true } | { ok: false, block: true, reason: string },
 *   execute: (call: { toolCallId?: unknown, sessionId?: unknown }) => Promise<{ ok: boolean, output: string, metadata: Record<string, unknown> }>,
 *   pendingCount: () => number,
 * }}
 */
export function createPiRunHandTool(options = {}) {
  const projectRoot = typeof options?.projectRoot === "string" ? options.projectRoot : "";
  const readDescriptor =
    typeof options?.readDescriptor === "function" ? options.readDescriptor : defaultReadPiDescriptor;
  const readGateState =
    typeof options?.readGateState === "function" ? options.readGateState : readPiGateStateObject;
  const runHandFn = typeof options?.runHandFn === "function" ? options.runHandFn : runPiHand;
  const handDeps = options?.deps ?? {};

  /** Autorizações pendentes, chaveadas pelo toolCallId determinístico do host. */
  const authorizedByCallId = new Map();

  return {
    /**
     * @description Hook `tool_call`: autoriza ou nega uma chamada de `run_hand` antes da execução.
     * Devolve undefined para qualquer outra tool. Descriptor ausente/ilegível/inválido é fail-CLOSED.
     */
    authorize(event) {
      if (event?.toolName !== RUN_HAND_TOOL_NAME) return undefined;
      const deny = (reason) => ({ ok: false, block: true, reason });
      const args = event?.input;
      const descriptorPath =
        args && typeof args === "object" && !Array.isArray(args) && typeof args.descriptor === "string"
          ? args.descriptor
          : "";
      const sessionId = typeof event.sessionId === "string" ? event.sessionId : "";
      const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
      if (!sessionId || !toolCallId) {
        return deny("[entry-gate] Blocked: run_hand dispatch denied — runtime sessionID and callID required.");
      }
      if (authorizedByCallId.has(toolCallId)) {
        return deny("[entry-gate] Blocked: run_hand dispatch denied — call already authorized.");
      }
      let descriptor = null;
      if (descriptorPath) {
        try {
          descriptor = readDescriptor(descriptorPath);
        } catch {
          descriptor = null;
        }
      }
      const decision = decidePiRunHandSpawn({
        descriptorPath,
        descriptor,
        gateState: readGateState(projectRoot, sessionId),
      });
      if (!decision.ok) return deny(decision.reason);
      authorizedByCallId.set(toolCallId, { descriptor: decision.descriptor, sessionId });
      return { ok: true };
    },

    /**
     * @description Corpo da tool `run_hand`: consome a autorização (uma única vez) e dispara a mão
     * com a identidade de sessão do runtime. Sem autorização válida nada é lido nem despachado.
     */
    async execute(call) {
      const toolCallId = typeof call?.toolCallId === "string" ? call.toolCallId : "";
      const sessionId = typeof call?.sessionId === "string" ? call.sessionId : "";
      const entry = toolCallId ? authorizedByCallId.get(toolCallId) : undefined;
      if (toolCallId) authorizedByCallId.delete(toolCallId);
      if (!entry || !sessionId || entry.sessionId !== sessionId) {
        return {
          ok: false,
          output: "run_hand authorization missing, cloned, replayed, or binding-mismatched",
          metadata: {},
        };
      }
      const descriptor = {
        ...entry.descriptor,
        session_id: sessionId,
        project_root: entry.descriptor.project_root ?? entry.descriptor.projectRoot ?? projectRoot,
      };
      const result = await runHandFn(descriptor, handDeps);
      return {
        ok: result?.ok === true,
        output:
          result?.ok === true
            ? `outcome=${result.outcome}`
            : `outcome=${result?.outcome ?? OUTCOME.CONFIG_ERROR}: ${result?.reason ?? (result?.details?.reasons ?? []).join("; ")}`,
        metadata: {
          outcome: result?.outcome ?? OUTCOME.CONFIG_ERROR,
          feature_id: descriptor.feature_id,
          task_id: descriptor.task_id,
          session_id: sessionId,
          record_path: result?.recordPath ?? null,
        },
      };
    },

    /** @description Quantidade de autorizações pendentes (pré-validadas e ainda não executadas). */
    pendingCount() {
      return authorizedByCallId.size;
    },
  };
}

export default {
  RUN_HAND_TOOL_NAME,
  PI_HAND_MODEL_PREFIX,
  PI_HAND_LAUNCHER,
  buildPiRunArgs,
  createPiRunHandTool,
  decidePiRunHandSpawn,
  piHandAgentName,
  resolvePiHandModel,
  runPiHand,
  spawnPiHand,
  validatePiHandAgent,
};
