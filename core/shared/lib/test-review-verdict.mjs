/** @description Parse the public verdict emitted by the Pi test-fidelity reviewer. */

const CANONICAL_VERDICT = /^Verdict: (APPROVE|REVISE|BLOCKED)$/;
const VERDICT_DECLARATION = /^(?:>\s*|[-+*]\s+)?(?:\*{1,2})?Verdict:(?:\*{1,2})?/i;
const HOST_COMPLETION_ENVELOPE = /^Agent completed in [^\n]*\r?\nAgent ID: [^\r\n]+\r?\n\r?\n/;

/**
 * Accept an exact verdict at a boundary of the reviewer-authored body.
 * Repeating it at the other boundary does not change the verdict; conflicting,
 * noncanonical or interior declarations remain ambiguous and fail closed.
 * Pi's host completion envelope is transport metadata, not part of that body.
 */
export function parseTestReviewVerdict(source) {
  if (typeof source !== "string") return null;
  const body = source.trim().replace(HOST_COMPLETION_ENVELOPE, "").trim();
  const lines = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const declarations = lines.flatMap((line, index) =>
    VERDICT_DECLARATION.test(line) ? [{ line, index }] : [],
  );
  if (declarations.length === 0) return null;
  const [{ line, index }] = declarations;
  const match = line.match(CANONICAL_VERDICT);
  if (!match || declarations.some((declaration) =>
    declaration.line !== line || (declaration.index !== 0 && declaration.index !== lines.length - 1),
  )) return null;
  return { verdict: match[1], index, lines };
}

export default { parseTestReviewVerdict };
