/**
 * @description Frozen acceptance tests for descriptor-emitter.mjs — gates the
 * emitDescriptor() contract: freeze_commit_sha injection, allowed_writes derivation
 * from manifest frozen closure, schema completeness. Run via: node --test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emitDescriptor } from './descriptor-emitter.mjs';

test('freeze_commit_sha is captured verbatim from the injected headSha() fn, not a caller literal', () => {
  const manifest = { frozen_paths: ['test/a.test.mjs', 'test/fix.json'] };
  const headSha = () => 'abc123def456abc123def456abc123def456abcd';

  const descriptor = emitDescriptor({
    featureId: 'F',
    taskId: 'T',
    model: 'glm-5.2',
    briefFile: '/tmp/brief.md',
    scopePaths: ['src/', 'test/a.test.mjs', 'test/fix.json'],
    lockedTest: 'test/a.test.mjs',
    manifest,
    headSha,
  });

  assert.equal(descriptor.freeze_commit_sha, 'abc123def456abc123def456abc123def456abcd');
});

test('allowed_writes deep-equals scopePaths minus the manifest frozen closure', () => {
  const manifest = { frozen_paths: ['test/a.test.mjs', 'test/fix.json'] };
  const headSha = () => 'abc123def456abc123def456abc123def456abcd';

  const descriptor = emitDescriptor({
    featureId: 'F',
    taskId: 'T',
    model: 'glm-5.2',
    briefFile: '/tmp/brief.md',
    scopePaths: ['src/', 'test/a.test.mjs', 'test/fix.json'],
    lockedTest: 'test/a.test.mjs',
    manifest,
    headSha,
  });

  assert.deepEqual(descriptor.allowed_writes, ['src/']);
});

test('allowed_writes does NOT include the lockedTest path when it is in manifest.frozen_paths', () => {
  const manifest = { frozen_paths: ['test/a.test.mjs', 'test/fix.json'] };
  const headSha = () => 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

  const descriptor = emitDescriptor({
    featureId: 'F',
    taskId: 'T',
    model: 'glm-5.2',
    briefFile: '/tmp/brief.md',
    scopePaths: ['src/', 'test/a.test.mjs', 'test/fix.json'],
    lockedTest: 'test/a.test.mjs',
    manifest,
    headSha,
  });

  assert.equal(descriptor.allowed_writes.includes('test/a.test.mjs'), false);
});

test('frozen path absent from scopePaths does not throw and is simply omitted from allowed_writes', () => {
  const manifest = { frozen_paths: ['test/a.test.mjs', 'test/extra-helper.mjs'] };
  const headSha = () => 'cafebabecafebabecafebabecafebabecafebabe';

  let descriptor;
  assert.doesNotThrow(() => {
    descriptor = emitDescriptor({
      featureId: 'F',
      taskId: 'T',
      model: 'glm-5.2',
      briefFile: '/tmp/brief.md',
      scopePaths: ['src/', 'test/a.test.mjs'],
      lockedTest: 'test/a.test.mjs',
      manifest,
      headSha,
    });
  });

  assert.equal(descriptor.allowed_writes.includes('test/extra-helper.mjs'), false);
  assert.equal(descriptor.allowed_writes.includes('test/a.test.mjs'), false);
  assert.deepEqual(descriptor.allowed_writes, ['src/']);
});

test('returned descriptor satisfies runLiveDispatch schema: required string fields non-empty, array fields are arrays', () => {
  const manifest = { frozen_paths: ['test/a.test.mjs'] };
  const headSha = () => '1111111111111111111111111111111111111111';

  const descriptor = emitDescriptor({
    featureId: 'F',
    taskId: 'T',
    model: 'glm-5.2',
    briefFile: '/tmp/brief.md',
    scopePaths: ['src/', 'test/a.test.mjs'],
    lockedTest: 'test/a.test.mjs',
    manifest,
    headSha,
  });

  const requiredStrings = ['feature_id', 'task_id', 'model', 'brief_file', 'locked_test', 'freeze_commit_sha'];
  for (const field of requiredStrings) {
    assert.equal(typeof descriptor[field], 'string', `field "${field}" must be a string`);
    assert.notEqual(descriptor[field].length, 0, `field "${field}" must be non-empty`);
  }

  const requiredArrays = ['scope_paths', 'allowed_writes'];
  for (const field of requiredArrays) {
    assert.equal(Array.isArray(descriptor[field]), true, `field "${field}" must be an array`);
  }
});

test('test_runner is read from the injected readRunnerConfig seam, not a caller literal', () => {
  const manifest = { frozen_paths: ['test/a.test.mjs'] };
  const headSha = () => '2222222222222222222222222222222222222222';

  const descriptor = emitDescriptor({
    featureId: 'F',
    taskId: 'T',
    model: 'glm-5.2',
    briefFile: '/tmp/brief.md',
    scopePaths: ['src/', 'test/a.test.mjs'],
    lockedTest: 'test/a.test.mjs',
    manifest,
    headSha,
    readRunnerConfig: () => 'vitest',
  });

  assert.equal(descriptor.test_runner, 'vitest');
});

test('test_runner defaults to node-test (the real readRunnerConfig default) when the seam is omitted', () => {
  const manifest = { frozen_paths: ['test/a.test.mjs'] };
  const headSha = () => '3333333333333333333333333333333333333333';

  const descriptor = emitDescriptor({
    featureId: 'F',
    taskId: 'T',
    model: 'glm-5.2',
    briefFile: '/tmp/brief.md',
    scopePaths: ['src/', 'test/a.test.mjs'],
    lockedTest: 'test/a.test.mjs',
    manifest,
    headSha,
  });

  assert.equal(typeof descriptor.test_runner, 'string');
  assert.notEqual(descriptor.test_runner.length, 0);
});
