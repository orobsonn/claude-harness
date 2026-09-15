import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { analyzePiPlan } from './plan-analysis.mjs';
import { CURRENT_PI_MODEL_STRATEGY } from './parent-session-recovery.mjs';

function fixture(t, tasks) {
  const root = mkdtempSync(join(tmpdir(), 'pi-plan-map-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, body) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), body); };
  put('.pi/harness/plans/demo/execution-plan.json', JSON.stringify({ feature_id: 'demo', mode: 'full', tasks }));
  return { root, put, run: () => analyzePiPlan({ root, featureId: 'demo' }) };
}
const task = (id, paths, depends_on = [], tests = []) => ({ id, scope_paths: paths, allowed_writes: paths, depends_on, locked_tests: tests, criterion_refs: ['#ac-contract'] });

test('draft evidence is deterministic, transitive, scoped and never a verdict', t => {
  const f = fixture(t, [task('a', ['src'], [], [{ path: 'test/a.ts' }, { path: 'test/a.ts' }]), task('b', ['src/b.ts'], ['a']), task('c', ['src/shared.ts'], ['b'], [{ path: 'test/c.ts' }])]);
  f.put('src/shared.ts', 'export const value = 1;');
  f.put('test/a.ts', 'const source = "../src/shared.ts";');
  const before = readFileSync(join(f.root, '.pi/harness/plans/demo/execution-plan.json'));
  const r = f.run();
  assert.equal(r.ok, true);
  assert.equal(r.advisory, true);
  assert.equal(r.verdict, undefined);
  assert.equal(r.validation.ok, false); // draft still analyzed
  assert.deepEqual(r.tasks.find(x => x.id === 'c').ancestors, ['a', 'b']);
  assert.equal(r.shared_paths.find(x => x.path === 'src/shared.ts').ordered, true);
  assert.deepEqual(r.frozen_paths.find(x => x.path === 'test/a.ts').owners, ['a']);
  assert.deepEqual(r.references[0], { file: 'test/a.ts', line: 1, target: 'src/shared.ts', kind: 'literal-path', source_owners: ['a'], target_owners: ['a', 'c'] });
  assert.equal(r.coverage.paths.find(x => x.path === 'src').status, 'directory-not-expanded');
  assert.deepEqual(f.run(), r);
  assert.deepEqual(readFileSync(join(f.root, '.pi/harness/plans/demo/execution-plan.json')), before);
});

test('parallel owners and cycle diagnostics do not fabricate a split decision', t => {
  const f = fixture(t, [task('a', ['src/x.ts'], ['b']), task('b', ['src/y.ts'], ['a']), task('c', ['src/x.ts'])]);
  const r = f.run();
  assert.ok(r.validation.errors.some(x => x.includes('cycle')));
  assert.equal(r.shared_paths[0].ordered, false);
  assert.equal(r.should_split, undefined);
});

test('missing, excluded, symlink and nonliteral paths are distinct, with no secret contents', t => {
  const f = fixture(t, [task('a', ['new.ts', '.env', 'link.ts', 'src/*.ts'])]);
  f.put('.env', 'SECRET_SENTINEL');
  symlinkSync(join(f.root, '.env'), join(f.root, 'link.ts'));
  const r = f.run();
  const statuses = Object.fromEntries(r.coverage.paths.map(x => [x.path, x.status]));
  assert.equal(statuses['new.ts'], 'missing');
  assert.equal(statuses['.env'], 'excluded');
  assert.equal(statuses['link.ts'], 'excluded');
  assert.equal(statuses['src/*.ts'], 'nonliteral');
  assert.doesNotMatch(JSON.stringify(r), /SECRET_SENTINEL/);
});

test('plan symlink, malformed JSON and invalid feature fail open without side effects', t => {
  const f = fixture(t, []);
  assert.equal(analyzePiPlan({ root: f.root, featureId: '../escape' }).ok, false);
  f.put('.pi/harness/plans/demo/execution-plan.json', '{');
  assert.equal(f.run().ok, false);
  rmSync(join(f.root, '.pi/harness/plans/demo/execution-plan.json'));
  f.put('.env', 'secret');
  symlinkSync(join(f.root, '.env'), join(f.root, '.pi/harness/plans/demo/execution-plan.json'));
  assert.equal(f.run().reason, 'plan excluded');
});

test('source byte budget and file hashes make incomplete evidence explicit', t => {
  const f = fixture(t, [task('a', ['large.ts', 'small.ts'])]);
  f.put('large.ts', 'x'.repeat(262145));
  f.put('small.ts', 'const a = 1;');
  const r = f.run();
  assert.equal(r.coverage.paths.find(x => x.path === 'large.ts').status, 'too-large');
  assert.equal(r.coverage.complete, false);
  assert.match(r.coverage.paths.find(x => x.path === 'small.ts').sha256, /^[a-f0-9]{64}$/);
  assert.equal(r.references.length, 0); // not proof of independence
  assert.ok(r.limitations.some(x => x.includes('absence')));
});

test('literal references are exact and lexical, not computed/alias/import resolution', t => {
  const f = fixture(t, [task('a', ['src/a.ts']), task('b', ['src/b.ts'])]);
  f.put('src/a.ts', '// "./b.ts" is only a comment\nimport "./b";\nconst alias = "@/b.ts";\nconst dynamic = `./${name}.ts`;');
  f.put('src/b.ts', 'export {};');
  const r = f.run();
  assert.deepEqual(r.references.map(x => [x.line, x.target]), [[1, 'src/b.ts']]);
  assert.ok(r.limitations.some(x => x.includes('comments')));
});

test('directory boundary is not a glob and dependency array order cannot invent sequencing', t => {
  const f = fixture(t, [task('a', ['src']), task('b', ['src-two/a.ts', 'src/b.ts']), task('c', ['src/*.ts'])]);
  const r = f.run();
  assert.deepEqual(r.shared_paths.map(x => x.path), ['src/*.ts', 'src/b.ts']);
  assert.equal(r.shared_paths.find(x => x.path === 'src/b.ts').ordered, false);
  assert.equal(r.shared_paths.find(x => x.path === 'src/b.ts').scope_owners.includes('c'), false);
});

test('resource limits report omissions and never emit an unbounded transport', t => {
  const paths = Array.from({ length: 135 }, (_, i) => `src/file-${String(i).padStart(3, '0')}.ts`);
  const f = fixture(t, [task('a', paths)]);
  for (const path of paths) f.put(path, 'const n = 1;');
  const r = f.run();
  assert.equal(r.coverage.files_read, 128);
  assert.equal(r.coverage.paths.filter(x => x.status === 'budget-exhausted').length, 7);
  assert.equal(r.coverage.complete, false);
  const many = Array.from({ length: 70 }, (_, i) => task(`task-${i}`, ['src'], [], paths.map(path => ({ path }))));
  f.put('.pi/harness/plans/demo/execution-plan.json', JSON.stringify({ feature_id: 'demo', tasks: many }));
  const bounded = f.run();
  assert.equal(bounded.validation.ok, null);
  assert.match(bounded.validation.skipped, /resource limit/);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 49152);
  assert.ok(Object.keys(bounded.output_omitted).length > 0);
  assert.equal(bounded.coverage.complete, false);
});

test('Pi model strategy is not misdiagnosed using the shared validator default lane', t => {
  const f = fixture(t, [task('a', [])]);
  f.put('.pi/harness/plans/demo/execution-plan.json', JSON.stringify({ feature_id: 'demo', tasks: [task('a', [])], model_strategy: CURRENT_PI_MODEL_STRATEGY }));
  assert.equal(f.run().validation.errors.some(x => x.includes('model_strategy')), false);
});

test('reference cap is diagnostic and omitted lexical matches are counted', t => {
  const f = fixture(t, [task('a', ['src/a.ts', 'src/b.ts'])]);
  f.put('src/a.ts', 'const ref = "./b.ts";\n'.repeat(260));
  f.put('src/b.ts', 'export {};');
  const r = f.run();
  assert.equal(r.references.length, 256);
  assert.equal(r.coverage.omitted_references, 4);
  assert.equal(r.coverage.complete, false);
});

test('duplicate task identifiers and shape errors fail open instead of producing ambiguous owners', t => {
  const f = fixture(t, [task('a', []), task('a', [])]);
  assert.equal(f.run().ok, false);
  f.put('.pi/harness/plans/demo/execution-plan.json', JSON.stringify({ feature_id: 'other', tasks: [] }));
  assert.equal(f.run().ok, false);
});

test('frozen directory coverage matches the runtime and symlink parents are not followed', t => {
  const f = fixture(t, [task('a', [], [], [{ path: 'test/a.ts', fixture_paths: ['fixtures'] }]), task('b', ['fixtures/x.json', 'linked/file.ts'])]);
  f.put('fixtures/x.json', '{}');
  f.put('real/file.ts', 'const sentinel = "DO_NOT_READ";');
  symlinkSync(join(f.root, 'real'), join(f.root, 'linked'));
  const r = f.run();
  assert.deepEqual(r.frozen_paths.find(x => x.path === 'fixtures/x.json'), { path: 'fixtures/x.json', owners: ['a'], other_scope_owners: ['b'] });
  assert.equal(r.coverage.paths.find(x => x.path === 'linked/file.ts').status, 'symlink-not-followed');
  assert.doesNotMatch(JSON.stringify(r), /DO_NOT_READ/);
});
