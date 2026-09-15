/** Native launcher/subagents/child rails smoke test, confined to a temporary repo. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildPiHarnessInvocation, materializeRuntime } from '../core/pi/bin/pi-harness.mjs';

const source = fileURLToPath(new URL('../', import.meta.url));
const cwd = mkdtempSync(join(tmpdir(), 'pi-native-support-'));
const sessionId = randomUUID();
const contract = 'Approved: deadline after publication equals publication time plus 259200 seconds; not job creation time or destination expiry. Task-one owns the behavior.\n';
const report = 'Two unresolved concerns: lease fixture uses equal creation/claim times despite strict-later claim requirement; deadline test checks only before publication, but implementation copies arbitrary destination expiry at final publication. Preserve both in the next task request.\n';
writeFileSync(join(cwd, 'contract.md'), contract);
writeFileSync(join(cwd, 'report.md'), report);
execFileSync('git', ['init', '-b', 'fixture'], { cwd, stdio: 'ignore' });
execFileSync('git', ['add', 'contract.md', 'report.md'], { cwd });
execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], { cwd });
process.chdir(cwd);
const invocation = buildPiHarnessInvocation({ root: source, sessionId, env: process.env,
  argv: ['--mode', 'json', '--print', '--model', 'openai-codex/gpt-5.6-terra', '--thinking', 'high',
    'This is an isolated diagnostic-only exercise, not authorization to implement or ship. Dispatch exactly one harness-support with model openai-codex/gpt-5.6-terra, thinking high, inherit_context false. Ask it to read contract.md and report.md and identify the smallest correction to send to existing task-one, preserving both concerns. Wait for its result and summarize. Do not run product tasks, create a plan, edit files, commit, push, or ship.'],
  runtimePrompt: readFileSync(join(source, 'core/pi/prompts/harness-runtime.md'), 'utf8') });
materializeRuntime(source, invocation.env.PI_CODING_AGENT_DIR);
const directory = join(cwd, '.pi/harness/state', sessionId); mkdirSync(directory, { recursive: true });
const state = { session_id: sessionId, feature_id: 'fixture', classified: true, mode: 'FULL' };
writeFileSync(join(directory, 'gate-state.json'), JSON.stringify(state));
console.log(JSON.stringify({ cwd, sessionId, nativeCli: invocation.args[0] }));
const started = Date.now();
const result = spawnSync(invocation.command, invocation.args, { cwd, env: invocation.env, encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
writeFileSync(join(cwd, 'native-output.jsonl'), result.stdout ?? '');
writeFileSync(join(cwd, 'native-stderr.txt'), result.stderr ?? '');
const events = (result.stdout ?? '').split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
const calls = events.filter(e => e.type === 'tool_execution_start').map(e => ({ id: e.toolCallId, name: e.toolName, args: e.args }));
const completions = events.filter(e => e.type === 'tool_execution_end');
const output = { cwd, sessionId, elapsed_ms: Date.now() - started, status: result.status, error: result.error?.message, calls,
  completions: completions.map(e => ({ id: e.toolCallId, name: e.toolName, isError: e.isError, result: e.result })) };
writeFileSync(join(cwd, 'result.json'), JSON.stringify(output, null, 2));
console.log(JSON.stringify({ result: join(cwd, 'result.json'), status: result.status, elapsed_ms: output.elapsed_ms, calls }));
assert.equal(result.status, 0, result.stderr);
const support = calls.filter(c => c.name === 'subagent' && c.args?.subagent_type === 'harness-support');
assert.equal(support.length, 1, 'native parent must dispatch one support');
const completed = completions.find(e => e.toolCallId === support[0].id);
assert.equal(completed?.isError, false, JSON.stringify(completed));
assert.equal(completed?.result?.details?.status, 'completed', JSON.stringify(completed));
assert.equal(readFileSync(join(cwd, 'contract.md'), 'utf8'), contract);
assert.equal(readFileSync(join(cwd, 'report.md'), 'utf8'), report);
const after = JSON.parse(readFileSync(join(directory, 'gate-state.json'), 'utf8'));
for (const field of ['hand_finished', 'capture_verified', 'final_review_done', 'task_review_evidence', 'final_review_evidence']) assert.equal(after[field], undefined, field);
