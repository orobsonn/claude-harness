/**
 * @description Single source of truth for turning a GitHub issue body into its declared dependency
 * set. A roadmap issue names the issues that must be DONE before it may run inside a fenced,
 * machine-readable block:
 *
 *   ```harness-deps
 *   #12
 *   #13
 *   ```
 *
 * The fence (a code block with the `harness-deps` info string) is deliberately robust to markdown
 * reformatting — far less fragile than a free-text `depends-on:` prose line, which an operator's
 * reflow or a GitHub render could silently mangle.
 *
 * This module lives in `core/shared/lib/` (not the retiring `core/vps/`) because BOTH the old VPS
 * cron engine (`core/vps/chain-deps.mjs`, which now re-exports from here) and the Orca selector
 * (`core/orca/select-and-dispatch.mjs`) parse the same block. What differs is how each one decides
 * a dependency is SATISFIED — see the note in `core/orca/README.md`: the VPS engine anchored on a
 * merged PR whose head branch is literally `harness/<N>`, which is a branch-NAME test, not a
 * delivery test; the selector anchors on the dependency ISSUE being CLOSED.
 */

const DEPS_BLOCK_PATTERN = /```harness-deps[^\n]*\n([\s\S]*?)```/g;
const ISSUE_REF_PATTERN = /#?(\d+)/g;

/**
 * @description Parses an issue body's `harness-deps` fenced block(s) into the sorted, de-duplicated
 * set of positive issue numbers it depends on. Tolerant of `#12` or bare `12`, one-per-line or
 * comma-separated, and unions across multiple blocks. An absent block, an empty body, or a
 * non-string body yields `[]` (no declared dependency).
 * @param {string} body - The GitHub issue body.
 * @returns {number[]} Ascending, de-duplicated positive issue numbers.
 */
export function parseDependsOn(body) {
  if (typeof body !== "string" || body.length === 0) {
    return [];
  }

  const found = new Set();
  DEPS_BLOCK_PATTERN.lastIndex = 0;
  let block;
  while ((block = DEPS_BLOCK_PATTERN.exec(body)) !== null) {
    const inner = block[1];
    ISSUE_REF_PATTERN.lastIndex = 0;
    let ref;
    while ((ref = ISSUE_REF_PATTERN.exec(inner)) !== null) {
      const n = Number(ref[1]);
      if (Number.isInteger(n) && n > 0) {
        found.add(n);
      }
    }
  }

  return [...found].sort((a, b) => a - b);
}
