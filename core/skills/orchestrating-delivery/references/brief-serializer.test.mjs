/**
 * @description Frozen test suite for serializeBrief — validates determinism, full field
 * relay, fence-free output, prohibited self-correction directives, and verbatim scalar
 * rendering of resolved_judgments values. All tests must fail RED until
 * brief-serializer.mjs is implemented.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { serializeBrief } from './brief-serializer.mjs';

const BASE_SLICE = {
  spec: 'do X',
  resolved_judgments: { redirect_status: 301, timing_safe: true },
  scope_paths: ['src/a.ts'],
  criterion_refs: ['#ac-1'],
  locked_tests: [{ assertion: 'Given A When B Then C' }],
};

const SHARED_CONTEXT = 'task-0 created helper H';

describe('serializeBrief', () => {
  it('1 — pure deterministic: two calls with identical inputs return byte-identical strings', () => {
    const first = serializeBrief(BASE_SLICE, SHARED_CONTEXT);
    const second = serializeBrief(BASE_SLICE, SHARED_CONTEXT);
    assert.strictEqual(typeof first, 'string', 'return value must be a string');
    assert.strictEqual(first, second, 'second call must produce identical bytes');
  });

  it('2 — all slice fields are present verbatim in the output', () => {
    const output = serializeBrief(BASE_SLICE, SHARED_CONTEXT);
    assert.ok(output.includes('do X'), 'spec "do X" missing from output');
    assert.ok(output.includes('redirect_status'), 'judgment key "redirect_status" missing');
    assert.ok(output.includes('301'), 'judgment value 301 missing');
    assert.ok(output.includes('timing_safe'), 'judgment key "timing_safe" missing');
    assert.ok(output.includes('true'), 'judgment value true missing');
    assert.ok(output.includes('src/a.ts'), 'scope_path "src/a.ts" missing');
    assert.ok(output.includes('#ac-1'), 'criterion_ref "#ac-1" missing');
    assert.ok(output.includes('Given A When B Then C'), 'locked_test assertion string missing');
  });

  it('3 — output contains zero fenced code blocks (no triple-backtick)', () => {
    const output = serializeBrief(BASE_SLICE, SHARED_CONTEXT);
    const fenceCount = (output.match(/```/g) || []).length;
    assert.strictEqual(fenceCount, 0, `Expected 0 triple-backtick fences, found ${fenceCount}`);
  });

  it('4 — no prohibited directives; sharedContext appears under a labeled relayed-facts section', () => {
    const output = serializeBrief(BASE_SLICE, SHARED_CONTEXT);

    assert.doesNotMatch(output, /around line \d+/i, 'Prohibited "around line N" directive found in output');
    assert.doesNotMatch(output, /Actually,?\s+place/i, 'Prohibited "Actually, place" directive found in output');

    // A labeled section header (any heading-like line containing context/facts/shared/relay)
    const labelPattern = /^[^\n]*(context|facts|shared|relay)[^\n]*/im;
    const labelMatch = labelPattern.exec(output);
    assert.ok(labelMatch !== null, 'No labeled relayed-facts section header found in output');

    const labelIndex = output.indexOf(labelMatch[0]);
    const contextIndex = output.indexOf(SHARED_CONTEXT);
    assert.ok(contextIndex !== -1, 'sharedContext text not found in output');
    assert.ok(
      contextIndex > labelIndex,
      `sharedContext (at ${contextIndex}) does not appear after the labeled section (at ${labelIndex})`,
    );
  });

  it('5 — numeric resolved_judgments value 900 is rendered as inline scalar, not a code construct', () => {
    const slice = {
      spec: 'budget check',
      resolved_judgments: { max_tokens: 900 },
      scope_paths: [],
      criterion_refs: [],
      locked_tests: [],
    };

    const output = serializeBrief(slice, '');

    assert.ok(output.includes('max_tokens'), 'judgment key "max_tokens" not present in output');
    assert.ok(output.includes('900'), 'scalar value 900 not present in output');

    // must NOT be wrapped in backticks or braces
    assert.doesNotMatch(output, /`900`/, 'value 900 is wrapped in backticks — must be bare scalar');
    assert.doesNotMatch(output, /\{900\}/, 'value 900 is wrapped in braces — must be bare scalar');

    // key and value must co-appear on the same line (inline key/value pair)
    const lines = output.split('\n');
    const keyValueLine = lines.find((l) => l.includes('max_tokens') && l.includes('900'));
    assert.ok(
      keyValueLine !== undefined,
      'No single line contains both "max_tokens" and "900" — expected inline key/value scalar',
    );
  });
});
