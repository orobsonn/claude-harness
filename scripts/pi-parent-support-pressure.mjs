/** Real parent -> real read-only support -> recorded resume, isolated from consumer runs. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type, validateToolArguments } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { installNativeHarnessAgents } from '../core/pi/lib/native-bootstrap.mjs';
import { validateSubagentDispatch } from '../core/pi/lib/dispatch-rail.mjs';
import { decidePiPolicy } from '../core/pi/lib/policy.mjs';
import { registerReviewerGrepTool, markReviewerGrepInput } from '../core/pi/lib/reviewer-grep.mjs';
import harnessTasks from '../core/pi/extensions/harness-tasks.ts';
import { TASK_ACTION_FIELDS } from '../core/pi/lib/task-coordinator.mjs';

const direct = process.argv[2] === 'direct';
if (!['investigate', 'direct'].includes(process.argv[2])) throw Error('Expected investigate|direct');
const cwd = mkdtempSync(join(tmpdir(), 'pi-parent-support-'));
const agentDir = join(cwd, 'agent'); mkdirSync(agentDir);
const files = {
  'spec.md': 'The approved deadline is publication timestamp plus 259200 seconds. Job creation and destination expiry are not deadline authorities. Task-one owns implementation and tests. No new feature or permission is needed.\n',
  'evidence.md': 'Executor concerns: (1) the lease fixture creates and claims at the same second though the claim must be later; (2) tests only check deadline before publication. The implementation now copies destination.expiry during final publication, so the test passes but destination still controls deadline. Creation and publication timestamps differ. The last coordinator corrected concern 1 and omitted concern 2. All processes terminated. Preserve the existing task attempt.\n',
};
for (const [file, value] of Object.entries(files)) writeFileSync(join(cwd, file), value);
assert.equal(installNativeHarnessAgents({ agentDir }).ok, true);
const runtime = await ModelRuntime.create({ authPath: join(homedir(), '.pi/agent/auth.json'), modelsPath: null, allowModelNetwork: false });
const model = runtime.getModel('openai-codex', 'gpt-5.6-terra');
if (!model) throw Error('Terra unavailable');
const settings = SettingsManager.inMemory({ defaultProvider: 'openai-codex', defaultModel: model.id, defaultThinkingLevel: 'high' });
const reports = [], calls = [], sessions = [];
let taskSchema;
harnessTasks({ on() {}, registerTool(t) { taskSchema = t.parameters; } });
async function create(systemPrompt, readers, customTools = []) {
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt, extensionFactories: readers ? [pi => {
      registerReviewerGrepTool(pi);
      pi.on('tool_call', event => {
        const decision = decidePiPolicy({ toolName: event.toolName, input: event.input }, { cwd, projectRoot: cwd, reviewerRole: 'harness-support' });
        if (decision.reviewerGrepGuard) markReviewerGrepInput(event.input, decision.reviewerGrepGuard);
        return decision;
      });
    }] : [] });
  await loader.reload();
  const tools = readers ? ['read', 'grep', 'find', 'ls'] : customTools.map(t => t.name);
  const { session } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, model, thinkingLevel: 'high', settingsManager: settings,
    resourceLoader: loader, sessionManager: SessionManager.create(cwd, join(cwd, 'sessions')), tools, customTools });
  await session.bindExtensions({}); session.setActiveToolsByName(tools); sessions.push(session);
  return session;
}
const body = session => session.messages.filter(m => m.role === 'assistant').at(-1)?.content?.filter(p => p.type === 'text').map(p => p.text).join('\n') ?? '';
const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], details: value });
const dispatch = { name: 'subagent', label: 'Diagnostic reader', description: 'Dispatch an available harness role. Only harness-support is available in this isolated diagnostic exercise; product writers are never executed here.',
  parameters: Type.Object({ subagent_type: Type.String(), prompt: Type.String(), model: Type.String(), thinking: Type.String(), inherit_context: Type.Optional(Type.Boolean()), description: Type.Optional(Type.String()) }, { additionalProperties: false }),
  async execute(id, raw) {
    const args = validateToolArguments(dispatch, { id, name: 'subagent', arguments: raw });
    assert.equal(args.subagent_type, 'harness-support');
    assert.equal(validateSubagentDispatch(args).ok, true);
    assert.ok(reports.length < 3, 'probe stops excess diagnostic spending');
    calls.push({ name: 'subagent', args });
    const asset = readFileSync(join(agentDir, 'agents/harness-support.md'), 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '');
    const child = await create(asset, true);
    await child.prompt(args.prompt);
    const report = body(child); reports.push(report);
    return result({ status: 'completed', report });
  } };
const tasks = { name: 'harness_tasks', label: 'Recorded task recovery', description: 'Observe or resume the existing task. In this experiment resume is recorded, not executed.', parameters: taskSchema,
  async execute(id, raw) {
    const args = validateToolArguments(tasks, { id, name: 'harness_tasks', arguments: raw });
    assert.ok(['status', 'resume'].includes(args.action));
    const fields = TASK_ACTION_FIELDS[args.action];
    assert.ok(Object.keys(args).every(k => fields.includes(k) || args.action === 'status' && k === 'wait_seconds'));
    calls.push({ name: 'harness_tasks', args });
    return result({ ok: true, tasks: [{ task_id: 'task-one', attempt_id: 'existing-attempt', status: 'blocked', processes: 'terminated',
      reason: direct ? 'Only regate-passed is missing. Capture and all reviews are current; no product or test delta.' : 'Conflicting fixture/implementation reports; see spec.md and evidence.md before choosing a correction.' }] });
  } };
const parent = await create(readFileSync(new URL('../core/pi/prompts/harness-runtime.md', import.meta.url), 'utf8'), false, [dispatch, tasks]);
const started = Date.now(); let timedOut = false;
const timer = setTimeout(() => { timedOut = true; for (const session of sessions) void session.abort(); }, 180000);
console.log(JSON.stringify({ cwd, direct, model: model.id }));
let error;
try {
  await parent.prompt(`You are the global FULL coordinator, feature fixture, stable approved plan with existing task-one. This is a bounded decision experiment, not product execution. Status and resume are recorded. Diagnose and record the next precise recovery in the owning task; stop after resume. Do not create a new task. ${direct ? 'The cause is already known: only regate-passed is missing, capture and reviews are current. No investigation is needed.' : 'Previous fixture corrections did not resolve the repeated deadline concern. You do not have the source context in this prompt; spec.md and evidence.md hold the necessary facts. Use your available read-only support when it is useful to understand the contradiction before redispatching.'}`);
} catch (e) { error = String(e); }
finally { clearTimeout(timer); }
const usage = sessions.flatMap(s => s.messages.filter(m => m.role === 'assistant').map(m => m.usage));
const cost = usage.reduce((sum, u) => sum + (u?.cost?.total ?? 0), 0);
const output = { direct, calls, reports, response: body(parent), timedOut, error, elapsed_ms: Date.now() - started, usage, cost, cost_basis: 'SDK estimate, not verified billing' };
writeFileSync(join(cwd, 'result.json'), JSON.stringify(output, null, 2));
for (const s of sessions) { await s.extensionRunner.emit({ type: 'session_shutdown' }); s.dispose(); }
console.log(JSON.stringify({ result: join(cwd, 'result.json'), calls, cost, elapsed_ms: output.elapsed_ms }));
assert.equal(timedOut, false); assert.equal(error, undefined);
const resumes = calls.filter(c => c.name === 'harness_tasks' && c.args.action === 'resume');
assert.equal(resumes.length, 1); assert.equal(resumes[0].args.task_id, 'task-one');
if (direct) { assert.equal(reports.length, 0); assert.match(resumes[0].args.instruction, /regate-passed/); }
else { assert.ok(reports.length > 0 && reports.length <= 3); assert.match(resumes[0].args.instruction, /public|publish/i); assert.match(resumes[0].args.instruction, /lease|fixture/i); }
for (const [file, value] of Object.entries(files)) assert.equal(readFileSync(join(cwd, file), 'utf8'), value);
process.exit(0);
