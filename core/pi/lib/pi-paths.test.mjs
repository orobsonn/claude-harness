/** @description Testes travados de pi-paths — mesmo contrato PathResult do path-helpers OC, raiz .pi/harness/. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  piPlansRoot,
  piStateRoot,
  piPlanDir,
  piExecutionPlanPath,
  piSpecPath,
  piGateStateDir,
  piGateStatePath,
  piHandRecordPath,
  piDispatchRecordDir
} from './pi-paths.mjs'

test('pi-plans-root: caminho exato', () => {
  const r = piPlansRoot('/tmp/project')
  assert.deepEqual(r, { ok: true, path: '/tmp/project/.pi/harness/plans' })
})

test('pi-plans-root: projectRoot vazio rejeitado', () => {
  assert.deepEqual(piPlansRoot(''), { ok: false, reason: 'invalid projectRoot' })
  assert.deepEqual(piPlansRoot(undefined), { ok: false, reason: 'invalid projectRoot' })
})

test('pi-state-root: caminho exato', () => {
  const r = piStateRoot('/tmp/project')
  assert.deepEqual(r, { ok: true, path: '/tmp/project/.pi/harness/state' })
})

test('pi-plan-dir: caminho exato e espelha OC (sem sessionId no caminho)', () => {
  const r = piPlanDir({ projectRoot: '/tmp/project', featureId: 'pi-paths' })
  assert.deepEqual(r, { ok: true, path: '/tmp/project/.pi/harness/plans/pi-paths' })
})

test('pi-plan-dir: featureId maiúsculo/underscore rejeitado', () => {
  const upper = piPlanDir({ projectRoot: '/tmp/project', featureId: 'Pi-Paths' })
  assert.deepEqual(upper, { ok: false, reason: 'invalid featureId' })

  const underscore = piPlanDir({ projectRoot: '/tmp/project', featureId: 'pi_paths' })
  assert.deepEqual(underscore, { ok: false, reason: 'invalid featureId' })
})

test('pi-execution-plan-path: caminho exato', () => {
  const r = piExecutionPlanPath({ projectRoot: '/tmp/project', featureId: 'pi-paths' })
  assert.deepEqual(r, { ok: true, path: '/tmp/project/.pi/harness/plans/pi-paths/execution-plan.json' })
})

test('pi-spec-path: caminho canônico da spec', () => {
  const r = piSpecPath({ projectRoot: '/tmp/project', featureId: 'pi-paths' })
  assert.deepEqual(r, { ok: true, path: '/tmp/project/.pi/harness/plans/pi-paths/spec.md' })
  assert.deepEqual(piSpecPath({ projectRoot: '/tmp/project', featureId: '../escape' }), { ok: false, reason: 'invalid featureId' })
})

test('pi-gate-state-dir: caminho exato', () => {
  const r = piGateStateDir({ projectRoot: '/tmp/project', sessionId: 'ses-abc123' })
  assert.deepEqual(r, { ok: true, path: '/tmp/project/.pi/harness/state/ses-abc123' })
})

test('pi-gate-state-dir: sessionId com ".." rejeitado', () => {
  const r = piGateStateDir({ projectRoot: '/tmp/project', sessionId: 'ses..dotdot' })
  assert.deepEqual(r, { ok: false, reason: 'invalid sessionId' })
})

test('pi-gate-state-dir: sessionId com "/" rejeitado', () => {
  const r = piGateStateDir({ projectRoot: '/tmp/project', sessionId: 'ses/abc' })
  assert.deepEqual(r, { ok: false, reason: 'invalid sessionId' })
})

test('pi-gate-state-path: caminho exato', () => {
  const r = piGateStatePath({ projectRoot: '/tmp/project', sessionId: 'ses-abc123' })
  assert.deepEqual(r, { ok: true, path: '/tmp/project/.pi/harness/state/ses-abc123/gate-state.json' })
})

test('pi-hand-record-path: caminho exato', () => {
  const r = piHandRecordPath(
    { projectRoot: '/tmp/project', featureId: 'pi-paths', sessionId: 'ses-abc123' },
    'task-1'
  )
  assert.deepEqual(r, {
    ok: true,
    path: '/tmp/project/.pi/harness/state/hand-records/pi-paths/ses-abc123/task-1.json'
  })
})

test('pi-hand-record-path: taskId inválido rejeitado', () => {
  const r = piHandRecordPath(
    { projectRoot: '/tmp/project', featureId: 'pi-paths', sessionId: 'ses-abc123' },
    'Task_1'
  )
  assert.deepEqual(r, { ok: false, reason: 'invalid taskId' })
})

test('pi-hand-record-path: sessionId ausente rejeitado (Pi sempre exige sessão)', () => {
  const r = piHandRecordPath(
    { projectRoot: '/tmp/project', featureId: 'pi-paths' },
    'task-1'
  )
  assert.deepEqual(r, { ok: false, reason: 'invalid sessionId' })
})

test('pi-dispatch-record-dir: caminho exato', () => {
  const r = piDispatchRecordDir({ projectRoot: '/tmp/project', parentSessionId: 'ses-parent1' })
  assert.deepEqual(r, {
    ok: true,
    path: '/tmp/project/.pi/harness/state/ses-parent1/dispatch-records'
  })
})

test('pi-dispatch-record-dir: parentSessionId com ".." rejeitado', () => {
  const r = piDispatchRecordDir({ projectRoot: '/tmp/project', parentSessionId: '..' })
  assert.deepEqual(r, { ok: false, reason: 'invalid sessionId' })
})

test('projectRoot vazio rejeitado em todos os builders que recebem roots', () => {
  assert.deepEqual(piPlanDir({ projectRoot: '', featureId: 'ok-id' }), {
    ok: false,
    reason: 'invalid projectRoot'
  })
  assert.deepEqual(piGateStateDir({ projectRoot: '', sessionId: 'ses-1' }), {
    ok: false,
    reason: 'invalid projectRoot'
  })
  assert.deepEqual(
    piHandRecordPath({ projectRoot: '', featureId: 'ok-id', sessionId: 'ses-1' }, 'task-1'),
    { ok: false, reason: 'invalid projectRoot' }
  )
  assert.deepEqual(piDispatchRecordDir({ projectRoot: '', parentSessionId: 'ses-1' }), {
    ok: false,
    reason: 'invalid projectRoot'
  })
})

test('pi-plan-dir: plano é estável por feature — sessionId em roots é ignorado (espelha t2 do OC)', () => {
  const r = piPlanDir({
    projectRoot: '/tmp/project',
    sessionId: 'ses..dotdot',
    featureId: 'ok-id'
  })
  assert.deepEqual(r, { ok: true, path: '/tmp/project/.pi/harness/plans/ok-id' })
  assert.ok(!r.path.includes('ses'))
})

test('precedência de reason idêntica ao path-helpers do OC quando dois campos são inválidos', () => {
  // OC planDir: featureId antes de projectRoot.
  assert.deepEqual(piPlanDir({ projectRoot: '', featureId: 'a/b' }), {
    ok: false,
    reason: 'invalid featureId'
  })
  assert.deepEqual(piExecutionPlanPath({ featureId: '../traverse' }), {
    ok: false,
    reason: 'invalid featureId'
  })
  // OC gateStateDir: sessionId antes de projectRoot.
  assert.deepEqual(piGateStateDir({ projectRoot: '', sessionId: 'ses/abc' }), {
    ok: false,
    reason: 'invalid sessionId'
  })
  // OC handRecordPath (ramo opencode): featureId → taskId → projectRoot → sessionId.
  assert.deepEqual(
    piHandRecordPath({ projectRoot: '', featureId: 'Bad_Id', sessionId: '../x' }, '../t'),
    { ok: false, reason: 'invalid featureId' }
  )
  assert.deepEqual(
    piHandRecordPath({ projectRoot: '', featureId: 'ok-id', sessionId: '../x' }, '../t'),
    { ok: false, reason: 'invalid taskId' }
  )
  assert.deepEqual(
    piHandRecordPath({ projectRoot: '', featureId: 'ok-id', sessionId: '../x' }, 'task-1'),
    { ok: false, reason: 'invalid projectRoot' }
  )
  // Builder chaveado por sessão: id antes de projectRoot.
  assert.deepEqual(piDispatchRecordDir({ projectRoot: '', parentSessionId: 'ses/abc' }), {
    ok: false,
    reason: 'invalid sessionId'
  })
})

test('roots inválido (não-objeto) nunca lança', () => {
  assert.doesNotThrow(() => {
    const r = piPlanDir(null)
    assert.deepEqual(r, { ok: false, reason: 'invalid roots' })
  })
  assert.doesNotThrow(() => {
    const r = piGateStateDir(undefined)
    assert.deepEqual(r, { ok: false, reason: 'invalid roots' })
  })
  assert.doesNotThrow(() => {
    const r = piHandRecordPath([], 'task-1')
    assert.deepEqual(r, { ok: false, reason: 'invalid roots' })
  })
})
