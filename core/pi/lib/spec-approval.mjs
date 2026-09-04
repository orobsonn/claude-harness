/** @description Artefato e selo de revisão adversarial da spec na lane Pi.
 * A tool do runtime é a única escritora de spec.md; prosa do modelo não cria um selo. O selo
 * ainda não é isolamento de SO: um processo do mesmo usuário pode adulterar arquivos locais. */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { isSafeFeatureId, isSafeSessionId } from "../../shared/lib/feature-id.mjs";
import { withGateStateLock } from "../../opencode/lib/gate-state.mjs";
import { piGateStatePath, piSpecPath } from "./pi-paths.mjs";

const MAX_SPEC_BYTES = 256 * 1024;
const SPEC_RESET_KEYS = [
  "brainstormed", "adversary_fired", "adversary_completion_evidence", "adversary_spec_sha256",
  "reviewed_spec_sha256", "reviewed_at",
];

function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function validContext(context) {
  const projectRoot = typeof context?.projectRoot === "string" ? context.projectRoot : "";
  const sessionId = typeof context?.sessionId === "string" ? context.sessionId : "";
  if (!projectRoot) return { ok: false, reason: "projectRoot required" };
  if (!isSafeSessionId(sessionId)) return { ok: false, reason: "safe sessionId required" };
  const statePath = piGateStatePath({ projectRoot, sessionId });
  if (!statePath.ok) return statePath;
  let state;
  try { state = JSON.parse(fs.readFileSync(statePath.path, "utf8")); } catch { return { ok: false, reason: "gate-state missing or unreadable" }; }
  if (!state || typeof state !== "object" || Array.isArray(state) || state.session_id !== sessionId) {
    return { ok: false, reason: "classified runtime identity required" };
  }
  const featureId = typeof state.feature_id === "string" ? state.feature_id : "";
  if (!isSafeFeatureId(featureId)) return { ok: false, reason: "safe feature_id required" };
  const mode = typeof state.mode === "string" ? state.mode.toLowerCase() : "";
  if (mode !== "light" && mode !== "full") return { ok: false, reason: "LIGHT or FULL ceremony required" };
  const specPath = piSpecPath({ projectRoot, featureId });
  if (!specPath.ok) return specPath;
  return { ok: true, projectRoot, sessionId, statePath: statePath.path, state, featureId, specPath: specPath.path };
}

function readSpec(pathname) {
  try {
    const content = fs.readFileSync(pathname, "utf8");
    if (!content.trim()) return { ok: false, reason: "canonical spec is empty" };
    return { ok: true, content, sha256: sha256(content) };
  } catch { return { ok: false, reason: "canonical spec missing or unreadable" }; }
}

/** @description Lê somente uma draft cujo hash ainda corresponde ao gate-state. */
export function readPiSpecDraft(context = {}) {
  const resolved = validContext(context);
  if (!resolved.ok) return resolved;
  const current = readSpec(resolved.specPath);
  if (!current.ok) return current;
  if (resolved.state.spec_status !== "draft" || resolved.state.spec_sha256 !== current.sha256) {
    return { ok: false, reason: "current canonical spec draft required" };
  }
  return { ok: true, ...resolved, sha256: current.sha256 };
}

/** @description Confere o selo da revisão adversarial contra os bytes atuais. */
export function readPiSpecApproval(context = {}) {
  const resolved = validContext(context);
  if (!resolved.ok) return resolved;
  const current = readSpec(resolved.specPath);
  if (!current.ok) return current;
  if (resolved.state.spec_status !== "adversary-reviewed") return { ok: false, reason: "current adversary-reviewed spec required" };
  if (resolved.state.reviewed_spec_sha256 !== current.sha256) {
    return { ok: false, reason: "reviewed spec hash no longer matches canonical spec" };
  }
  if (resolved.state.adversary_fired !== true || resolved.state.adversary_spec_sha256 !== current.sha256) {
    return { ok: false, reason: "current spec adversary review required" };
  }
  return { ok: true, ...resolved, sha256: current.sha256 };
}

/** @description Persiste uma draft por escrita atômica e invalida TODOS os fatos dependentes dela. */
export function writePiSpecDraft(input = {}, context = {}) {
  if (context?.isChild === true) return { ok: false, reason: "spec draft is restricted to the parent orchestrator" };
  const content = typeof input?.content === "string" ? input.content : "";
  if (!content.trim()) return { ok: false, reason: "spec content required" };
  if (Buffer.byteLength(content, "utf8") > MAX_SPEC_BYTES) return { ok: false, reason: "spec content exceeds 256 KiB" };
  const resolved = validContext(context);
  if (!resolved.ok) return resolved;
  const digest = sha256(content);
  try {
    fs.mkdirSync(path.dirname(resolved.specPath), { recursive: true });
    const temporary = `${resolved.specPath}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, resolved.specPath);
  } catch { return { ok: false, reason: "canonical spec persistence failed" }; }
  const persisted = withGateStateLock(resolved.statePath, (previous) => {
    if (previous?.session_id !== resolved.sessionId || previous?.feature_id !== resolved.featureId) {
      return { ok: false, reason: "gate-state identity changed before spec persistence" };
    }
    const next = { ...previous, spec_status: "draft", spec_sha256: digest };
    for (const key of SPEC_RESET_KEYS) delete next[key];
    return next;
  });
  return persisted?.ok ? { ok: true, sha256: digest, feature_id: resolved.featureId, path: resolved.specPath } :
    { ok: false, reason: String(persisted?.reason ?? "gate-state persistence failed") };
}

/** @description Sela a draft já revisada pelo adversary. Funciona igual em TUI e headless. */
export async function approvePiSpec(context = {}) {
  if (context?.isChild === true) return { ok: false, reason: "spec approval is restricted to the parent orchestrator" };
  const resolved = validContext(context);
  if (!resolved.ok) return resolved;
  const current = readSpec(resolved.specPath);
  if (!current.ok) return current;
  if (resolved.state.spec_status !== "draft" || resolved.state.spec_sha256 !== current.sha256) {
    return { ok: false, code: "SPEC_DRAFT_REQUIRED", reason: "current canonical spec draft required" };
  }
  if (resolved.state.adversary_fired !== true || resolved.state.adversary_spec_sha256 !== current.sha256) {
    return { ok: false, code: "ADVERSARY_REVIEW_REQUIRED", reason: "current spec adversary review required before review seal" };
  }
  const persisted = withGateStateLock(resolved.statePath, (previous) => {
    if (previous?.session_id !== resolved.sessionId || previous?.feature_id !== resolved.featureId) {
      return { ok: false, reason: "gate-state identity changed before spec review seal" };
    }
    const latest = readSpec(resolved.specPath);
    if (!latest.ok || latest.sha256 !== current.sha256 || previous.spec_status !== "draft" || previous.spec_sha256 !== current.sha256 || previous.adversary_fired !== true || previous.adversary_spec_sha256 !== current.sha256) {
      return { ok: false, reason: "spec changed or lost current adversary review before seal" };
    }
    return { ...previous, spec_status: "adversary-reviewed", reviewed_spec_sha256: current.sha256, reviewed_at: new Date().toISOString() };
  });
  return persisted?.ok ? { ok: true, feature_id: resolved.featureId, sha256: current.sha256, path: resolved.specPath } :
    { ok: false, reason: String(persisted?.reason ?? "gate-state persistence failed") };
}

export default { writePiSpecDraft, approvePiSpec, readPiSpecDraft, readPiSpecApproval };
