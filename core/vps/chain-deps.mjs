/**
 * @description Roadmap dependency parsing for the VPS cron harness's merge-driven issue chaining.
 * A roadmap issue declares the issues that must MERGE before it may run inside a fenced,
 * machine-readable block in its GitHub issue body:
 *
 *   ```harness-deps
 *   #12
 *   #13
 *   ```
 *
 * The fence (a code block with the `harness-deps` info string) is deliberately robust to markdown
 * reformatting/editing — far less fragile than a free-text `depends-on:` prose line, which an
 * operator's reflow or a GitHub render could silently mangle. A dependent issue carries the
 * `harness:queued` label (NOT `harness:ready`), so cron-a-select never picks it up until
 * releaseChainedDependents (chain-release.mjs) promotes it once every declared dependency's PR has
 * merged. This module is the SINGLE source that turns an issue body into its dependency set.
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
