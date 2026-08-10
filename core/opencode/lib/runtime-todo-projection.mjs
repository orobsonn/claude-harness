/** @description Read the authoritative OC plan/state and derive a best-effort native todo projection. */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { gateStatePath } from "../../shared/lib/path-helpers.mjs";
import { resolvePlannerArtifactPath } from "./planner-artifact.mjs";
import { projectHarnessTodo } from "./todo-projection.mjs";

function isAncestorAtHead(directory, sha) {
  if (!/^[0-9a-f]{7,64}$/i.test(sha)) return false;
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], {
      cwd: directory,
      stdio: "ignore",
      timeout: 2_000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * @description Return only a complete projection. A missing/corrupt plan or state is unavailable,
 * never an empty todo array that could clear OpenCode's visual list.
 */
export function projectRuntimeTodo(projectRoot, sessionID, persistedState) {
  try {
    if (typeof projectRoot !== "string" || !projectRoot || typeof sessionID !== "string" || !sessionID) {
      return { available: false };
    }
    const state = persistedState && typeof persistedState === "object" && !Array.isArray(persistedState)
      ? persistedState
      : (() => {
        const statePath = gateStatePath({ projectRoot, runtime: "opencode", sessionId: sessionID });
        if (!statePath.ok) return null;
        return JSON.parse(fs.readFileSync(statePath.path, "utf8"));
      })();
    if (!state || typeof state !== "object" || Array.isArray(state)) return { available: false };
    const featureId = typeof state.feature_id === "string" ? state.feature_id : "";
    if (!featureId) return { available: false };
    const planPath = resolvePlannerArtifactPath(projectRoot, sessionID, featureId, state.resumed_from_session_id);
    if (!planPath) return { available: false };
    const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
    const ancestry = new Map();
    const isAncestor = (sha) => {
      if (!ancestry.has(sha)) ancestry.set(sha, isAncestorAtHead(projectRoot, sha));
      return ancestry.get(sha);
    };
    return { available: true, todos: projectHarnessTodo(plan, state, { isAncestor }) };
  } catch {
    return { available: false };
  }
}

export default { projectRuntimeTodo };
