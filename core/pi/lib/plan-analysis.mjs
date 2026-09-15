/** Read-only structural evidence for planning, never a gate or architectural score. */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, resolve, posix } from 'node:path';
import { validatePlan } from '../../shared/lib/validate-plan.mjs';
import { checkScope } from '../../shared/lib/capture-oracle.mjs';
import { piExecutionPlanPath } from './pi-paths.mjs';
import { decidePiPolicy } from './policy.mjs';

const LIMITS = Object.freeze({ plan_bytes: 1048576, tasks: 128, paths: 512,
  validation_claims: 1024, file_bytes: 262144, files: 128, total_bytes: 8388608, references: 256, output_bytes: 49152 });
const strings = a => [...new Set((Array.isArray(a) ? a : []).filter(x => typeof x === 'string'))].sort();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const covered = (path, scopes) => checkScope([path], scopes).length === 0;
const literalPath = p => typeof p === 'string' && p.length > 0 && p.length <= 512 &&
  !/[\\\x00-\x1f*?{}]/.test(p) && !p.startsWith('/') &&
  !p.split('/').some(x => !x || x === '.' || x === '..');
const internal = p => /^\.(?:git|pi|claude|codex|opencode)(?:\/|$)/.test(p);

// No commands, repository code, MCP, recursive traversal or symlink following.
// Reuse the reviewer read boundary; stricter symlink refusal is reported, not a gate.
function readBounded(root, path, maxBytes) {
  let fd;
  try {
    const decision = decidePiPolicy({ toolName: 'read', input: { path } },
      { cwd: root, projectRoot: root, reviewerRole: 'harness-plan-reviewer' });
    if (decision.block) return { status: 'excluded' };
    let cursor = root;
    for (const segment of relative(root, resolve(root, path)).split('/')) {
      cursor = join(cursor, segment);
      if (lstatSync(cursor).isSymbolicLink()) return { status: 'symlink-not-followed' };
    }
    const stat = lstatSync(cursor);
    if (stat.isDirectory()) return { status: 'directory-not-expanded' };
    if (!stat.isFile()) return { status: 'not-regular' };
    if (stat.size > maxBytes) return { status: 'too-large' };
    fd = openSync(cursor, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) return { status: 'not-regular' };
    const bytes = Buffer.alloc(maxBytes + 1);
    let size = 0, got;
    while (size < bytes.length && (got = readSync(fd, bytes, size, bytes.length - size, null)) > 0) size += got;
    if (size > maxBytes) return { status: 'too-large' };
    const body = bytes.subarray(0, size);
    if (body.includes(0)) return { status: 'binary' };
    return { status: 'read', body: body.toString('utf8'), bytes: size, sha256: hash(body) };
  } catch (error) {
    return { status: error?.code === 'ENOENT' ? 'missing' : 'unreadable' };
  } finally { if (fd !== undefined) closeSync(fd); }
}

function ancestors(id, tasks) {
  const seen = new Set(), todo = [...(tasks.get(id)?.depends_on ?? [])];
  while (todo.length) {
    const next = todo.pop();
    if (seen.has(next) || !tasks.has(next)) continue;
    seen.add(next);
    todo.push(...tasks.get(next).depends_on);
  }
  seen.delete(id);
  return [...seen].sort();
}

/** Analyze a canonical draft/current plan. Failure is diagnostic, never changes approval. */
export function analyzePiPlan({ root, featureId } = {}) {
  const unavailable = reason => ({ ok: false, advisory: true, reason,
    instruction: 'Continue with the plan, spec and code; analysis availability is not an approval requirement.' });
  const planPath = piExecutionPlanPath({ projectRoot: root, featureId });
  if (!planPath.ok) return unavailable(planPath.reason);
  try { root = realpathSync(root); } catch { return unavailable('repository unavailable'); }
  const input = readBounded(root, planPath.path, LIMITS.plan_bytes);
  if (input.status !== 'read') return unavailable(`plan ${input.status}`);
  let plan;
  try { plan = JSON.parse(input.body); } catch { return unavailable('plan is not valid JSON'); }
  if (plan?.feature_id !== featureId || !Array.isArray(plan.tasks)) return unavailable('plan feature/tasks mismatch');
  if (plan.tasks.length > LIMITS.tasks) return unavailable('analysis task resource limit; inspect the plan directly');
  // Existing validation compares frozen claims pairwise. Do not let a huge draft
  // monopolize the host; skip that diagnostic, not planning, above the IO/CPU budget.
  const claims = plan.tasks.reduce((sum, t) => sum + (Array.isArray(t?.locked_tests) ? t.locked_tests : [])
    .reduce((n, lt) => n + 1 + (Array.isArray(lt?.fixture_paths) ? lt.fixture_paths.length : 0), 0), 0);
  const validation = claims <= LIMITS.validation_claims ? validatePlan(plan, { expectedModelStrategy: plan.model_strategy })
    : { ok: null, errors: [], skipped: 'validation claim resource limit; structural evidence only' };
  const tasks = new Map();
  for (const task of plan.tasks) {
    if (!task || typeof task.id !== 'string' || !task.id || task.id.length > 128 || tasks.has(task.id)) {
      return unavailable('task identifiers must be unambiguous for structural analysis');
    }
    const tests = (Array.isArray(task.locked_tests) ? task.locked_tests : []).filter(x => x && typeof x === 'object');
    tasks.set(task.id, { id: task.id, depends_on: strings(task.depends_on),
      scope: strings(task.scope_paths), allowed: strings(task.allowed_writes),
      frozen: strings(tests.flatMap(x => [x.path, ...(Array.isArray(x.fixture_paths) ? x.fixture_paths : [])])),
      criteria: strings(task.criterion_refs) });
  }
  const all = [...tasks.values()].sort((a, b) => a.id.localeCompare(b.id, 'en'));
  const paths = strings(all.flatMap(t => [...t.scope, ...t.allowed, ...t.frozen]));
  if (paths.length > LIMITS.paths) return unavailable('analysis path resource limit; inspect the plan directly');
  const ancestry = new Map(all.map(t => [t.id, ancestors(t.id, tasks)]));
  const records = paths.map(path => ({ path,
    scope_owners: all.filter(t => covered(path, t.scope)).map(t => t.id),
    allowed_write_owners: all.filter(t => covered(path, t.allowed)).map(t => t.id),
    frozen_owners: all.filter(t => covered(path, t.frozen)).map(t => t.id) }));
  const owners = path => {
    const record = records.find(r => r.path === path);
    return record ? strings([...record.scope_owners, ...record.allowed_write_owners, ...record.frozen_owners]) : [];
  };
  const shared = records.filter(r => strings([...r.scope_owners, ...r.allowed_write_owners]).length > 1).map(r => {
    const ids = strings([...r.scope_owners, ...r.allowed_write_owners]);
    // Exactly one direction must hold: a cycle is not legitimate sequential ownership.
    const ordered = ids.every((a, i) => ids.slice(i + 1).every(b =>
      ancestry.get(a).includes(b) !== ancestry.get(b).includes(a)));
    return { ...r, ordered };
  });
  const criteria = strings(all.flatMap(t => t.criteria)).map(criterion => ({ criterion,
    owners: all.filter(t => t.criteria.includes(criterion)).map(t => ({ task_id: t.id, test_paths: t.frozen })) }))
    .filter(r => r.owners.length > 1);
  const coverage = [], references = [];
  let files = 0, totalBytes = 0, omittedReferences = 0;
  const safeTargets = new Set(paths.filter(p => literalPath(p) && !internal(p) &&
    !decidePiPolicy({ toolName: 'read', input: { path: p } },
      { cwd: root, projectRoot: root, reviewerRole: 'harness-plan-reviewer' }).block));
  for (const path of paths) {
    let read;
    if (!literalPath(path)) read = { status: 'nonliteral' };
    else if (internal(path)) read = { status: 'excluded' };
    else if (files >= LIMITS.files || totalBytes >= LIMITS.total_bytes) read = { status: 'budget-exhausted' };
    else read = readBounded(root, path, Math.min(LIMITS.file_bytes, LIMITS.total_bytes - totalBytes));
    const { body, ...metadata } = read;
    coverage.push({ path, ...metadata });
    if (read.status !== 'read') continue;
    files++; totalBytes += read.bytes;
    // Literal path occurrences, NOT an import parser or proof of runtime dependency.
    // Includes comments/fixtures; no aliases, interpolated paths or computed resolution.
    for (const [index, line] of body.split('\n').entries()) {
      const found = new Set();
      for (const match of line.matchAll(/(["'`])([^"'`\r\n\\]{1,512})\1/g)) {
        const value = match[2];
        if (value.includes('${') || value.startsWith('/') || !value.includes('/')) continue;
        const candidates = value.startsWith('.') ? [posix.normalize(posix.join(posix.dirname(path), value))] : [value];
        for (const target of candidates) {
          if (target === path || !safeTargets.has(target) || found.has(target)) continue;
          found.add(target);
          if (references.length >= LIMITS.references) { omittedReferences++; continue; }
          references.push({ file: path, line: index + 1, target, kind: 'literal-path', source_owners: owners(path), target_owners: owners(target) });
        }
      }
    }
  }
  const report = { ok: true, advisory: true, version: 1,
    basis: { feature_id: featureId, plan_path: relative(root, planPath.path), plan_sha256: input.sha256,
      repository: 'current working-tree files, not the original planning baseline' },
    validation,
    tasks: all.map(t => ({ id: t.id, depends_on: t.depends_on, ancestors: ancestry.get(t.id),
      scoped_paths: t.scope.length, frozen_paths: t.frozen.length, criteria: t.criteria })),
    shared_paths: shared,
    frozen_paths: records.filter(r => r.frozen_owners.length).map(r => ({ path: r.path, owners: r.frozen_owners,
      other_scope_owners: strings([...r.scope_owners, ...r.allowed_write_owners]).filter(id => !r.frozen_owners.includes(id)) })),
    shared_criteria: criteria, references,
    coverage: { complete: coverage.every(r => r.status === 'read') && omittedReferences === 0 && !validation.skipped,
      files_read: files, bytes_read: totalBytes, omitted_references: omittedReferences, paths: coverage },
    limits: LIMITS,
    limitations: [
      'Declared scopes are permissions, not proof of actual edits; ordered ownership is not proof that a split is good.',
      'Shared criteria show task-level declarations, not which individual assertion proves each criterion.',
      'Literal path references may occur in comments or fixtures; they are not resolved imports or a call graph. Only exact declared paths are matched. Aliases and computed paths are not resolved.',
      'Only explicitly named regular files are read. Directories are not expanded; missing/new files have no code evidence. The absence of a reference does not prove independence or completeness.',
      'Symlinks are refused at inspection time. This reader is not a sandbox against a concurrent hostile process replacing parent directories.',
      'This cannot infer future contracts, prove atomicity, detect semantic fixture contradictions, or decide whether a referenced file needs editing.',
      'No score, split quota, approval, receipt or plan mutation is produced. Use the spec and focal code inspection to judge these relationships.'
    ], output_omitted: {} };
  // Bound transport without silently passing a partial map off as complete.
  const lists = [[report, 'references'], [report.coverage, 'paths'],
    [report, 'shared_criteria'], [report, 'frozen_paths'], [report, 'shared_paths'],
    [report, 'tasks'], [validation, 'errors']];
  const fits = () => Buffer.byteLength(JSON.stringify(report)) <= LIMITS.output_bytes;
  for (const [parent, key] of lists) {
    if (fits()) break;
    const list = parent[key];
    if (!list.length) continue;
    const name = parent === report.coverage ? 'coverage.paths' : parent === validation ? 'validation.errors' : key;
    report.coverage.complete = false;
    const keep = n => { parent[key] = list.slice(0, n); report.output_omitted[name] = list.length - n; };
    keep(0);
    if (!fits()) continue;
    let lo = 0, hi = list.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      keep(mid);
      if (fits()) lo = mid; else hi = mid - 1;
    }
    keep(lo);
  }
  return report;
}
