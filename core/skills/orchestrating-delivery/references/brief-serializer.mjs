/**
 * @description Deterministic serializer that produces the executor brief from a plan task
 * slice and curated shared context. Pure function — no filesystem reads, byte-identical
 * output for identical inputs.
 */

/**
 * @description Serializes a task slice and shared context into a plain-text executor brief.
 * Relays only: spec, resolved_judgments key/value scalars, scope_paths, criterion_refs,
 * locked_tests assertion strings, and the curated sharedContext under a labeled section.
 * Output contains no fenced code blocks and no line-number directives.
 *
 * @param {{ spec: string, resolved_judgments: Record<string, unknown>, scope_paths: string[], criterion_refs: string[], locked_tests: Array<{ assertion: string }> }} taskSlice - The plan task slice to serialize.
 * @param {string} sharedContext - Curated shared context accumulated from prior tasks.
 * @returns {string} The complete plain-text executor brief.
 */
export function serializeBrief(taskSlice, sharedContext) {
  const { spec, resolved_judgments, scope_paths, criterion_refs, locked_tests } = taskSlice;

  const lines = [];

  // Spec section
  lines.push('## Spec');
  lines.push(spec);
  lines.push('');

  // Resolved judgments section
  lines.push('## Decisions (resolved_judgments)');
  for (const [key, value] of Object.entries(resolved_judgments)) {
    lines.push(`${key}: ${String(value)}`);
  }
  lines.push('');

  // Scope section
  lines.push('## Scope');
  if (scope_paths.length > 0) {
    for (const path of scope_paths) {
      lines.push(`- ${path}`);
    }
  } else {
    lines.push('(none)');
  }
  lines.push('');

  // Acceptance criteria section
  lines.push('## Acceptance (criterion_refs)');
  if (criterion_refs.length > 0) {
    for (const ref of criterion_refs) {
      lines.push(`- ${ref}`);
    }
  } else {
    lines.push('(none)');
  }
  lines.push('');

  // Locked test assertions section
  lines.push('## Locked test assertions');
  if (locked_tests.length > 0) {
    for (const test of locked_tests) {
      lines.push(`- ${test.assertion}`);
    }
  } else {
    lines.push('(none)');
  }
  lines.push('');

  // Relayed shared context section — label contains "shared", "context", "facts", and "relay"
  lines.push('## Relayed validated facts (shared_context)');
  lines.push(sharedContext);

  return lines.join('\n');
}
