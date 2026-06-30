/**
 * @description Deterministic serializer that produces the executor brief from a plan task
 * slice and curated shared context. Pure function — no filesystem reads, byte-identical
 * output for identical inputs.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseFlags, isDirectCli } from './cli-flags.mjs';

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

// ---------- thin CLI: the runnable brief entrypoint SKILL.md promises ----------
// "The executor brief is produced by the brief-serializer helper, not free-written" — this is
// that runnable command, mirroring the UX already established by spawn-hand.mjs/mark.mjs.
if (isDirectCli(import.meta.url)) {
  const args = parseFlags(process.argv.slice(2), 'brief-serializer');
  if (!args['task-slice'] || !args.out) {
    process.stderr.write(
      '[brief-serializer] --task-slice <slice.json> and --out <brief.txt> are required (--shared-context <text> or --shared-context-file <path>)\n'
    );
    process.exit(1);
  }

  let taskSlice;
  try {
    taskSlice = JSON.parse(readFileSync(args['task-slice'], 'utf8'));
  } catch (err) {
    process.stderr.write(`[brief-serializer] cannot read --task-slice ${args['task-slice']}: ${err.message}\n`);
    process.exit(1);
  }

  const sharedContext = args['shared-context-file']
    ? readFileSync(args['shared-context-file'], 'utf8')
    : (args['shared-context'] ?? '');

  const brief = serializeBrief(taskSlice, sharedContext);
  writeFileSync(args.out, brief, 'utf8');
  process.stdout.write(`[brief-serializer] wrote ${args.out}\n`);
}
