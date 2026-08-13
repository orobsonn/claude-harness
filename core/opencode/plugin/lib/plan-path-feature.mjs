/** @description Extract a stable OpenCode feature identity from its plan/spec path. */

/**
 * @param {unknown} filePath
 * @returns {{ featureId: string } | null}
 */
export function featureFromPlanPath(filePath) {
  try {
    if (typeof filePath !== "string" || !filePath) return null;
    const norm = filePath.replace(/\\/g, "/");
    const match = norm.match(
      /(?:^|\/)\.opencode\/plans\/([a-z0-9][a-z0-9-]{0,80})\/(?:execution-plan\.json|spec\.md)$/i,
    );
    return match ? { featureId: match[1] } : null;
  } catch {
    return null;
  }
}

export default { featureFromPlanPath };
