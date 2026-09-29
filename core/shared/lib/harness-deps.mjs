/**
 * @description Shared parsing for GitHub issue dependencies. Scheduling uses the strict
 * inspectIssueDependencies result, so missing or malformed metadata never means "ready".
 * A roadmap issue names the issues that must be DONE before it may run inside a fenced,
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
 * Both the Orca cron selector and the control plane use the strict inspection result and require
 * GitHub's native blockedBy relationship to be complete and closed. parseDependsOn remains for
 * compatibility with callers that only need the numeric set; it must not decide scheduling.
 */

const DEPS_BLOCK_PATTERN = /```harness-deps[^\n]*\n([\s\S]*?)```/g;
const ISSUE_REF_PATTERN = /#?(\d+)/g;
const DEPENDENCY_CUE = /(?:^|\n)\s*(?:#{1,6}\s*)?(?:depend[eê]ncias?|depende\s+d[aeo]|depends?\s+on|blocked\s+by|bloquead[ao]\s+por)(?=\s|:|$)/im;
const STRICT_BLOCK = /^```harness-deps(?:[^\n]*)\r?\n([\s\S]*?)^```[ \t]*$/gm;

/** Distinguishes an unblocked issue from a dependency declaration the selector cannot trust. */
export function inspectIssueDependencies(body) {
  if (typeof body !== "string" || body.trim() === "") return { status: "invalid", numbers: [] };
  const blocks = [...body.matchAll(STRICT_BLOCK)];
  const openings = body.match(/^```harness-deps/gm) ?? [];
  if (openings.length !== blocks.length) return { status: "invalid", numbers: [] };
  if (blocks.length === 0) {
    if (!DEPENDENCY_CUE.test(body)) return { status: "none", numbers: [] };
    return /(?:^|\n)\s*(?:#{1,6}\s*)?depend[eê]ncias?\s*:?\s*(?:\r?\n\s*)?nenhuma\.?\s*(?:\n|$)/im.test(body)
      ? { status: "none", numbers: [] } : { status: "invalid", numbers: [] };
  }
  const found = new Set();
  for (const block of blocks) {
    const tokens = block[1].trim().split(/[\s,]+/).filter(Boolean);
    if (tokens.length === 0) return { status: "invalid", numbers: [] };
    for (const token of tokens) {
      if (!/^#?[1-9]\d*$/.test(token)) return { status: "invalid", numbers: [] };
      const number = Number(token.replace(/^#/, ""));
      if (!Number.isSafeInteger(number)) return { status: "invalid", numbers: [] };
      found.add(number);
    }
  }
  return { status: "valid", numbers: [...found].sort((a, b) => a - b) };
}

/** GitHub CLI returns a connection; a truncated or absent connection cannot prove readiness. */
export function nativeBlockersClosed(blockedBy) {
  return Boolean(blockedBy && Number.isInteger(blockedBy.totalCount) &&
    Array.isArray(blockedBy.nodes) && blockedBy.nodes.length === blockedBy.totalCount &&
    blockedBy.nodes.every((issue) => String(issue?.state ?? "").toUpperCase() === "CLOSED"));
}

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
