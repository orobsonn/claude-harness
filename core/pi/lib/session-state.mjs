/**
 * @description Recuperação de contexto na compactação — lane Pi. Espelho de
 * `core/opencode/plugin/lib/session-state.mjs`: o encoder (`encodeRecoveryPayload`) e o teto de
 * bytes (`MAX_REINJECT_BYTES`) são PUROS e reusados por import — mesmos delimitadores
 * `<HARNESS_RECOVERY_JSON>`, mesmo schema `harness.compaction-recovery.v1`, mesma truncagem
 * binária UTF-8 segura e mesmo shell `{truncated:true,truncated_json_prefix}`.
 *
 * A única peça própria é `buildPiSessionRecovery`, porque a contraparte OC chama
 * `path-helpers.mjs` com `runtime:'opencode'` (que só conhece `.claude`/`.opencode`). Aqui o
 * caminho vem exclusivamente de `core/pi/lib/pi-paths.mjs`, com raiz `.pi/harness/`. As reasons,
 * a semântica de identidade (gate-state da MESMA sessão) e o payload são idênticos à lane OC.
 *
 * `readSafeJson` é copiada de propósito (~20 linhas): ela é a barreira de leitura (path
 * traversal, symlink em qualquer segmento, teto de tamanho) e não é exportada pela lane OC.
 */

import fs from "node:fs";
import path from "node:path";

import { isSafeFeatureId, isSafeSessionId } from "../../shared/lib/feature-id.mjs";
import { validatePlan } from "../../shared/lib/validate-plan.mjs";
import { piExecutionPlanPath, piGateStatePath } from "./pi-paths.mjs";
import { taskRegistryPath } from "./task-contract.mjs";

import { encodeRecoveryPayload, MAX_REINJECT_BYTES } from "../../opencode/plugin/lib/session-state.mjs";

// Reexportados sem cópia: são os MESMOS símbolos puros da lane OC.
export { encodeRecoveryPayload, MAX_REINJECT_BYTES };

/** Modos de ceremony aceitos no gate-state — idênticos à lane OC. */
const RECOVERABLE_MODES = ["no-ceremony", "QUICK", "LIGHT", "FULL"];

/**
 * @description Verdadeiro quando `candidate` está dentro de (ou é) `parent`. Cópia da lane OC.
 * @param {string} parent
 * @param {string} candidate
 * @returns {boolean}
 */
function inside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/**
 * @description Lê JSON sob a raiz do projeto recusando traversal, symlink em qualquer segmento,
 * arquivo vazio/gigante e valor não-objeto. Barreira de leitura — nunca lança, devolve null.
 * @param {string} projectRoot
 * @param {string} file
 * @param {number} [maxBytes]
 * @returns {Record<string, unknown> | null}
 */
function readSafeJson(projectRoot, file, maxBytes = 1024 * 1024) {
  try {
    const root = fs.realpathSync(projectRoot);
    const resolved = path.resolve(file);
    if (!inside(root, resolved)) return null;
    const relative = path.relative(root, resolved);
    let cursor = root;
    for (const segment of relative.split(path.sep)) {
      cursor = path.join(cursor, segment);
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink()) return null;
    }
    const stat = fs.statSync(resolved);
    if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes || fs.realpathSync(resolved) !== resolved) return null;
    const value = JSON.parse(fs.readFileSync(resolved, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * @description Monta o payload de recuperação da compactação com fatos DESTA sessão apenas —
 * nunca infere fase nem adota a corrida de outra sessão. Lê o gate-state em
 * `.pi/harness/state/<sessionId>/gate-state.json` (exigindo `session_id === sessionId`) e o plano
 * estável em `.pi/harness/plans/<featureId>/execution-plan.json`. Nunca lança; nunca escreve.
 * @param {string} projectRoot
 * @param {string} sessionId
 * @returns {{ ok: true, context: string, statePath: string } | { ok: false, reason: string }}
 */
export function buildPiSessionRecovery(projectRoot, sessionId) {
  if (!projectRoot || !isSafeSessionId(sessionId)) return { ok: false, reason: "invalid session identity" };
  // A lane OC entrega a raiz JÁ canonicalizada (resolveSessionProjectRoot faz realpathSync antes
  // de qualquer leitura); no Pi o `ctx.cwd` chega cru. Sem canonicalizar aqui, uma raiz atravessada
  // por symlink (o clássico /tmp → /private/tmp no macOS) faria `readSafeJson` — que realpath a
  // raiz internamente — recusar TODO arquivo por "fora da raiz", e a recuperação sumiria em
  // silêncio. Raiz ilegível equivale à raiz ausente da OC (lá o hook nem chama o builder).
  let root;
  try {
    root = fs.realpathSync(projectRoot);
  } catch {
    return { ok: false, reason: "invalid session identity" };
  }
  const stateResult = piGateStatePath({ projectRoot: root, sessionId });
  if (!stateResult.ok) return stateResult;
  const state = readSafeJson(root, stateResult.path);
  if (!state || state.session_id !== sessionId) return { ok: false, reason: "gate-state session identity mismatch" };

  const featureId = state.feature_id;
  const mode = state.mode;
  if (!isSafeFeatureId(featureId) || !RECOVERABLE_MODES.includes(mode)) {
    return { ok: false, reason: "invalid recovery identity" };
  }

  const planResult = piExecutionPlanPath({ projectRoot: root, featureId });
  if (!planResult.ok) return planResult;
  const plan = readSafeJson(root, planResult.path);
  const validated = plan ? validatePlan(plan, { expect: "full" }) : { ok: false };
  const matchingPlan = validated.ok && plan.feature_id === featureId && String(plan.mode).toUpperCase() === mode;
  const totalTasks = matchingPlan && Array.isArray(plan.tasks) ? plan.tasks.length : 0;
  const canonicalRelativePath = path.relative(root, planResult.path);
  let taskPipeline;
  if (state.task_pipeline_version === 1) {
    if (state.task_run) {
      taskPipeline = { kind: "task", task_id: state.task_run.task_id,
        attempt_id: state.task_run.attempt_id, parent_session_id: state.task_run.parent_session_id,
        observation: "Continue this admitted task pipeline; do not restart global ceremony." };
    } else {
      const registry = readSafeJson(root, taskRegistryPath(root, sessionId));
      const valid = registry?.version === 1 && registry.parent_session_id === sessionId && registry.feature_id === featureId;
      taskPipeline = { kind: "global", handles: valid ? Object.values(registry.tasks ?? {}).map((entry) => ({
        task_id: entry.task_id, attempt_id: entry.attempt_id, status: entry.status,
      })) : [], observation: "These are recorded handles, not fresh completion evidence. Use harness_tasks status; do not redispatch existing tasks." };
    }
  }
  const context = encodeRecoveryPayload({
    schema: "harness.compaction-recovery.v1",
    mode,
    feature_id: featureId,
    canonical_plan_path: canonicalRelativePath,
    plan_available: matchingPlan,
    total_tasks: totalTasks,
    ...(taskPipeline ? { task_pipeline: taskPipeline } : {}),
  });
  if (!context) return { ok: false, reason: "recovery payload byte budget too small" };
  return { ok: true, context, statePath: stateResult.path };
}

export default { buildPiSessionRecovery, encodeRecoveryPayload };
