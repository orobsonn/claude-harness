/**
 * @description Plan-gate da lane Pi — plano estável obrigatório antes de dispatch downstream.
 * Porte 1:1 de core/opencode/plugin/plan-gate.ts: mesma sequência de checagens, mesmas mensagens
 * `[plan-gate] denied: …`, mesmo fail-closed. A decisão pura sobre o plano (decidePlanGate /
 * throwIfPlanDenied / validatePlan) é REUSADA por import da lane OC, sem cópia. A única diferença
 * é a raiz de caminho: `.pi/harness/state|plans/` via core/pi/lib/pi-paths.mjs (NUNCA
 * core/shared/lib/path-helpers.mjs, que só conhece `.claude`/`.opencode`).
 *
 * Diferenças estruturais de host, deliberadas:
 * - O Pi não tem "runtime envelope" no evento de tool: a identidade de sessão confiável vem de
 *   ctx.sessionManager.getSessionId() (piSessionId), passada aqui como `sessionId`. Sem ela,
 *   nega com a mesma mensagem do OC ('trusted session identity required').
 * - Sem envelope, feature_id/task_id vindos dos args do dispatch são SEMPRE não-confiáveis; o
 *   marcador HARNESS_TASK_CONTEXT do prompt continua sendo a âncora do task_id (fail-closed em
 *   divergência, como resolveHookIdentity do OC).
 * - Nunca muta o prompt: o brief é o transporte do modelo.
 */

import fs from "node:fs";

import { decidePlanGate, throwIfPlanDenied } from "../../opencode/plugin/lib/plan-decide.mjs";
import { parseTaskDispatchIdentity } from "../../opencode/lib/task-dispatch-identity.mjs";
import {
  isExecutorRole,
  isPiDispatchTool,
  isPlanReviewerRole,
  isSniperRole,
  isTestAuthorRole,
  piSubagentArgs,
  toOcRole,
} from "./pi-adapter-map.mjs";
import { piExecutionPlanPath, piGateStatePath } from "./pi-paths.mjs";

const PREFIX = "[plan-gate]";
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * @description Papéis guardados pelo plan-gate (mesmo conjunto do OC): plan-reviewer, test-author,
 * executor e sniper. Recebe o papel BARE já traduzido por toOcRole. Nunca lança.
 * @param {string} role
 * @returns {boolean}
 */
export function isPlanGuardedRole(role) {
  return (
    isPlanReviewerRole(role) ||
    isTestAuthorRole(role) ||
    isExecutorRole(role) ||
    isSniperRole(role)
  );
}

/**
 * @description Lê um JSON de disco exigindo objeto puro. Espelha readJsonObject do plan-gate.ts:
 * as reasons 'missing' | 'unreadable' | 'invalid object' são load-bearing (entram na mensagem de
 * negação). Nunca lança.
 * @param {string} filePath
 * @returns {{ ok: true, value: Record<string, unknown> } | { ok: false, reason: string }}
 */
export function readJsonObject(filePath) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? { ok: true, value }
      : { ok: false, reason: "invalid object" };
  } catch (error) {
    return { ok: false, reason: error?.code === "ENOENT" ? "missing" : "unreadable" };
  }
}

/**
 * @description Extrai feature_id/task_id OPCIONAIS dos args do dispatch (flat e aninhado em
 * `input`), como dispatchIds do plan-gate.ts. No Pi esses campos não fazem parte do schema da tool
 * `subagent`, mas um dispatcher pode carimbá-los — por isso continuam sendo conferidos contra o
 * plano estável. Sempre não-confiáveis. Nunca lança.
 *
 * PRECEDÊNCIA É LOAD-BEARING: vence o PRIMEIRO alias NÃO-VAZIO (após trim), nunca o primeiro alias
 * presente. É a semântica de aliasValues/oneIdentity do OC (core/opencode/plugin/lib/hook-identity.mjs),
 * que é quem manda no OC nas duas checagens que dependem daqui (conflito de feature e divergência
 * de taskId contra o marcador). Com `??`, um alias vazio (`taskId: ""`) esconderia um alias
 * divergente logo atrás (`task: "task-9"`) e a checagem anti-lavagem abriria — fail-open que o OC
 * não tem.
 * @param {unknown} args
 * @returns {{ featureId: string, taskId: string }}
 */
export function dispatchIds(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return { featureId: "", taskId: "" };
  const record = /** @type {Record<string, unknown>} */ (args);
  const nested =
    record.input && typeof record.input === "object" && !Array.isArray(record.input)
      ? /** @type {Record<string, unknown>} */ (record.input)
      : {};
  const firstNonEmpty = (...values) => {
    for (const value of values) {
      if (typeof value === "string" && value.trim().length > 0) return value.trim();
    }
    return "";
  };
  return {
    featureId: firstNonEmpty(
      record.feature_id, record.featureId, record.feature,
      nested.feature_id, nested.featureId, nested.feature,
    ),
    taskId: firstNonEmpty(record.taskId, record.task, nested.taskId, nested.task),
  };
}

/** @description Monta a negação com o prefixo canônico da lane OC. */
function deny(reason) {
  return { block: true, reason: `${PREFIX} denied: ${reason}` };
}

/**
 * @description Decisão do plan-gate para um `tool_call` do Pi. Pura no sentido de não mutar nada do
 * host (só LÊ gate-state e plano estável de disco) e nunca lançar. Dispatches que não são de
 * subagente, ou cujo papel não é guardado, passam SEM tocar disco.
 * @param {{ projectRoot?: unknown, sessionId?: unknown, toolName?: unknown, input?: unknown }} event
 * @param {{ validatePlanFn?: (plan: unknown, options: unknown) => { ok: boolean, errors: string[] } }} [deps]
 * @returns {{ block: false, warn?: string } | { block: true, reason: string }}
 */
export function decidePiPlanGate(event = {}, deps = {}) {
  try {
    if (!isPiDispatchTool(event.toolName)) return { block: false };
    const args = piSubagentArgs(event.input);
    const role = toOcRole(args.subagent_type);
    if (!isPlanGuardedRole(role)) return { block: false };

    const ids = dispatchIds(event.input);
    const marker = parseTaskDispatchIdentity(args.prompt);
    // Divergência entre o marcador do brief e o task_id dos args desacopla os gates de fidelidade
    // do que a mão foi realmente briefada a fazer — fail-closed antes de qualquer leitura de disco,
    // na mesma posição em que resolveHookIdentity nega no OC.
    if (marker.ok && TASK_ID.test(marker.taskId) && ids.taskId && ids.taskId !== marker.taskId) {
      return deny(
        `taskId dispatch args diverge from the brief's HARNESS_TASK_CONTEXT marker: ${ids.taskId} != ${marker.taskId}`,
      );
    }

    // Identidade de sessão: no Pi só existe a do runtime (ctx.sessionManager), sempre confiável.
    const sessionId = typeof event.sessionId === "string" ? event.sessionId : "";
    if (!sessionId) return deny("trusted session identity required");

    const projectRoot = typeof event.projectRoot === "string" ? event.projectRoot : "";
    const stateResolved = piGateStatePath({ projectRoot, sessionId });
    if (!stateResolved.ok) return deny(stateResolved.reason);
    const stateRead = readJsonObject(stateResolved.path);
    if (!stateRead.ok) return deny(`gate-state ${stateRead.reason}`);
    const state = stateRead.value;
    if (state.session_id !== sessionId || state.classified !== true) {
      return deny("classified session identity mismatch");
    }
    const featureId = typeof state.feature_id === "string" ? state.feature_id : "";
    const mode = typeof state.mode === "string" ? state.mode : "";
    if (!featureId || !["LIGHT", "FULL"].includes(mode)) {
      return deny("classified LIGHT/FULL feature required");
    }

    const planResolved = piExecutionPlanPath({ projectRoot, featureId });
    if (!planResolved.ok) return deny(planResolved.reason);
    const planRead = readJsonObject(planResolved.path);
    if (!planRead.ok) return deny(`stable plan ${planRead.reason}`);

    const plan = planRead.value;
    if (plan.final_review?.security !== undefined && typeof plan.final_review.security !== "boolean") {
      return deny("final_review.security must be a boolean when present");
    }
    const decision = decidePlanGate(
      { plan, expect: "full", expectedModelStrategy: plan.model_strategy },
      { validatePlanFn: deps.validatePlanFn },
    );
    let warn;
    if (decision.decision === "warn") warn = `${PREFIX} ${decision.reason}`;
    try {
      throwIfPlanDenied(decision);
    } catch (error) {
      return { block: true, reason: error instanceof Error ? error.message : `${PREFIX} denied` };
    }

    if (plan.feature_id !== featureId) return deny("stable plan feature mismatch");
    const expectedPlanMode = mode.toLowerCase();
    if (plan.mode !== expectedPlanMode) {
      return deny(`stable plan mode mismatch (${String(plan.mode)} != ${expectedPlanMode})`);
    }

    if (ids.featureId && ids.featureId !== featureId) {
      return deny("dispatch feature_id conflicts with stable plan feature");
    }

    const requiresTaskId = isTestAuthorRole(role) || isExecutorRole(role) || isSniperRole(role);
    if (requiresTaskId && !marker.ok) {
      return deny(`${role} ${String(marker?.reason ?? "task prompt marker missing")}`);
    }

    const taskId = marker.ok ? marker.taskId : ids.taskId;
    const tasks = Array.isArray(plan.tasks) ? plan.tasks : [];
    const task = taskId ? tasks.find((candidate) => candidate?.id === taskId) : null;
    if (taskId && !task) {
      return deny("dispatch task_id does not exist in stable plan");
    }
    if (requiresTaskId) {
      const declaredComplexity = typeof event.input?.complexity === "string" ? event.input.complexity : "";
      const plannedComplexity = typeof task?.complexity === "string" ? task.complexity : "";
      const inherited = isTestAuthorRole(role) && event.input?.complexity === undefined;
      if (!["low", "medium", "high", "max"].includes(plannedComplexity) || (!inherited && declaredComplexity !== plannedComplexity)) {
        return deny(`dispatch complexity conflicts with stable plan task (${declaredComplexity || "(missing)"} != ${plannedComplexity || "(missing)"})`);
      }
      if (isTestAuthorRole(role)) return { block: false, complexity: plannedComplexity, ...(warn ? { warn } : {}) };
    }

    // Deliberadamente NÃO muta args.prompt: o brief é o transporte do modelo.
    return warn ? { block: false, warn } : { block: false };
  } catch (error) {
    // Falha interna inesperada é fail-closed: um plan-gate que "abre no erro" é um gate satisfazível.
    return deny(error instanceof Error ? error.message : "plan-gate failed internally");
  }
}

export default { decidePiPlanGate, dispatchIds, isPlanGuardedRole, readJsonObject };
