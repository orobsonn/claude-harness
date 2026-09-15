/** Opt-in real-model probes in disposable fixtures, never a consumer task run. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { installNativeHarnessAgents } from '../core/pi/lib/native-bootstrap.mjs';
import { piDispatchRoute } from '../core/pi/lib/dispatch-rail.mjs';
import { decidePiPolicy } from '../core/pi/lib/policy.mjs';
import { markReviewerGrepInput, registerReviewerGrepTool } from '../core/pi/lib/reviewer-grep.mjs';

const scenario = process.argv[2];
if (!['weak-oracle', 'faithful-oracle', 'support-boundary', 'author-oracle'].includes(scenario)) throw Error('Expected weak-oracle|faithful-oracle|support-boundary|author-oracle');
const author = scenario === 'author-oracle';
const role = author ? 'harness-test-author' : scenario === 'support-boundary' ? 'harness-support' : 'harness-test-reviewer';
const route = piDispatchRoute(role, 'high');
const cwd = mkdtempSync(join(tmpdir(), `pi-recovery-${scenario}-`));
for (const dir of ['src', 'tests', 'agent']) mkdirSync(join(cwd, dir));
const fixture = {
  'spec.md': `Approved contract: adding a destination must not publish activation. Publication happens at the final publish operation, with an injected activation timestamp. The deadline after publication must equal that activation timestamp plus 72 hours (259200 seconds), independent of destination expiry and job creation time. Existing task-one owns src/research.mjs and tests/deadline.test.mjs. Only this behavior is approved; no new retry or authorization scenarios are required.\n`,
  'src/research.mjs': `export function create(createdAt) { return {createdAt, activatedAt:null, deadline:null, destination:null}; }
export function addDestination(state, expiry) { state.destination = {expiry}; state.deadline = expiry; }
export function publish(state, activatedAt) { state.activatedAt = activatedAt; state.deadline = state.destination.expiry; }
`,
  'tests/deadline.test.mjs': `import test from 'node:test';
import assert from 'node:assert/strict';
import {create, addDestination, publish} from '../src/research.mjs';
test('destination cannot control activation deadline', () => {
  const state = create(1000);
  addDestination(state, 999999);
  assert.equal(state.activatedAt, null);
  ${scenario === 'weak-oracle' ? 'assert.equal(state.deadline, null);' : 'publish(state, 1120);\n  assert.equal(state.activatedAt, 1120);\n  assert.equal(state.deadline, 1120 + 259200);'}
});
`,
  'hand-report.md': `Status: DONE_WITH_CONCERNS
1. Lease fixture creates and claims at the same timestamp, but the approved lease contract needs claim strictly later. Task-one should repair only that fixture.
2. A SQLite trigger trusting actor='worker-final' cannot distinguish arbitrary SQL supplying that string from the authorized wrapper. This is an unresolved authority-boundary question, not repaired by replacing worker-legado with worker-final. The coordinator previously relayed only concern 1. No further product writing is authorized by this diagnostic request.
`,
};
// Optional explicit artifact from an earlier author probe; never read a live task implicitly.
if (scenario === 'faithful-oracle' && process.argv[3]) fixture['tests/deadline.test.mjs'] = readFileSync(resolve(process.argv[3]), 'utf8');
for (const [file, content] of Object.entries(fixture)) writeFileSync(join(cwd, file), content);
const executed = spawnSync(process.execPath, ['--test', 'tests/deadline.test.mjs'], { cwd, encoding: 'utf8' });
assert.equal(executed.status, 1, 'fixture must collect and fail behaviorally before review');
writeFileSync(join(cwd, 'test-output.txt'), executed.stdout + executed.stderr);
// Independent sensitivity check: a weaker implementation postpones the bad deadline
// copy until publication. The weak assertion goes green; the final obligation does not.
const mutant = fixture['src/research.mjs'].replace('state.destination = {expiry}; state.deadline = expiry;', 'state.destination = {expiry};');
writeFileSync(join(cwd, 'src/research.mjs'), mutant);
const sensitivity = spawnSync(process.execPath, ['--test', 'tests/deadline.test.mjs'], { cwd, encoding: 'utf8' });
if (scenario !== 'support-boundary') assert.equal(sensitivity.status, scenario === 'weak-oracle' ? 0 : 1);
writeFileSync(join(cwd, 'src/research.mjs'), fixture['src/research.mjs']);
if (author) writeFileSync(join(cwd, 'tests/deadline.test.mjs'), '// Author the approved observable here.\n');
const agentDir = join(cwd, 'agent');
assert.equal(installNativeHarnessAgents({ agentDir }).ok, true);
const asset = readFileSync(join(agentDir, 'agents', `${role}.md`), 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '');
const runtime = await ModelRuntime.create({ authPath: join(homedir(), '.pi/agent/auth.json'), modelsPath: null, allowModelNetwork: false });
const model = runtime.getModel('openai-codex', route.model.split('/')[1]);
if (!model) throw Error('Required role model unavailable');
const settings = SettingsManager.inMemory({ defaultProvider: 'openai-codex', defaultModel: model.id, defaultThinkingLevel: route.thinking });
const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  systemPrompt: asset, extensionFactories: [pi => {
    registerReviewerGrepTool(pi);
    pi.on('tool_call', event => {
      if (author && ['write', 'edit'].includes(event.toolName) && resolve(cwd, event.input?.path ?? '') !== join(cwd, 'tests/deadline.test.mjs')) {
        return { block: true, reason: 'Only tests/deadline.test.mjs is an authorized write path.' };
      }
      if (author && event.toolName === 'bash' && event.input?.command !== 'node --test tests/deadline.test.mjs') {
        return { block: true, reason: 'This isolated experiment permits only node --test tests/deadline.test.mjs.' };
      }
      const decision = decidePiPolicy({ toolName: event.toolName, input: event.input }, { cwd, projectRoot: cwd, reviewerRole: role });
      if (decision.reviewerGrepGuard) markReviewerGrepInput(event.input, decision.reviewerGrepGuard);
      return decision;
    });
  }] });
await loader.reload();
const names = ['read', 'grep', 'find', 'ls', ...(author ? ['edit', 'write', 'bash'] : [])];
const { session } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, model, thinkingLevel: route.thinking, settingsManager: settings,
  resourceLoader: loader, sessionManager: SessionManager.create(cwd, join(cwd, 'sessions')), tools: names });
await session.bindExtensions({});
session.setActiveToolsByName(names);
assert.deepEqual(session.getActiveToolNames().sort(), names.sort());
const calls = [];
session.subscribe(e => { if (e.type === 'tool_execution_start') calls.push({ name: e.toolName, args: e.args }); });
const started = Date.now(); let timedOut = false;
const timer = setTimeout(() => { timedOut = true; void session.abort(); }, 120000);
console.log(JSON.stringify({ cwd, scenario, role, model: model.id, thinking: route.thinking }));
let error;
try {
  await session.prompt(author
    ? 'Task-one, high complexity, initial test authorship. spec.md contains the complete approved observables; src/research.mjs is the current boundary. Author the smallest faithful executable RED in tests/deadline.test.mjs, the only authorized write path. Use node:test and node:assert/strict. Read the boundary and execute exactly node --test tests/deadline.test.mjs. Do not change production. There is no other scenario or previous review to implement.'
    : scenario === 'support-boundary'
    ? 'Read hand-report.md. Your sole diagnostic lens is the authority boundary raised by the hand: distinguish what is known from what needs a contract decision, and give the parent a focused next request for the existing owning task. Do not audit the repository or solve the independent lease fixture. Explain how the unresolved concern should survive that first correction.'
    : 'Initial test-fidelity review for task-one. Read spec.md (the complete approved contract), tests/deadline.test.mjs and the current source as needed. The actual command node --test tests/deadline.test.mjs collected one test and exited 1; output is in test-output.txt. Decide whether this test is a faithful executable RED for the approved final deadline obligation. Return your normal verdict and focused rationale. No other scenarios are required.');
} catch (e) { error = String(e); }
finally { clearTimeout(timer); }
const messages = session.messages.filter(m => m.role === 'assistant');
const response = messages.at(-1)?.content?.filter(p => p.type === 'text').map(p => p.text).join('\n') ?? '';
const usage = messages.map(m => m.usage);
const cost = usage.reduce((sum, u) => sum + (u?.cost?.total ?? 0), 0);
const result = { scenario, role, model: session.model?.id, thinking: session.thinkingLevel, elapsed_ms: Date.now() - started, timedOut, error,
  source_exit: executed.status, weaker_implementation_exit: sensitivity.status, calls, response, usage, cost, cost_basis: 'SDK estimate, not verified billing' };
writeFileSync(join(cwd, 'result.json'), JSON.stringify(result, null, 2));
await session.extensionRunner.emit({ type: 'session_shutdown' }); session.dispose();
console.log(JSON.stringify({ result: join(cwd, 'result.json'), response, cost, elapsed_ms: result.elapsed_ms }));
assert.equal(timedOut, false); assert.equal(error, undefined);
for (const [file, content] of Object.entries(fixture)) {
  if (author && file === 'tests/deadline.test.mjs') continue;
  assert.equal(readFileSync(join(cwd, file), 'utf8'), content, 'no unauthorized fixture mutation');
}
if (author) {
  const run = () => spawnSync(process.execPath, ['--test', 'tests/deadline.test.mjs'], { cwd, encoding: 'utf8' });
  const original = run();
  writeFileSync(join(cwd, 'src/research.mjs'), mutant);
  const weaker = run();
  const correct = mutant.replace('state.deadline = state.destination.expiry;', 'state.deadline = activatedAt + 259200;');
  writeFileSync(join(cwd, 'src/research.mjs'), correct);
  const fixed = run();
  writeFileSync(join(cwd, 'src/research.mjs'), fixture['src/research.mjs']);
  const checks = { original: { status: original.status, output: original.stdout + original.stderr },
    weaker: { status: weaker.status, output: weaker.stdout + weaker.stderr }, fixed: { status: fixed.status, output: fixed.stdout + fixed.stderr } };
  writeFileSync(join(cwd, 'sensitivity.json'), JSON.stringify(checks, null, 2));
  assert.equal(original.status, 1, 'generated test must reject current defective product');
  assert.equal(weaker.status, 1, 'generated test must reject postponed copying of arbitrary expiry');
  assert.equal(fixed.status, 0, 'generated test must accept the approved behavior without implementation-specific demands');
  assert.match(response, /Status: DONE\s*$/);
}
if (scenario === 'weak-oracle') assert.match(response, /^Verdict: REVISE/m);
if (scenario === 'faithful-oracle') assert.match(response, /^Verdict: APPROVE/m);
if (scenario === 'support-boundary') assert.match(response, /worker-final|actor|ator/i);
// All sessions disposed and evidence flushed; provider sockets need not keep this CLI alive.
process.exit(0);
