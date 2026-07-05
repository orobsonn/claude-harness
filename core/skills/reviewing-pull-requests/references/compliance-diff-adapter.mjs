/**
 * @description Diff-adapter that synthesizes a pseudo-contract from a PR so the compliance agent can
 * review a raw diff (which lacks a plan). The review skill session invokes this before dispatching
 * the compliance agent, passing the result as the task contract.
 *
 * Pinned contract shape:
 *   synthesizeContract(pr: { title: string, body: string, changedFiles: string[] })
 *     => { criterion_refs: string[], scope_paths: string[] }
 *
 * Rules:
 *   - criterion_refs = every `#ac-N.M` match found in title + body, in order.
 *   - When NO `#ac-N.M` reference exists, criterion_refs falls back to a NON-EMPTY,
 *     title-derived synthetic ref: `#ac-title:<kebab-case-title>`.
 *   - An empty criterion_refs is NEVER acceptable — it would let compliance pass vacuously.
 *   - scope_paths = pr.changedFiles, unmodified.
 */

const AC_PATTERN = /#ac-\d+(?:\.\d+)*/g;

/**
 * @param {string} title
 * @returns {string} kebab-case version of the title for fallback ref generation
 */
function toKebabCase(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * @param {{ title: string, body: string, changedFiles: string[] }} pr
 * @returns {{ criterion_refs: string[], scope_paths: string[] }}
 */
export function synthesizeContract(pr) {
  const title = pr.title || "";
  const body = pr.body || "";

  const titleMatches = title.match(AC_PATTERN) || [];
  const bodyMatches = body.match(AC_PATTERN) || [];
  const criterion_refs = [...titleMatches, ...bodyMatches];

  // Fallback: when no #ac refs exist, derive a non-empty ref from the title.
  // An empty contract would let compliance pass vacuously against a raw diff.
  if (criterion_refs.length === 0) {
    const kebabTitle = toKebabCase(title || "untitled");
    criterion_refs.push(`#ac-title:${kebabTitle}`);
  }

  return {
    criterion_refs,
    scope_paths: pr.changedFiles || [],
  };
}
