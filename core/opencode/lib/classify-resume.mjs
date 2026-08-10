/** @description Recover the deterministic classification response for an already-adopted approved plan. */

import fs from "node:fs";
import path from "node:path";
import { isSafeFeatureId, isSafeSessionId } from "../../shared/lib/feature-id.mjs";

/** @description Return resumed delivery metadata only when its canonical plan remains present. */
export function resumedApprovedPlanMetadata(projectRoot, featureId, prior) {
  if (!isSafeFeatureId(featureId) || !prior || typeof prior !== "object" ||
      !isSafeSessionId(prior.resumed_from_session_id) || prior.planner_status !== "usable" ||
      prior.plan_review_verdict !== "APPROVE" || (prior.mode !== "LIGHT" && prior.mode !== "FULL")) return null;
  const planPath = path.join(projectRoot, ".opencode", "plans", `${prior.resumed_from_session_id}-${featureId}`, "execution-plan.json");
  if (!fs.existsSync(planPath)) return null;
  return {
    plan_path: planPath,
    mode: prior.mode,
    feature_id: featureId,
    action: "resume-approved-plan",
    source_session_id: typeof prior.resume_state_source_session_id === "string"
      ? prior.resume_state_source_session_id
      : prior.resumed_from_session_id,
  };
}

export default { resumedApprovedPlanMetadata };
