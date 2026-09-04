/**
 * @description Observadores da lane Pi (obs-hand / obs-eye / obs-plan-write) numa peça só.
 * TUDO aqui é fail-open: qualquer erro é engolido e nenhum observador jamais bloqueia uma tool.
 *
 * Reuso: toda a lógica pura de evento vem por import de core/opencode/lib/obs-emit.mjs
 * (obsAppend, dedupeByType, eventForEyeRole, eventForHandRan, eventForTaskExecuting,
 * extractTaskIds, isEyeRole, isHandRole, isFullExecutionPlan, taskIndexFromPlan,
 * parseEyeVerdict, bareEyeRole, resolveObsMetaPath) — é host-agnóstica e o outbox vem do env
 * HARNESS_OBSERVABILITY_RUN_PATH, não de um caminho `.opencode`.
 *
 * O registro terminal da mão é o da PRÓPRIA lane Pi: recordPiTaskCompletion de
 * core/pi/lib/entry-gate.mjs (espelho de recordTaskCompletion da lane OC, mas ancorado em
 * `.pi/harness/state/`). O recordTaskCompletion da lane OC NÃO serve aqui: ele resolve
 * dispatch-records e hand-records por path-helpers com runtime 'opencode'.
 *
 * Contraparte própria só onde o OC hardcoda '.opencode': eventForPlanPath → piEventForPlanPath,
 * featureFromPlanPath → piFeatureFromPlanPath, planDirForRun → piPlanDirForRun e
 * fullPlanExistsForRun → piFullPlanExistsForRun, todos ancorados em `.pi/harness/plans/` e
 * `.pi/harness/state/` via core/pi/lib/pi-paths.mjs (NUNCA core/shared/lib/path-helpers.mjs).
 *
 * Papéis do Pi ('harness-executor-high', 'harness-adversary') passam SEMPRE por toOcRole antes
 * de isEyeRole/isHandRole — bareRole do OC não remove o prefixo 'harness-' sozinho.
 */

import { existsSync as fsExistsSync, readFileSync as fsReadFileSync } from "node:fs";

import {
  bareEyeRole,
  dedupeByType,
  eventForEyeRole,
  eventForHandRan,
  eventForTaskExecuting,
  extractTaskIds,
  isEyeRole,
  isFullExecutionPlan,
  isHandRole,
  obsAppend,
  parseEyeVerdict,
  resolveHookArgs,
  resolveObsMetaPath,
  taskIndexFromPlan,
} from "../../opencode/lib/obs-emit.mjs";
import { recordPiTaskCompletion } from "./entry-gate.mjs";
import { piResultText } from "./pi-result-text.mjs";
import {
  isExecutorRole,
  isSniperRole,
  isTestAuthorRole,
  toOcRole,
} from "./pi-adapter-map.mjs";
import { piExecutionPlanPath, piGateStatePath, piPlanDir } from "./pi-paths.mjs";

export {
  bareEyeRole,
  dedupeByType,
  eventForEyeRole,
  eventForHandRan,
  eventForTaskExecuting,
  extractTaskIds,
  isEyeRole,
  isFullExecutionPlan,
  isHandRole,
  obsAppend,
  parseEyeVerdict,
  resolveHookArgs,
  resolveObsMetaPath,
  taskIndexFromPlan,
  piResultText,
};

/**
 * @description Mão que ESCREVE código/teste (executor | sniper | test-author), no vocabulário
 * do Pi ou da lane OC. Espelha o predicado `writingHand` de core/opencode/plugin/obs-hand.ts.
 * Nunca lança.
 * @param {unknown} role
 * @returns {boolean}
 */
export function isPiWritingHand(role) {
  const bare = toOcRole(role);
  return isExecutorRole(bare) || isSniperRole(bare) || isTestAuthorRole(bare);
}

/**
 * @description Contraparte Pi de eventForPlanPath: reconhece escritas em
 * `.pi/harness/plans/<feature>/execution-plan.json` (plan-created) e
 * `.pi/harness/plans/<feature>/spec.md` (spec-created). Caminho `.opencode/...` devolve null —
 * a lane Pi não observa o outro runtime. Nunca lança.
 * @param {unknown} filePath
 * @returns {{ type: string }|null}
 */
export function piEventForPlanPath(filePath) {
  try {
    if (typeof filePath !== "string" || !filePath) return null;
    const norm = filePath.replace(/\\/g, "/");
    const segs = norm.split("/").filter(Boolean).map((s) => s.toLowerCase());
    const pi = segs.indexOf(".pi");
    if (pi === -1 || segs[pi + 1] !== "harness" || segs[pi + 2] !== "plans") return null;
    // Espelha o guard do OC: nada sob um diretório de estado vira evento de plano.
    if (segs[pi + 3] === ".state" || segs[pi + 3] === "state") return null;
    const base = segs[segs.length - 1] || "";
    if (base === "execution-plan.json") return { type: "plan-created" };
    if (base.includes("spec") && (base.endsWith(".md") || base.endsWith(".json"))) {
      return { type: "spec-created" };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * @description Contraparte Pi de featureFromPlanPath: extrai a identidade estável da feature do
 * caminho do plano/spec sob `.pi/harness/plans/`. Nunca lança.
 * @param {unknown} filePath
 * @returns {{ featureId: string }|null}
 */
export function piFeatureFromPlanPath(filePath) {
  try {
    if (typeof filePath !== "string" || !filePath) return null;
    const norm = filePath.replace(/\\/g, "/");
    const match = norm.match(
      /(?:^|\/)\.pi\/harness\/plans\/([a-z0-9][a-z0-9-]{0,80})\/(?:execution-plan\.json|spec\.md)$/i,
    );
    return match ? { featureId: match[1] } : null;
  } catch {
    return null;
  }
}

/**
 * @description Contraparte Pi de planDirForRun: diretório canônico do plano
 * (`.pi/harness/plans/<featureId>`) via piPlanDir. null quando a identidade é insegura.
 * @param {string} projectRoot
 * @param {string} featureId
 * @returns {string|null}
 */
export function piPlanDirForRun(projectRoot, featureId) {
  const resolved = piPlanDir({ projectRoot, featureId });
  return resolved.ok ? resolved.path : null;
}

/**
 * @description Lê feature_id do gate-state da sessão Pi
 * (`.pi/harness/state/<sessionId>/gate-state.json`). "" em qualquer erro — fail-open.
 * @param {string} projectRoot
 * @param {string} sessionId
 * @param {{ existsSync?: typeof fsExistsSync, readFileSync?: typeof fsReadFileSync }} [io]
 * @returns {string}
 */
function featureIdFromGateState(projectRoot, sessionId, io = {}) {
  try {
    const exists = io.existsSync ?? fsExistsSync;
    const read = io.readFileSync ?? fsReadFileSync;
    const resolved = piGateStatePath({ projectRoot, sessionId });
    if (!resolved.ok || !exists(resolved.path)) return "";
    const state = JSON.parse(read(resolved.path, "utf8"));
    return typeof state?.feature_id === "string" ? state.feature_id : "";
  } catch {
    return "";
  }
}

/**
 * @description Feature efetiva de um dispatch: a declarada, com fallback no feature_id do
 * gate-state da sessão Pi. Espelha o helper `featureId()` de obs-hand.ts. "" quando não há.
 * @param {{ projectRoot: string, sessionId: string, featureId?: string|null }} input
 * @param {{ existsSync?: typeof fsExistsSync, readFileSync?: typeof fsReadFileSync }} [io]
 * @returns {string}
 */
export function piFeatureIdForSession(input, io = {}) {
  try {
    const declared = typeof input?.featureId === "string" ? input.featureId : "";
    if (declared) return declared;
    const sessionId = typeof input?.sessionId === "string" ? input.sessionId : "";
    if (!sessionId) return "";
    return featureIdFromGateState(input?.projectRoot, sessionId, io);
  } catch {
    return "";
  }
}

/**
 * @description Contraparte Pi de fullPlanExistsForRun: existe plano cheio (tasks não-vazio) para
 * a feature classificada, sob `.pi/harness/plans/<featureId>/execution-plan.json`. Sem feature,
 * fecha em false — igual ao OC, que prefere spec-adversary a olho errado. Nunca lança.
 * @param {{ projectRoot: string, sessionId?: string|null, featureId?: string|null,
 *   isFull?: (p: string, io?: object) => boolean, existsSync?: typeof fsExistsSync,
 *   readFileSync?: typeof fsReadFileSync }} opts
 * @returns {boolean}
 */
export function piFullPlanExistsForRun(opts) {
  try {
    const {
      projectRoot,
      sessionId,
      featureId,
      isFull = isFullExecutionPlan,
      existsSync: exists = fsExistsSync,
      readFileSync: read = fsReadFileSync,
    } = opts ?? {};
    const fid = piFeatureIdForSession(
      { projectRoot, sessionId, featureId },
      { existsSync: exists, readFileSync: read },
    );
    if (!fid) return false;
    const planPath = piExecutionPlanPath({ projectRoot, featureId: fid });
    if (!planPath.ok || !exists(planPath.path)) return false;
    return isFull(planPath.path, { readFileSync: read }) === true;
  } catch {
    return false;
  }
}

/**
 * @description obs-hand (início): dispatch de mão com taskId emite `task-executing` indexado
 * pelo plano estável do Pi. Sem taskId, sem sessão, sem papel de mão ou sem plano → nada.
 * Devolve o evento emitido (ou null). Nunca lança.
 * @param {{ projectRoot: string, sessionId: string, role: unknown, taskId?: string,
 *   featureId?: string|null }} input
 * @param {{ obsAppend?: typeof obsAppend, existsSync?: typeof fsExistsSync,
 *   readFileSync?: typeof fsReadFileSync }} [deps]
 * @returns {object|null}
 */
export function observePiTaskExecuting(input, deps = {}) {
  try {
    const { projectRoot, sessionId, role, taskId } = input ?? {};
    if (!isHandRole(toOcRole(role))) return null;
    if (typeof sessionId !== "string" || !sessionId) return null;
    if (typeof taskId !== "string" || !taskId) return null;
    const exists = deps.existsSync ?? fsExistsSync;
    const read = deps.readFileSync ?? fsReadFileSync;
    const fid = piFeatureIdForSession(
      { projectRoot, sessionId, featureId: input?.featureId },
      { existsSync: exists, readFileSync: read },
    );
    if (!fid) return null;
    const planPath = piExecutionPlanPath({ projectRoot, featureId: fid });
    if (!planPath.ok || !exists(planPath.path)) return null;
    const indexed = taskIndexFromPlan(planPath.path, taskId, { readFileSync: read });
    const event = indexed ? eventForTaskExecuting(indexed) : null;
    if (!event) return null;
    const append = deps.obsAppend ?? obsAppend;
    append(event, { dedupe: dedupeByType });
    return event;
  } catch {
    /* observação nunca bloqueia */
    return null;
  }
}

/**
 * @description obs-hand (fim): resultado de uma mão que escreve vira registro de conclusão
 * (recordPiTaskCompletion da lane Pi, injetável) e, SÓ quando terminal, emite `hand-ran`. Um
 * dispatch de background ainda em execução não é terminal e não emite. Registro ausente ou
 * nulo fecha em nada emitido, como o `completion.terminal` da lane OC dentro do try/catch.
 * Devolve o evento (ou null). Nunca lança.
 * @param {{ projectRoot: string, sessionId: string, role: unknown, taskId?: string,
 *   featureId?: string|null, model?: string, producerCallId?: string, outputText?: string,
 *   background?: boolean }} input
 * @param {{ obsAppend?: typeof obsAppend, recordCompletion?: typeof recordPiTaskCompletion,
 *   existsSync?: typeof fsExistsSync, readFileSync?: typeof fsReadFileSync }} [deps]
 * @returns {object|null}
 */
export function observePiHandCompletion(input, deps = {}) {
  try {
    const { projectRoot, sessionId, role, taskId, producerCallId } = input ?? {};
    const ocRole = toOcRole(role);
    if (!isHandRole(ocRole) || !isPiWritingHand(role)) return null;
    if (typeof sessionId !== "string" || !sessionId) return null;
    if (typeof producerCallId !== "string" || !producerCallId) return null;
    if (typeof taskId !== "string" || !taskId) return null;
    const fid = piFeatureIdForSession(
      { projectRoot, sessionId, featureId: input?.featureId },
      { existsSync: deps.existsSync ?? fsExistsSync, readFileSync: deps.readFileSync ?? fsReadFileSync },
    );
    if (!fid) return null;
    const record = deps.recordCompletion ?? recordPiTaskCompletion;
    const completion = record({
      projectRoot,
      sessionId,
      featureId: fid,
      taskId,
      role: typeof role === "string" ? role : "",
      producerCallId,
      outputText: String(input?.outputText ?? ""),
      background: input?.background === true,
    });
    if (!completion || completion.terminal === false) return null;
    const model = typeof input?.model === "string" && input.model ? input.model : ocRole;
    const event = eventForHandRan({ task: taskId, model });
    if (!event) return null;
    const append = deps.obsAppend ?? obsAppend;
    append(event, { dedupe: dedupeByType });
    return event;
  } catch {
    /* conclusão observada nunca autoriza nem nega */
    return null;
  }
}

/**
 * @description obs-eye: resultado de um subagente com papel de OLHO (e não de mão) vira o
 * evento de veredito, com planExists resolvido no plano estável do Pi. Mãos ficam com obs-hand.
 * Devolve o evento emitido (ou null). Nunca lança.
 * @param {{ projectRoot: string, sessionId?: string|null, role: unknown,
 *   featureId?: string|null, responseText?: unknown }} input
 * @param {{ obsAppend?: typeof obsAppend, existsSync?: typeof fsExistsSync,
 *   readFileSync?: typeof fsReadFileSync }} [deps]
 * @returns {object|null}
 */
export function observePiEyeVerdict(input, deps = {}) {
  try {
    const { projectRoot, sessionId, role } = input ?? {};
    const ocRole = toOcRole(role);
    if (!isEyeRole(ocRole)) return null;
    if (isHandRole(ocRole)) return null;
    const planExists = piFullPlanExistsForRun({
      projectRoot,
      sessionId: typeof sessionId === "string" ? sessionId : null,
      featureId: input?.featureId || null,
      existsSync: deps.existsSync ?? fsExistsSync,
      readFileSync: deps.readFileSync ?? fsReadFileSync,
    });
    const event = eventForEyeRole(ocRole, input?.responseText, { planExists });
    if (!event) return null;
    const append = deps.obsAppend ?? obsAppend;
    append(event, { dedupe: dedupeByType });
    return event;
  } catch {
    /* fail-open */
    return null;
  }
}

/**
 * @description obs-plan-write: escrita/edição em `.pi/harness/plans/` vira plan-created ou
 * spec-created, com session_id e feature_id anexados e, para plan-created, a contagem de tasks
 * parseada do conteúdo escrito. Devolve o evento emitido (ou null). Nunca lança.
 * @param {{ filePath: unknown, sessionId?: string, content?: unknown }} input
 * @param {{ obsAppend?: typeof obsAppend }} [deps]
 * @returns {object|null}
 */
export function observePiPlanWrite(input, deps = {}) {
  try {
    const filePath = typeof input?.filePath === "string" ? input.filePath : "";
    if (!filePath) return null;
    const event = piEventForPlanPath(filePath);
    if (!event) return null;
    const feature = piFeatureFromPlanPath(filePath);
    const sessionId = typeof input?.sessionId === "string" ? input.sessionId : "";
    if (feature) {
      Object.assign(event, {
        ...(sessionId ? { session_id: sessionId } : {}),
        feature_id: feature.featureId,
      });
    }
    if (event.type === "plan-created") {
      try {
        const parsed = JSON.parse(typeof input?.content === "string" ? input.content : "null");
        if (Array.isArray(parsed?.tasks)) Object.assign(event, { tasks: parsed.tasks.length });
      } catch {
        /* evento permanece factual no nível do caminho */
      }
    }
    const append = deps.obsAppend ?? obsAppend;
    append(event, { dedupe: dedupeByType });
    return event;
  } catch {
    /* fail-open */
    return null;
  }
}

export default {
  isPiWritingHand,
  observePiEyeVerdict,
  observePiHandCompletion,
  observePiPlanWrite,
  observePiTaskExecuting,
  piEventForPlanPath,
  piFeatureFromPlanPath,
  piFeatureIdForSession,
  piFullPlanExistsForRun,
  piPlanDirForRun,
  piResultText,
};
