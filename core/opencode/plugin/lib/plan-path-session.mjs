/** @description Extract sessionId from OC plan/spec paths. Pure. Never throws. */

/**
 * @description Match `.opencode/plans/<sessionId>-<featureId>/execution-plan.json` (or spec.md).
 * @param {unknown} filePath
 * @returns {{ sessionId: string, featureId: string } | null}
 */
export function sessionFeatureFromPlanPath(filePath) {
  try {
    if (typeof filePath !== "string" || !filePath) return null;
    const norm = filePath.replace(/\\/g, "/");
    // sessionId = ses_ + alnum/._ (no hyphen) so first "-" after ses_ splits featureId (kebab).
    const m = norm.match(
      /(?:^|\/)\.opencode\/plans\/(ses_[A-Za-z0-9._]{1,128})-([a-z0-9][a-z0-9-]{0,80})\/(?:execution-plan\.json|spec\.md)$/i,
    );
    if (!m) return null;
    return { sessionId: m[1], featureId: m[2] };
  } catch {
    return null;
  }
}

export default { sessionFeatureFromPlanPath };
