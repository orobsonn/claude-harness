/**
 * @description Pure absolution matching for regate_passed / capture_verified.
 * No fs, no runtime path hardcode. Clear only prefix@sha + isAncestorFn(sha)===true.
 */

/**
 * @param {unknown} entry
 * @returns {{ prefix: string, sha: string } | null}
 */
export function parseAbsolutionEntry(entry) {
  if (typeof entry !== "string") return null;
  const at = entry.lastIndexOf("@");
  if (at <= 0 || at >= entry.length - 1) return null;
  return { prefix: entry.slice(0, at), sha: entry.slice(at + 1) };
}

/**
 * @param {unknown} entry
 * @returns {string}
 */
export function absolutionPrefix(entry) {
  if (typeof entry !== "string") return "";
  const at = entry.lastIndexOf("@");
  return at > 0 ? entry.slice(0, at) : entry;
}

/**
 * @param {string} pendingId
 * @param {unknown} absolutionArray
 * @param {(sha: string) => boolean|null} isAncestorFn
 * @returns {boolean}
 */
export function matchesAbsolution(pendingId, absolutionArray, isAncestorFn) {
  if (!Array.isArray(absolutionArray)) return false;
  for (const entry of absolutionArray) {
    const parsed = parseAbsolutionEntry(entry);
    if (parsed === null) continue;
    if (parsed.prefix !== pendingId) continue;
    let ancestor = false;
    try {
      ancestor = isAncestorFn(parsed.sha) === true;
    } catch {
      ancestor = false;
    }
    if (ancestor) return true;
  }
  return false;
}
