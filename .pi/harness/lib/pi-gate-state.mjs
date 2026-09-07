/**
 * @description Gate-state para a lane Pi. Reusa por import TODA a lógica de lock/merge/leitura
 * de core/opencode/lib/gate-state.mjs (host-agnóstico, statePath explícito) sem cópia — a ÚNICA
 * peça própria desta lib é loadPiGateStateFromDisk, que hardcoda a raiz `.pi/harness/state/`
 * (espelho de loadGateStateFromDisk, que hardcoda `.opencode/plans/.state`). Caminho vem de
 * piGateStatePath (core/pi/lib/pi-paths.mjs), nunca de path-helpers.mjs (que só conhece
 * `.claude`/`.opencode`).
 */

import fs from "node:fs";

import { piGateStatePath } from "./pi-paths.mjs";

export {
  acquireLock,
  releaseLock,
  compareAndDeleteLock,
  readLockFile,
  isPidAlive,
  readGateState,
  writeGateStateAtomic,
  mergeGateState,
  withGateStateLock,
  lockPathFor,
  LOCK_STALE_MS,
  LOCK_TIMEOUT_MS,
  isSafeSessionIdSegment,
} from "../vendor/opencode/lib/gate-state.mjs";

/**
 * @description Carrega gate-state.json de disco sob `.pi/harness/state/<sessionId>/gate-state.json`.
 * Exige sessionId explícito e seguro; Result fail-closed em erro de leitura/parse, nunca lança.
 * Ramo a ramo idêntico a loadGateStateFromDisk (lane OC), inclusive o fallback para process.cwd()
 * quando projectRoot vem vazio: arquivo ausente = estado vazio (ceremony ainda não classificada,
 * não falha de infra); parse/leitura quebrada = `gate-state-unreadable: <msg>`; JSON válido que
 * não é objeto = `gate-state invalid JSON object at <p>`. Os prefixos 'gate-state' das reasons
 * são load-bearing — o entry-gate distingue fail-open (reason começa com 'gate-state') de
 * fail-closed de identidade (ex.: 'unsafe sessionId').
 * @param {string} projectRoot
 * @param {{ sessionId?: string | null }} [opts]
 * @returns {{ ok: true, state: unknown, path: string } | { ok: false, reason: string }}
 */
export function loadPiGateStateFromDisk(projectRoot, opts = {}) {
  try {
    const root =
      typeof projectRoot === "string" && projectRoot.length > 0
        ? projectRoot
        : process.cwd();
    if (typeof root !== "string" || root.length === 0) {
      return { ok: false, reason: "projectRoot missing" };
    }
    const sessionId = opts.sessionId;

    /**
     * @description Lê e valida o gate-state.json do caminho já resolvido. Nunca lança.
     * @param {string} p
     */
    function readStateFile(p) {
      try {
        if (!fs.existsSync(p)) {
          // Arquivo ausente = ceremony vazia (ainda não classificada), não falha de infra.
          return { ok: true, state: {}, path: p };
        }
        const raw = fs.readFileSync(p, "utf8");
        const state = JSON.parse(raw);
        if (state == null || typeof state !== "object" || Array.isArray(state)) {
          return { ok: false, reason: `gate-state invalid JSON object at ${p}` };
        }
        return { ok: true, state, path: p };
      } catch (err) {
        return {
          ok: false,
          reason:
            err instanceof Error
              ? `gate-state-unreadable: ${err.message}`
              : "gate-state-unreadable",
        };
      }
    }

    if (sessionId != null && sessionId !== "") {
      const resolved = piGateStatePath({ projectRoot: root, sessionId });
      if (!resolved.ok) {
        // pi-paths só devolve reason de identidade; 'invalid sessionId' vira a reason da lane OC.
        return {
          ok: false,
          reason:
            resolved.reason === "invalid sessionId" ? "unsafe sessionId" : resolved.reason,
        };
      }
      return readStateFile(resolved.path);
    }
    return { ok: false, reason: "sessionId required for deterministic gate-state load" };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "loadPiGateStateFromDisk failed",
    };
  }
}
