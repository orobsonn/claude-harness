/** Opt-in paired real-reviewer probe. Isolated snapshots, no product run or mutations. */
import { execFileSync } from 'node:child_process';
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import harnessPlanningTools from '../core/pi/extensions/harness-planning-tools.ts';
import harnessBootstrap from '../core/pi/extensions/harness-bootstrap.ts';
import { writePiChildIdentity } from '../core/pi/lib/pi-child-identity.mjs';
import { decidePiPolicy } from '../core/pi/lib/policy.mjs';
import { markReviewerGrepInput, registerReviewerGrepTool } from '../core/pi/lib/reviewer-grep.mjs';
import { piDispatchRoute } from '../core/pi/lib/dispatch-rail.mjs';
import { piExecutionPlanPath, piSpecPath } from '../core/pi/lib/pi-paths.mjs';

const [sourceArg, featureId, execute] = process.argv.slice(2);
if (!sourceArg || !featureId || execute !== '--execute') throw Error('Usage: node scripts/pi-plan-analysis-pressure.mjs <source-checkout> <feature-id> --execute');
const source = resolve(sourceArg);
const planPath = piExecutionPlanPath({ projectRoot: source, featureId });
const specPath = piSpecPath({ projectRoot: source, featureId });
if (!planPath.ok || !specPath.ok) throw Error('Invalid feature');
const root = mkdtempSync(join(tmpdir(), 'pi-plan-ab-'));
const snapshot = join(root, 'snapshot');
mkdirSync(snapshot);
const role = 'harness-plan-reviewer';
const route = piDispatchRoute(role);
const limits = { calls: 4, per_call_ms: 180000, reported_cost_usd: 3, snapshot_bytes: 16777216 };
const safe = (cwd, path) => !decidePiPolicy({ toolName: 'read', input: { path } },
  { cwd, projectRoot: cwd, reviewerRole: role }).block;
const copy = (path) => {
  if (!safe(source, path)) return 'excluded';
  let cursor = source;
  for (const segment of path.split('/')) {
    cursor = join(cursor, segment);
    if (lstatSync(cursor).isSymbolicLink()) return 'symlink';
  }
  const stat = lstatSync(cursor);
  if (!stat.isFile() || stat.size > 262144) return 'not-small-regular';
  const body = readFileSync(cursor);
  if (body.includes(0)) return 'binary';
  if (bytes + body.length > limits.snapshot_bytes) return 'budget';
  bytes += body.length;
  const destination = join(snapshot, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, body);
  files.push({ path, sha256: createHash('sha256').update(body).digest('hex') });
  return 'copied';
};
let bytes = 0;
const files = [], omitted = [];
const tracked = execFileSync('git', ['-C', source, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 4194304 }).split('\0').filter(Boolean).sort();
for (const path of tracked.filter(p => /^(src\/|app\/|migrations\/|test\/|tests\/|docs\/|AGENTS\.md$|CLAUDE\.md$|README\.md$|package\.json$|tsconfig[^/]*\.json$)/.test(p))) {
  try { const status = copy(path); if (status !== 'copied') omitted.push({ path, status }); }
  catch { omitted.push({ path, status: 'missing-or-unreadable' }); }
}
for (const path of [`.pi/harness/plans/${featureId}/execution-plan.json`, `.pi/harness/plans/${featureId}/spec.md`]) {
  if (copy(path) !== 'copied') throw Error('Canonical plan/spec unavailable for snapshot');
}
const inputHash = createHash('sha256').update(JSON.stringify(files)).digest('hex');
writeFileSync(join(root, 'snapshot-manifest.json'), JSON.stringify({ files, omitted, bytes, inputHash }, null, 2));
const asset = readFileSync(new URL('../core/pi/runtime/agents/harness-plan-reviewer.md', import.meta.url), 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '');
const runtime = await ModelRuntime.create({ authPath: join(homedir(), '.pi/agent/auth.json'), modelsPath: null, allowModelNetwork: false });
// Match native launcher bootstrap: register the supported Astra compatibility
// entry without installing anything into the operator's global agent directory.
process.env.PI_HARNESS_LAUNCHER = '1';
const initialModel = runtime.getModel('openai-codex', 'gpt-5.6-sol');
if (!initialModel) throw Error('Initial SDK model unavailable; no request made');
const results = [];
let totalCost = 0;
console.log(JSON.stringify({ root, inputHash, files: files.length, omitted: omitted.length, limits, requested_model: route.model, thinking: route.thinking }));
// Counterbalanced exploratory pairs. No significance claim from this small sample.
for (const [index, enabled] of [false, true, true, false].entries()) {
  if (totalCost >= limits.reported_cost_usd) break;
  const cwd = join(root, `case-${index + 1}`);
  cpSync(snapshot, cwd, { recursive: true });
  const agentDir = join(cwd, 'agent'); mkdirSync(agentDir);
  const parent = SessionManager.create(cwd, join(cwd, 'sessions'));
  const manager = SessionManager.create(cwd, join(cwd, 'sessions'), { parentSession: parent.getSessionId() });
  if (!writePiChildIdentity(cwd, { parentSessionId: parent.getSessionId(), childSessionId: manager.getSessionId(), role, callId: `probe-${index}` }).ok) throw Error('Identity unavailable');
  const settings = SettingsManager.inMemory({ defaultProvider: 'openai-codex', defaultModel: route.model.split('/')[1], defaultThinkingLevel: route.thinking });
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt: asset,
    extensionFactories: [harnessBootstrap, async pi => {
      await harnessPlanningTools(pi, { call: null });
      registerReviewerGrepTool(pi);
      pi.on('tool_call', event => {
        const d = decidePiPolicy({ toolName: event.toolName, input: event.input }, { cwd, projectRoot: cwd, reviewerRole: role });
        if (d.reviewerGrepGuard) markReviewerGrepInput(event.input, d.reviewerGrepGuard);
        return d;
      });
    }] });
  await loader.reload();
  const toolNames = ['read', 'grep', 'find', 'ls', 'harness_complexity', ...(enabled ? ['harness_plan_analysis'] : [])];
  const { session, extensionsResult } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, model: initialModel, thinkingLevel: route.thinking,
    settingsManager: settings, resourceLoader: loader, sessionManager: manager, tools: toolNames });
  if (extensionsResult.errors.length) throw Error(JSON.stringify(extensionsResult.errors));
  await session.bindExtensions({});
  const model = runtime.getModel('openai-codex', route.model.split('/')[1]);
  if (!model) throw Error('Reviewer model unavailable after native bootstrap; no request made');
  await session.setModel(model);
  session.setActiveToolsByName(toolNames);
  const calls = [], analysisResults = [];
  let timedOut = false;
  session.subscribe(event => {
    if (event.type === 'tool_execution_start') calls.push({ name: event.toolName, args: event.args });
    if (event.type === 'tool_execution_end' && event.toolName === 'harness_plan_analysis') analysisResults.push(event.result?.details);
  });
  const started = Date.now();
  const timer = setTimeout(() => { timedOut = true; void session.abort(); }, limits.per_call_ms);
  let error;
  try {
    await session.prompt(`INITIAL plan review; stable ceremony FULL; feature_id=${featureId}. Review the proposed plan at .pi/harness/plans/${featureId}/execution-plan.json against the complete sealed spec at .pi/harness/plans/${featureId}/spec.md and the supplied code. This is an isolated retrospective pressure exercise, not a live product run. No prior verdict or run outcome is provided as authority. MV/MP are deliberately unavailable. Use only tools exposed in this session; unavailable tools must not block. Return your normal JSON verdict with concrete material findings and actionable planner instructions. Do not implement or mutate files. Snapshot coverage exclusions: ${omitted.length}; missing files may be future work, not a defect by themselves.`);
  } catch (e) { error = String(e); }
  finally { clearTimeout(timer); }
  const assistants = session.messages.filter(m => m.role === 'assistant');
  const usage = assistants.map(m => m.usage).filter(Boolean);
  const costKnown = usage.length > 0 && usage.every(u => Number.isFinite(u.cost?.total));
  const cost = costKnown ? usage.reduce((sum, u) => sum + u.cost.total, 0) : null;
  totalCost += cost ?? 0;
  const result = { index: index + 1, enabled, inputHash, elapsed_ms: Date.now() - started, model: session.model?.id, thinking: session.thinkingLevel,
    timedOut, error, cost, cost_basis: 'SDK registry estimate, not verified billing; compatibility models may inherit pricing', usage, calls, analysisResults,
    response: assistants.at(-1)?.content?.filter(p => p.type === 'text').map(p => p.text).join('\n') };
  writeFileSync(join(cwd, 'result.json'), JSON.stringify(result, null, 2));
  results.push(result);
  writeFileSync(join(root, 'results.json'), JSON.stringify({ limits, inputHash, totalCost, results }, null, 2));
  console.log(JSON.stringify({ case: index + 1, enabled, elapsed_ms: result.elapsed_ms, timedOut, cost, totalCost, calls: calls.map(c => c.name), result: join(cwd, 'result.json') }));
  await session.extensionRunner.emit({ type: 'session_shutdown' });
  session.dispose();
  if (!costKnown) { console.log(JSON.stringify({ stopped: 'usage cost unavailable; do not treat as free' })); break; }
}
await new Promise(done => process.stdout.write(JSON.stringify({ complete: results.length === limits.calls, totalCost, results: join(root, 'results.json') }) + '\n', done));
// This standalone probe has disposed every session and saved all results. The
// provider may retain pooled sockets; do not leave a completed experiment alive.
process.exit(0);
