/** @description Persist a fail-closed classify reset before replacing its stub; never rolls plan bytes back. */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { mergeGateState as defaultMergeGateState } from "../../plugin/lib/gate-state.mjs";

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  try {
    fs.writeFileSync(temp, content);
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch { /* ignore */ }
    throw error;
  }
}

/** @description Persist blocked reset, replace stub, then mark classify ready; no failure path rewrites the plan. */
export function persistClassifyArtifacts(input, deps = {}) {
  const mergeGateState = deps.mergeGateState ?? defaultMergeGateState;
  const writePlan = deps.writePlan ?? atomicWrite;
  const pending = mergeGateState(input.statePath, {
    ...input.statePatch,
    classified: false,
    classify_status: "stub_pending",
    delivery_status: "delivery-blocked",
  });
  if (!pending?.ok) {
    return { ok: false, reason: `gate-state persistence failed: ${String(pending?.reason ?? "unknown")}` };
  }
  try {
    writePlan(input.planPath, `${JSON.stringify(input.stub, null, 2)}\n`);
  } catch (error) {
    return { ok: false, reason: `plan write failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  const finalized = mergeGateState(input.statePath, {
    ...input.statePatch,
    classified: true,
    classify_status: "ready",
  });
  if (!finalized?.ok) {
    return { ok: false, reason: `gate-state finalize failed: ${String(finalized?.reason ?? "unknown")}` };
  }
  return { ok: true, state: finalized.state };
}

export default { persistClassifyArtifacts };
