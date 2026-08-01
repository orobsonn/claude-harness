#!/usr/bin/env node
/**
 * @description Headless probe for PR4.3 canonical-plan authority. It vendors a fresh OC runtime,
 * positively calls source and vendored plugin factories, and uses structural state/byte/tool facts
 * as its only oracles. The expensive installed-OpenCode scenarios are opt-in behind OC_RUNTIME_PROBE=1.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const OPENCODE_BIN = process.env.OPENCODE_BIN || "opencode";
const EXPECTED_OC_VERSION = process.env.EXPECTED_OC_VERSION || "1.18.10";
const KEEP_TEMP = process.env.KEEP_PROBE_TMP === "1";
const HELPER_TIMEOUT_MS = 30_000;
const VENDOR_TIMEOUT_MS = 120_000;
// Planner/reviewer latency is provider-bound; a shorter local ceiling produced a false negative
// after the same real planner had already completed twice with valid bound plans.
const HOST_PROCESS_TIMEOUT_MS = 240_000;
const HOST_REVIEW_TIMEOUT_MS = 480_000;
const PLANNER_SUMMARY_PATTERN =
  /^Plano gerado com \d+ tasks? \(\d+ high \/ \d+ medium \/ \d+ low\)\. Tasks com adversarial: \[(?:[A-Za-z0-9._-]+(?:,\s*[A-Za-z0-9._-]+)*)?\]\.$/;
// Real host proof stays deliberately small: one cheap hand exposes official Write in a real run.
// Role-independent hook coverage is derived from the fresh vendored agent catalog;
// child permission refusals or absent child tool_use events would be false evidence.
const HOST_WRITE_ROLES = ["executor-low"];
const HOST_FIXED_RUNS = 7;
const HOST_MAX_RUNS = HOST_FIXED_RUNS + HOST_WRITE_ROLES.length;
let hostRunCount = 0;
const args = new Set(process.argv.slice(2));

if ([...args].some((arg) => arg !== "--module-smoke" && arg !== "--host")) {
  throw new Error("usage: probe-oc-plan-authority-headless.mjs [--module-smoke] [--host]");
}
const runModuleSmoke = args.size === 0 || args.has("--module-smoke");
const runHost = args.has("--host");

function pass(message) {
  process.stdout.write(`PASS: ${message}\n`);
}

function bytes(path) {
  return existsSync(path) ? readFileSync(path) : null;
}

function sameBytes(actual, expected, label) {
  assert.equal(actual === null, expected === null, `${label}: existence changed`);
  if (actual !== null && expected !== null) assert.equal(Buffer.compare(actual, expected), 0, `${label}: bytes changed`);
}

function vendorFresh(root) {
  const vendor = join(REPO_ROOT, "core/claude-code/skills/initializing-projects/references/vendor-core.mjs");
  execFileSync("node", [vendor, "--source", REPO_ROOT, "--target", root, "--runtime", "opencode"], {
    cwd: REPO_ROOT,
    stdio: "pipe",
    timeout: VENDOR_TIMEOUT_MS,
  });
  assert.ok(existsSync(join(root, ".opencode", "plugin", "planner-recovery.ts")), "fresh vendor lacks planner-recovery");
}

function vendoredAgentCatalog(root) {
  const roles = readdirSync(join(root, ".opencode", "agents"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name.slice(0, -3))
    .sort();
  assert.ok(roles.length > 0, "fresh vendored agent catalog is empty");
  return roles;
}

function vendoredEditPermissionFacts(root, roles) {
  const denied = [];
  const allowed = [];
  for (const role of roles) {
    const source = readFileSync(join(root, ".opencode", "agents", `${role}.md`), "utf8");
    const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
    const scalar = frontmatter.match(/^  edit:\s*(allow|deny)\s*$/m)?.[1];
    const editBlock = frontmatter.match(/^  edit:\s*\r?\n((?:    .*\r?\n?)*)/m)?.[1] ?? "";
    if (scalar === "deny") denied.push(role);
    else if (scalar === "allow") allowed.push(role);
    else if (/^    ["']?\*["']?:\s*deny\s*$/m.test(editBlock)) denied.push(role);
    else throw new Error(`vendored agent ${role} has no explicit canonical-write edit disposition`);
  }
  return { allowed, denied };
}

function modelStrategy() {
  return {
    hand_tiers: { low: "gemma4", medium: "glm-5.2", high: "kimi-k2.7-code" },
    planner: "openai/gpt-5.6-sol",
    "plan-reviewer": "openai/gpt-5.6-sol",
    compliance: "openai/gpt-5.6-terra",
    adversary: "openai/gpt-5.6-sol",
    security: "openai/gpt-5.6-sol",
    shipper: "openai/gpt-5.6-luna",
    harvester: "openai/gpt-5.6-luna",
  };
}

function validPlan(featureId, strategy = modelStrategy()) {
  return {
    feature_id: featureId,
    kind: "full",
    mode: "full",
    model_strategy: strategy,
    tasks: [{
      id: "probe-task",
      summary: "Preserve the deterministic probe behavior",
      severity: "medium",
      complexity: "medium",
      depends_on: [],
      scope_paths: ["src/probe.ts"],
      resolved_judgments: { probe_contract: "return deterministic sentinel" },
      criterion_refs: ["#ac-1"],
      locked_tests: [{
        id: "probe-test",
        path: "src/probe.test.mjs",
        assertion: "Given the probe module, When probeValue runs, Then it returns PLAN_AUTHORITY_PROBE",
      }],
      adversarial: { enabled: false, focus: [] },
    }],
  };
}

function paths(root, sessionId, featureId) {
  const stateDir = join(root, ".opencode", "plans", ".state", sessionId);
  return {
    stateDir,
    state: join(stateDir, "gate-state.json"),
    canonical: join(root, ".opencode", "plans", `${sessionId}-${featureId}`, "execution-plan.json"),
    events: join(root, "probe-observability.events.jsonl"),
  };
}

function seedPlannerState(root, sessionId, featureId, extra = {}) {
  const p = paths(root, sessionId, featureId);
  mkdirSync(p.stateDir, { recursive: true });
  mkdirSync(dirname(p.canonical), { recursive: true });
  writeFileSync(p.state, JSON.stringify({
    session_id: sessionId,
    feature_id: featureId,
    classified: true,
    mode: "full",
    brainstormed: true,
    adversary_fired: true,
    ...extra,
  }));
  return p;
}

function callVendoredDefaultFactories(root) {
  const helper = join(root, "probe-vendored-plan-authority-fact.mjs");
  const factPath = join(root, "probe-vendored-plan-authority-fact.json");
  writeFileSync(helper, `import { writeFileSync } from "node:fs";
import PlannerRecovery from "./.opencode/plugin/planner-recovery.ts";
import PlanGate from "./.opencode/plugin/plan-gate.ts";
import PlanWriteGate from "./.opencode/plugin/plan-write-gate.ts";
import obsPlanWrite from "./.opencode/plugin/obs-plan-write.ts";

const root = process.argv[2];
const factPath = process.argv[3];
const entries = [];
for (const [name, factory] of [
  ["planner-recovery", PlannerRecovery],
  ["plan-gate", PlanGate],
  ["plan-write-gate", PlanWriteGate],
  ["obs-plan-write", obsPlanWrite],
]) {
  if (typeof factory !== "function") throw new Error(name + " missing default factory");
  const hooks = await factory({ directory: root });
  if (!hooks || typeof hooks !== "object") throw new Error(name + " factory returned no hooks");
  entries.push({ name, hook_names: Object.keys(hooks).sort() });
}
writeFileSync(factPath, JSON.stringify(entries));
`);
  execFileSync("node", [helper, root, factPath], { cwd: root, stdio: "pipe", timeout: HELPER_TIMEOUT_MS });
  const entries = JSON.parse(readFileSync(factPath, "utf8"));
  assert.deepEqual(entries.map((entry) => entry.name), [
    "planner-recovery", "plan-gate", "plan-write-gate", "obs-plan-write",
  ], "vendored helper omitted or reordered an authority factory");
  for (const entry of entries) {
    assert.ok(Array.isArray(entry.hook_names) && entry.hook_names.length > 0, `vendored/${entry.name}: no hooks`);
  }
  pass("vendored: static-import helper calls all four default factories and records hooks");
}

function staticSourceSpecifier(relative) {
  return JSON.stringify(pathToFileURL(join(REPO_ROOT, relative)).href);
}

function sourcePlanFacts(root, canonicalPath = "") {
  const helper = join(root, "probe-source-plan-authority-host-fact.mjs");
  const factPath = join(root, "probe-source-plan-authority-host-fact.json");
  writeFileSync(helper, `import { readFileSync, writeFileSync } from "node:fs";
import { projectExpectedModelStrategy } from ${staticSourceSpecifier("core/shared/lib/model-strategy-projection.mjs")};
import { semanticPlanHash } from ${staticSourceSpecifier("core/opencode/lib/planner-artifact.mjs")};

const root = process.argv[2];
const canonicalPath = process.argv[3];
const factPath = process.argv[4];
const routing = JSON.parse(readFileSync(root + "/.opencode/harness.routing.json", "utf8"));
const projected = projectExpectedModelStrategy(routing);
if (!projected.ok) throw new Error("vendored routing has no expected model strategy");
const fact = { strategy: projected.strategy };
if (canonicalPath) fact.semantic_hash = semanticPlanHash(JSON.parse(readFileSync(canonicalPath, "utf8")));
writeFileSync(factPath, JSON.stringify(fact));
`);
  execFileSync("node", [helper, root, canonicalPath, factPath], { cwd: root, stdio: "pipe", timeout: HELPER_TIMEOUT_MS });
  return JSON.parse(readFileSync(factPath, "utf8"));
}

function classifyPlannerResultViaSource(root, response, expectedModelStrategy) {
  const helper = join(root, "probe-source-planner-result.mjs");
  const inputPath = join(root, "probe-source-planner-result-input.json");
  const factPath = join(root, "probe-source-planner-result-fact.json");
  writeFileSync(inputPath, JSON.stringify({ response, expectedModelStrategy }));
  writeFileSync(helper, `import { readFileSync, writeFileSync } from "node:fs";
import { classifyPlannerResult } from ${staticSourceSpecifier("core/opencode/plugin/lib/planner-result.mjs")};
const input = JSON.parse(readFileSync(process.argv[2], "utf8"));
writeFileSync(process.argv[3], JSON.stringify(classifyPlannerResult(input.response, {
  expectedModelStrategy: input.expectedModelStrategy,
})));
`);
  execFileSync("node", [helper, inputPath, factPath], { cwd: root, stdio: "pipe", timeout: HELPER_TIMEOUT_MS });
  return JSON.parse(readFileSync(factPath, "utf8"));
}

function callSourceModuleOracles(root, directRoles, editPermissionFacts) {
  const helper = join(root, "probe-source-plan-authority-fact.mjs");
  const factPath = join(root, "probe-source-plan-authority-fact.json");
  writeFileSync(helper, `import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import PlannerRecovery, { createPlannerRecoveryHooks } from ${staticSourceSpecifier("core/opencode/plugin/planner-recovery.ts")};
import PlanGate from ${staticSourceSpecifier("core/opencode/plugin/plan-gate.ts")};
import PlanWriteGate, { createPlanWriteGateHooks } from ${staticSourceSpecifier("core/opencode/plugin/plan-write-gate.ts")};
import obsPlanWrite, { createObsPlanWriteHooks } from ${staticSourceSpecifier("core/opencode/plugin/obs-plan-write.ts")};

const root = process.argv[2];
const factPath = process.argv[3];
const sessionId = "ses_probe_authority";
const featureId = "plan-authority";
const stateDir = join(root, ".opencode", "plans", ".state", sessionId);
const statePath = join(stateDir, "gate-state.json");
const canonical = join(root, ".opencode", "plans", sessionId + "-" + featureId, "execution-plan.json");
const canonicalRel = ".opencode/plans/" + sessionId + "-" + featureId + "/execution-plan.json";
const facts = [];
const sameBytes = (actual, expected, label) => {
  assert.equal(actual === null, expected === null, label + ": existence changed");
  if (actual !== null && expected !== null) assert.equal(Buffer.compare(actual, expected), 0, label + ": bytes changed");
};
const readBytes = (path) => existsSync(path) ? readFileSync(path) : null;

for (const [name, factory] of [
  ["planner-recovery", PlannerRecovery], ["plan-gate", PlanGate],
  ["plan-write-gate", PlanWriteGate], ["obs-plan-write", obsPlanWrite],
]) {
  assert.equal(typeof factory, "function", name + " missing default factory");
  const hooks = await factory({ directory: root });
  assert.ok(hooks && typeof hooks === "object", name + " returned no hooks");
}
facts.push("source-default-factories");

mkdirSync(stateDir, { recursive: true });
mkdirSync(dirname(canonical), { recursive: true });
writeFileSync(statePath, JSON.stringify({ session_id: sessionId, feature_id: featureId, classified: true }));
writeFileSync(join(root, ".opencode", "harness.routing.json"), readFileSync(${JSON.stringify(join(REPO_ROOT, "core/opencode/harness.routing.json"))}));
const recovery = await createPlannerRecoveryHooks(root, { token: () => "probe-token" });
await recovery["tool.execute.before"]({ tool: "task", sessionID: sessionId, callID: "planner-call" }, { args: { subagent_type: "planner", prompt: "plan" } });
const frozen = JSON.parse(readFileSync(statePath, "utf8")).planner_active_attempt?.expected_model_strategy;
assert.ok(frozen && typeof frozen === "object", "planner did not freeze strategy");
writeFileSync(join(root, ".opencode", "harness.routing.json"), "{ invalid routing");
const duplicateArgs = { subagent_type: "planner", prompt: "plan again" };
await recovery["tool.execute.before"]({ tool: "task", sessionID: sessionId, callID: "planner-call" }, { args: duplicateArgs });
assert.deepEqual(JSON.parse(readFileSync(statePath, "utf8")).planner_active_attempt?.expected_model_strategy, frozen, "duplicate before replaced strategy");
assert.match(duplicateArgs.prompt, /HARNESS_EXPECTED_MODEL_STRATEGY/);
facts.push("frozen-duplicate-before");

let resolverCalls = 0;
const writeGate = await createPlanWriteGateHooks(root, { resolveRuntimeIdentity: async () => { resolverCalls += 1; throw new Error("resolver ran"); } });
const directRoles = ${JSON.stringify(directRoles)};
const officialTools = ["write", "edit", "delete", "apply_patch"];
for (const role of directRoles) for (const tool of officialTools) {
  const args = tool === "apply_patch"
    ? { patch: "*** Update File: " + canonicalRel + "\\n@@\\n-{}\\n+[]" }
    : { filePath: canonicalRel, content: "{}" };
  await assert.rejects(
    () => writeGate["tool.execute.before"]({ tool, sessionID: sessionId, agent: role }, { args }),
    /\\[plan-write-gate\\].*canonical plan/i,
    role + "/" + tool,
  );
}
assert.equal(resolverCalls, 0, directRoles.length * officialTools.length + " canonical calls reached identity");
facts.push({
  oracle: "canonical-before-identity",
  catalog_roles: directRoles.length,
  platform_edit_denied: ${editPermissionFacts.denied.length},
  platform_edit_allowed_then_hook_guarded: ${editPermissionFacts.allowed.length},
  tools: officialTools,
});

const legacySessionId = "ses_probe_legacy";
const legacyFeatureId = "legacy-plan-authority";
const legacyStateDir = join(root, ".opencode", "plans", ".state", legacySessionId);
const legacyStatePath = join(legacyStateDir, "gate-state.json");
const legacyCanonical = join(root, ".opencode", "plans", legacySessionId + "-" + legacyFeatureId, "execution-plan.json");
mkdirSync(legacyStateDir, { recursive: true });
mkdirSync(dirname(legacyCanonical), { recursive: true });
writeFileSync(legacyStatePath, JSON.stringify({ session_id: legacySessionId, feature_id: legacyFeatureId, classified: true }));
writeFileSync(join(root, ".opencode", "harness.routing.json"), readFileSync(${JSON.stringify(join(REPO_ROOT, "core/opencode/harness.routing.json"))}));
const legacyRecovery = await createPlannerRecoveryHooks(root, { token: () => "legacy-token" });
const legacyArgs = { subagent_type: "planner", prompt: "Return legacy plan." };
await legacyRecovery["tool.execute.before"](
  { tool: "task", sessionID: legacySessionId, callID: "legacy-call" },
  { args: legacyArgs },
);
const legacyFrozen = JSON.parse(readFileSync(legacyStatePath, "utf8")).planner_active_attempt.expected_model_strategy;
const legacyStrategy = { ...legacyFrozen, tiers: legacyFrozen.hand_tiers };
delete legacyStrategy.hand_tiers;
const legacyPlan = {
  feature_id: legacyFeatureId,
  kind: "full",
  mode: "full",
  model_strategy: legacyStrategy,
  tasks: [{
    id: "legacy-task",
    severity: "medium",
    complexity: "medium",
    depends_on: [],
    scope_paths: ["src/legacy.ts"],
    criterion_refs: ["#ac-1"],
    locked_tests: [{
      id: "legacy-test",
      path: "src/legacy.test.mjs",
      assertion: "Given legacy strategy, When classified, Then it remains unbound",
    }],
  }],
};
await legacyRecovery["tool.execute.after"](
  { tool: "task", sessionID: legacySessionId, callID: "legacy-call", args: legacyArgs },
  { output: JSON.stringify(legacyPlan), metadata: {} },
);
const legacyState = JSON.parse(readFileSync(legacyStatePath, "utf8"));
assert.equal(legacyState.planner_status, "plan_invalid", "legacy strategy did not become plan_invalid");
assert.equal(legacyState.planner_plan_binding ?? null, null, "legacy strategy unexpectedly bound a plan");
assert.equal(existsSync(legacyCanonical), false, "legacy strategy wrote canonical bytes");
facts.push("legacy-plan-rejected-byte-neutral");

const bashGate = await createPlanWriteGateHooks(root, { resolveRuntimeIdentity: async () => ({ ok: false, notWritingSession: true, reason: "not child" }) });
await assert.rejects(() => bashGate["tool.execute.before"]({ tool: "bash", sessionID: sessionId }, { args: { command: "printf '{}' > " + canonicalRel } }), /\\[plan-write-gate\\].*literal Bash mutation/i);
await assert.doesNotReject(() => bashGate["tool.execute.before"]({ tool: "bash", sessionID: sessionId }, { args: { command: "cp " + canonicalRel + " /tmp/probe-plan-copy.json" } }));
facts.push("bash-friction-read-copy");

writeFileSync(canonical, JSON.stringify({ feature_id: featureId, kind: "full", mode: "full", tasks: [] }));
const beforeState = readBytes(statePath);
const beforeCanonical = readBytes(canonical);
const oldObsPath = process.env.HARNESS_OBSERVABILITY_RUN_PATH;
const obsPath = join(root, "probe-observability.json");
process.env.HARNESS_OBSERVABILITY_RUN_PATH = obsPath;
writeFileSync(obsPath, "{}");
try {
  const observer = await createObsPlanWriteHooks(root);
  await observer["tool.execute.after"]({ tool: "write", sessionID: sessionId }, { args: { filePath: canonicalRel, content: "forbidden" } });
} finally {
  if (oldObsPath === undefined) delete process.env.HARNESS_OBSERVABILITY_RUN_PATH;
  else process.env.HARNESS_OBSERVABILITY_RUN_PATH = oldObsPath;
}
sameBytes(readBytes(statePath), beforeState, "observer state");
sameBytes(readBytes(canonical), beforeCanonical, "observer canonical");
const events = join(root, "probe-observability.events.jsonl");
assert.doesNotMatch(existsSync(events) ? readFileSync(events, "utf8") : "", /plan-created/);
facts.push("observer-byte-neutral");
writeFileSync(factPath, JSON.stringify(facts));
`);
  execFileSync("node", [helper, root, factPath], { cwd: root, stdio: "pipe", timeout: HELPER_TIMEOUT_MS });
  assert.deepEqual(JSON.parse(readFileSync(factPath, "utf8")), [
    "source-default-factories", "frozen-duplicate-before",
    {
      oracle: "canonical-before-identity",
      catalog_roles: directRoles.length,
      platform_edit_denied: editPermissionFacts.denied.length,
      platform_edit_allowed_then_hook_guarded: editPermissionFacts.allowed.length,
      tools: ["write", "edit", "delete", "apply_patch"],
    },
    "legacy-plan-rejected-byte-neutral",
    "bash-friction-read-copy", "observer-byte-neutral",
  ], "source module oracle facts are incomplete");
}

function strictParserOracles(tempRoot) {
  const approvedSpec = hostApprovedSpec();
  assert.match(approvedSpec, /Delivery mode: FULL\. This is not a QUICK hotfix\./);
  assert.match(approvedSpec, /concurrent state store/);
  assert.match(approvedSpec, /id="uj-1"/);
  for (const criterion of ["ac-1", "ac-2", "ac-3"]) {
    assert.match(approvedSpec, new RegExp(`id="${criterion}"`), `DIRECT host spec lacks ${criterion}`);
  }
  for (const scopePath of ["src/probe.ts", "src/probe-store.ts", "src/probe-view.ts", "src/probe.test.mjs"]) {
    assert.match(approvedSpec, new RegExp(scopePath.replace(".", "\\.")), `DIRECT host spec lacks ${scopePath}`);
  }
  const valid = parseNdjson(JSON.stringify({
    type: "tool_use",
    sessionID: "ses_parser",
    part: {
      type: "tool",
      tool: "Task",
      callID: "call_parser",
      messageID: "msg_parser",
      state: {
        status: "completed",
        input: { subagent_type: "planner" },
        output: "{}",
        time: { start: 101, end: 202 },
      },
    },
  }), "DIRECT parser");
  assert.deepEqual(toolFacts(valid), [{
    tool: "task",
    callId: "call_parser",
    messageId: "msg_parser",
    sessionId: "ses_parser",
    status: "completed",
    input: { subagent_type: "planner" },
    output: "{}",
    error: "",
    timeStart: 101,
    timeEnd: 202,
  }]);
  assert.equal(toolFacts([{ type: "message", part: { tool: "Task", state: { status: "completed" } } }]).length, 0);
  assert.throws(() => parseNdjson("{broken", "DIRECT malformed parser"), /malformed JSON object/);
  assert.throws(
    () => parseNdjson(
      '{"type":"ok"}\nCORRUPT NDJSON RECORD\n{"type":"also-ok"}',
      "DIRECT partially corrupt parser",
    ),
    /malformed JSON object on NDJSON line 2/,
  );
  assert.throws(
    () => parseNdjson("\u001b[31mBARE ANSI GARBAGE\u001b[0m", "DIRECT ANSI garbage parser"),
    /malformed JSON object on NDJSON line 1/,
  );

  const parserPlan = validPlan("parser-feature");
  const plannerPrompt =
    `[HARNESS_SESSION_FEATURE_ID]parser-feature[/HARNESS_SESSION_FEATURE_ID]\n` +
    `[HARNESS_EXPECTED_MODEL_STRATEGY]\n${JSON.stringify(modelStrategy())}\n[/HARNESS_EXPECTED_MODEL_STRATEGY]`;
  assert.doesNotThrow(() =>
    assertPlannerPromptFacts(plannerPrompt, "parser-feature", modelStrategy(), "DIRECT planner prompt"));
  assert.throws(
    () => assertPlannerPromptFacts(
      plannerPrompt.replace("parser-feature", "wrong-feature"),
      "parser-feature",
      modelStrategy(),
      "DIRECT wrong planner feature",
    ),
    /frozen feature marker differs/,
  );
  const wrongStrategy = structuredClone(modelStrategy());
  wrongStrategy.planner = "wrong/model";
  assert.throws(
    () => assertPlannerPromptFacts(
      plannerPrompt.replace(JSON.stringify(modelStrategy()), JSON.stringify(wrongStrategy)),
      "parser-feature",
      modelStrategy(),
      "DIRECT wrong planner strategy",
    ),
    /frozen strategy marker differs/,
  );
  assert.throws(
    () => assertPlannerPromptFacts(`${plannerPrompt}\n${plannerPrompt}`, "parser-feature", modelStrategy(), "DIRECT duplicate planner markers"),
    /exactly one HARNESS_SESSION_FEATURE_ID block/,
  );
  const parserSemanticHash = sourcePlanFacts(tempRoot, (() => {
    const path = join(tempRoot, "probe-parser-bound-plan.json");
    writeFileSync(path, JSON.stringify(parserPlan));
    return path;
  })()).semantic_hash;
  const boundPrompt =
    `[HARNESS_BOUND_PLAN sha256=${parserSemanticHash}]\n${JSON.stringify(parserPlan)}\n[/HARNESS_BOUND_PLAN]`;
  assert.doesNotThrow(() =>
    assertBoundPlanPromptFacts(boundPrompt, parserSemanticHash, parserPlan, "DIRECT bound-plan prompt"));
  assert.throws(
    () => assertBoundPlanPromptFacts(
      boundPrompt.replace(parserSemanticHash, "0".repeat(64)),
      parserSemanticHash,
      parserPlan,
      "DIRECT wrong bound-plan hash",
    ),
    /semantic hash differs/,
  );
  const changedBoundPlan = structuredClone(parserPlan);
  changedBoundPlan.tasks[0].id = "changed-bound-task";
  assert.throws(
    () => assertBoundPlanPromptFacts(
      `[HARNESS_BOUND_PLAN sha256=${parserSemanticHash}]\n${JSON.stringify(changedBoundPlan)}\n[/HARNESS_BOUND_PLAN]`,
      parserSemanticHash,
      parserPlan,
      "DIRECT changed bound plan",
    ),
    /JSON differs from canonical/,
  );
  assert.throws(
    () => assertBoundPlanPromptFacts(
      `[HARNESS_BOUND_PLAN sha256=${parserSemanticHash}]\n{\"feature_id\":`,
      parserSemanticHash,
      parserPlan,
      "DIRECT truncated bound plan",
    ),
    /canonical HARNESS_BOUND_PLAN block/,
  );
  const completedEnvelope =
    `<task id="task_123" state="completed"><task_result>${JSON.stringify(parserPlan)}\n` +
    "Plano gerado com 1 task (0 high / 1 medium / 0 low). Tasks com adversarial: []." +
    "</task_result></task>";
  assert.match(
    "Plano gerado com 2 tasks (1 high / 1 medium / 0 low). Tasks com adversarial: [task-1, task-2].",
    PLANNER_SUMMARY_PATTERN,
  );
  assert.deepEqual(
    parsePlannerTaskPlan(tempRoot, completedEnvelope, modelStrategy(), "DIRECT completed planner Task envelope"),
    parserPlan,
  );
  assert.deepEqual(
    parsePlanReviewTaskResult(
      `<task id="task_review" state="completed"><task_result>{"verdict":"APPROVE","findings":[]}\nO plano aprovado tem 1 tarefa; não há risco adicional.</task_result></task>`,
      "DIRECT completed plan-reviewer Task envelope",
    ),
    { verdict: "APPROVE", findings: [], summary: "O plano aprovado tem 1 tarefa; não há risco adicional." },
  );
  assert.throws(
    () => completedTaskResultText(`<task id="task_123" state="incomplete"><task_result>{}</task_result></task>`, "DIRECT incomplete Task envelope"),
    /state must be exactly completed/,
  );
  assert.throws(
    () => completedTaskResultText(`<task id="task_123" state="error"><task_result>{}</task_result></task>`, "DIRECT error Task envelope"),
    /state must be exactly completed/,
  );
  assert.throws(
    () => completedTaskResultText(`<task id="task_123" state="completed"><task_result>{}</task_result><task_result>{}</task_result></task>`, "DIRECT ambiguous Task envelope"),
    /exactly one task_result/,
  );
  assert.throws(
    () => completedTaskResultText(`<task id="task_123" state="completed"><task_result>{}</task_result><extra /></task>`, "DIRECT malformed Task envelope"),
    /exactly one task_result/,
  );
  assert.throws(
    () => parsePlanReviewTaskResult(
      `<task id="task_review" state="completed"><task_result>{"verdict":"REVISE","findings":[]}\nPlano precisa de revisão.</task_result></task>`,
      "DIRECT REVISE plan-reviewer Task envelope",
    ),
    /REVISE must carry at least one high finding/,
  );
  const reviseFinding = {
    area: "locked-test",
    severity: "high",
    task_id: "probe-task",
    problem: "Evidence: docs/specs/plan-authority-probe.md:<Acceptance criteria> — locked coverage is incomplete",
    planner_instruction: "Add the missing observable case",
  };
  assert.deepEqual(
    parsePlanReviewTaskResult(
      `<task id="task_review" state="completed"><task_result>${JSON.stringify({ verdict: "REVISE", findings: [reviseFinding] })}\nPlano precisa de revisão por risco alto.</task_result></task>`,
      "DIRECT valid REVISE plan-reviewer Task envelope",
    ),
    {
      verdict: "REVISE",
      findings: [reviseFinding],
      summary: "Plano precisa de revisão por risco alto.",
    },
  );
  assert.throws(
    () => parsePlanReviewTaskResult(
      `<task id="task_review" state="completed"><task_result>${JSON.stringify({ verdict: "APPROVE", findings: [reviseFinding] })}\nPlano aprovado apesar do risco.</task_result></task>`,
      "DIRECT invalid APPROVE-high plan-reviewer Task envelope",
    ),
    /APPROVE cannot carry a high finding/,
  );
  assert.throws(
    () => parsePlanReviewTaskResult(
      `<task id="task_review" state="completed"><task_result>{"verdict":"APPROVE","findings":[]}</task_result></task>`,
      "DIRECT summary-less plan-reviewer Task envelope",
    ),
    /pt-BR product summary/,
  );
  assert.throws(
    () => parsePlanReviewTaskResult(
      `<task id="task_review" state="completed"><task_result>{"verdict":"APPROVE","findings":[]}\n[] Plano aprovado com 1 tarefa.</task_result></task>`,
      "DIRECT structural-token plan-reviewer summary",
    ),
    /one short pt-BR product summary line/,
  );
  assert.throws(
    () => parsePlanReviewTaskResult(
      `<task id="task_review" state="completed"><task_result>{"verdict":"APPROVE","findings":[]}\nPlano aprovado. {"verdict":"REVISE"}</task_result></task>`,
      "DIRECT trailing-object plan-reviewer summary",
    ),
    /one short pt-BR product summary line/,
  );
  assert.throws(
    () => parsePlanReviewTaskResult(
      `<task id="task_review" state="completed"><task_result>{"verdict":"APPROVE","findings":[]}\nPlano aprovado. ["extra"]</task_result></task>`,
      "DIRECT trailing-array plan-reviewer summary",
    ),
    /one short pt-BR product summary line/,
  );
  assert.throws(
    () => parsePlanReviewTaskResult(
      `<task id="task_review" state="completed"><task_result>{"verdict":"APPROVE","findings":[]}\nPlano aprovado com 1 tarefa.\nRisco adicional inexistente.</task_result></task>`,
      "DIRECT multiline plan-reviewer summary",
    ),
    /one short pt-BR product summary line/,
  );
  assert.equal(exactBashCommandFact({ tool: "bash", input: { command: "printf '{}' > plan.json" } }, "printf '{}' > plan.json"), true);
  assert.equal(exactBashCommandFact({ tool: "bash", input: { command: "printf '{}' > other.json" } }, "printf '{}' > plan.json"), false);
  assert.equal(exactWriteFact({ tool: "write", input: { filePath: "plan.json", content: "{}" } }, "plan.json", "{}"), true);
  assert.equal(exactWriteFact({ tool: "write", input: { filePath: "other.json", content: "{}" } }, "plan.json", "{}"), false);
  assert.equal(
    exactWriteFact(
      { tool: "write", input: { filePath: "/tmp/probe/.opencode/plans/ses_write-feature/execution-plan.json", content: "{}" } },
      ".opencode/plans/ses_write-feature/execution-plan.json",
      "{}",
    ),
    true,
  );
  assert.equal(
    exactWriteFact(
      { tool: "write", input: { filePath: "relative-prefix/.opencode/plans/ses_write-feature/execution-plan.json", content: "{}" } },
      ".opencode/plans/ses_write-feature/execution-plan.json",
      "{}",
    ),
    false,
  );
  assert.equal(
    exactReadPathFact(
      { tool: "read", input: { filePath: "/tmp/probe/.opencode/plans/.state/ses_read/gate-state.json" } },
      ".opencode/plans/.state/ses_read/gate-state.json",
    ),
    true,
  );
  assert.equal(
    exactReadPathFact(
      { tool: "read", input: { path: ".opencode/plans/ses_read-feature/spec.md" } },
      ".opencode/plans/ses_read-feature/spec.md",
    ),
    true,
  );
  assert.equal(
    exactReadPathFact(
      { tool: "read", input: { filePath: ".opencode/plans/ses_read-other/spec.md" } },
      ".opencode/plans/ses_read-feature/spec.md",
    ),
    false,
  );
  assert.equal(
    exactReadPathFact(
      { tool: "read", input: { filePath: "relative-prefix/.opencode/plans/ses_read-feature/spec.md" } },
      ".opencode/plans/ses_read-feature/spec.md",
    ),
    false,
  );
  assert.equal(
    exactReadPathFact(
      { tool: "read", input: { filePath: "../.opencode/plans/ses_read-feature/spec.md" } },
      ".opencode/plans/ses_read-feature/spec.md",
    ),
    false,
  );
  assert.equal(
    exactReadPathFact(
      { tool: "bash", input: { filePath: ".opencode/plans/ses_read-feature/spec.md" } },
      ".opencode/plans/ses_read-feature/spec.md",
    ),
    false,
  );

  const readFirstPrompt = planPrompt("ses_read", "feature");
  assert.match(readFirstPrompt, /Use Read exactly once on \.opencode\/plans\/\.state\/ses_read\/gate-state\.json/);
  assert.match(readFirstPrompt, /and Read exactly once on \.opencode\/plans\/ses_read-feature\/spec\.md\./);
  assert.match(readFirstPrompt, /These two independent Reads may run together, but wait for both to complete/);
  assert.match(
    readFirstPrompt,
    /session_id "ses_read", feature_id "feature", classified true, mode "full", brainstormed true, and adversary_fired true/,
  );
  assert.match(readFirstPrompt, /Only after both reads, call the Task tool exactly once/);

  const terminalFacts = [
    { tool: "read", callId: "call-read-ok", status: "running" },
    { tool: "read", callId: "call-read-ok", status: "completed" },
    { tool: "read", callId: "call-read-error", status: "error" },
    { tool: "task", callId: "call-task", status: "completed" },
  ];
  assert.deepEqual(
    terminalCallFacts(terminalFacts, (fact) => fact.tool === "read", "DIRECT terminal Reads").map((fact) => fact.callId),
    ["call-read-ok", "call-read-error"],
  );
  assert.throws(
    () => terminalCallFacts([
      { tool: "read", callId: "call-duplicate", status: "completed" },
      { tool: "read", callId: "call-duplicate", status: "error" },
    ], (fact) => fact.tool === "read", "DIRECT duplicate terminal Read"),
    /exactly one terminal fact/,
  );
  assert.throws(
    () => terminalCallFacts([
      { tool: "read", callId: "call-running-only", status: "running" },
    ], (fact) => fact.tool === "read", "DIRECT running-only Read"),
    /exactly one terminal fact/,
  );

  assert.doesNotThrow(() => assertSuccessfulHostExit({ status: 0, signal: null }, "", "", "DIRECT clean exit"));
  assert.throws(
    () => assertSuccessfulHostExit({ status: 1, signal: null }, "partial", "failed", "DIRECT failed exit"),
    /exited with status 1/,
  );

  assert.doesNotThrow(() => assertReturnedMatchesCanonical(parserPlan, structuredClone(parserPlan), "DIRECT equal plans"));
  const differentTasks = structuredClone(parserPlan);
  differentTasks.tasks[0].id = "different-task";
  assert.throws(() => assertReturnedMatchesCanonical(parserPlan, differentTasks, "DIRECT task mismatch"), /integrally differ/);
  const returnedPath = join(tempRoot, "probe-returned-plan.json");
  const canonicalPath = join(tempRoot, "probe-canonical-plan.json");
  writeFileSync(returnedPath, JSON.stringify(parserPlan));
  writeFileSync(canonicalPath, JSON.stringify(structuredClone(parserPlan)));
  assert.equal(
    sourcePlanFacts(tempRoot, returnedPath).semantic_hash,
    sourcePlanFacts(tempRoot, canonicalPath).semantic_hash,
    "DIRECT semantically equal returned/canonical plans have different source hashes",
  );
}

async function moduleOracles(tempRoot) {
  const directRoles = vendoredAgentCatalog(tempRoot);
  const editPermissionFacts = vendoredEditPermissionFacts(tempRoot, directRoles);
  assert.equal(editPermissionFacts.allowed.length + editPermissionFacts.denied.length, directRoles.length);
  callSourceModuleOracles(tempRoot, directRoles, editPermissionFacts);
  pass("source: static-import helper proves factories and direct authority oracles");
  callVendoredDefaultFactories(tempRoot);
  strictParserOracles(tempRoot);
  pass("DIRECT: strict 1.18.10 NDJSON/Task parsers enforce real envelopes, planner/reviewer contracts, and exact tool inputs");
  pass("DIRECT: duplicate planner before preserves its frozen routing snapshot after routing becomes invalid");
  pass(
    `DIRECT: all ${directRoles.length} fresh-catalog roles enter the same role-independent canonical-write hook ` +
    `(${editPermissionFacts.denied.length} platform-denied; ${editPermissionFacts.allowed.length} plugin-guarded)`,
  );
  pass("DIRECT: real planner-recovery rejects an injected legacy tiers result without binding or canonical bytes");
  pass("DIRECT: literal Bash mutation receives exact plan-write-gate friction while read-copy passes");
  pass("DIRECT: observer is byte-neutral and cannot create a plan-created event for canonical model writes");
}

function parseNdjson(stdout, label) {
  const events = [];
  for (const [index, line] of stdout.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch (error) {
      throw new Error(`${label}: malformed JSON object on NDJSON line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return events;
}

function toolFacts(events) {
  return events.flatMap((event) => {
    if (event?.type !== "tool_use") return [];
    const part = event.part;
    if (!part || part.type !== "tool" || typeof part.tool !== "string") return [];
    const state = part.state;
    if (!state || typeof state !== "object" || Array.isArray(state)) return [];
    return [{
      tool: part.tool.toLowerCase(),
      callId: String(part.callID ?? ""),
      messageId: String(part.messageID ?? event.messageID ?? ""),
      sessionId: String(part.sessionID ?? event.sessionID ?? ""),
      status: String(state.status ?? "").toLowerCase(),
      input: state.input && typeof state.input === "object" && !Array.isArray(state.input) ? state.input : {},
      output: state.output,
      error: String(state.error ?? ""),
      timeStart: Number.isFinite(state.time?.start) ? state.time.start : null,
      timeEnd: Number.isFinite(state.time?.end) ? state.time.end : null,
    }];
  });
}

function terminalCallFacts(facts, predicate, label) {
  const byCallId = new Map();
  for (const fact of facts) {
    if (!predicate(fact)) continue;
    assert.ok(fact.callId, `${label}: fact has no callID`);
    const callFacts = byCallId.get(fact.callId) ?? [];
    callFacts.push(fact);
    byCallId.set(fact.callId, callFacts);
  }
  return [...byCallId.entries()].map(([callId, callFacts]) => {
    const terminal = callFacts.filter((fact) => fact.status === "completed" || fact.status === "error");
    assert.equal(terminal.length, 1, `${label}: callID ${callId} must have exactly one terminal fact`);
    return terminal[0];
  });
}

function sessionFact(events) {
  for (const event of events) {
    const sessionId = event?.sessionID ?? event?.part?.sessionID;
    if (typeof sessionId === "string" && sessionId) return sessionId;
  }
  return "";
}

function assertSuccessfulHostExit(result, stdout, stderr, label) {
  if (result.status === 0) return;
  throw new Error(
    `${label}: OpenCode exited with status ${String(result.status)} signal ${String(result.signal ?? "none")}: ` +
    `${stderr.slice(-1200)}\n${stdout.slice(-1200)}`,
  );
}

function runOpenCode(root, prompt, {
  sessionId = "",
  agent = "build",
  env = {},
  timeoutMs = HOST_PROCESS_TIMEOUT_MS,
} = {}) {
  hostRunCount += 1;
  assert.ok(hostRunCount <= HOST_MAX_RUNS, `HOST run budget exceeded: ${hostRunCount}/${HOST_MAX_RUNS}`);
  const command = ["run", "--dir", root, "--format", "json", "--auto", "--agent", agent];
  if (sessionId) command.push("--session", sessionId);
  command.push(prompt);
  const result = spawnSync(OPENCODE_BIN, command, {
    cwd: root,
    encoding: "utf8",
    timeout: timeoutMs,
    env: { ...process.env, ...env },
  });
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  if (result.error?.code === "ETIMEDOUT" || result.signal === "SIGTERM") {
    throw new Error(
      `OpenCode timeout (${timeoutMs / 1000}s): ` +
      `${stderr.slice(-1200)}\n${stdout.slice(-1200)}`,
    );
  }
  if (/failed to load plugin/i.test(`${stderr}\n${stdout}`)) {
    throw new Error(`OpenCode plugin load failure: ${stderr.slice(-1200)}\n${stdout.slice(-1200)}`);
  }
  assertSuccessfulHostExit(result, stdout, stderr, `HOST run ${hostRunCount} (${agent})`);
  return { events: parseNdjson(stdout, `HOST run ${hostRunCount} (${agent})`), stdout, stderr, status: result.status };
}

function completedFact(run, predicate, label) {
  const fact = toolFacts(run.events).find((entry) => predicate(entry) && entry.status === "completed");
  assert.ok(fact, `${label}: no completed 1.18.10 tool_use fact; stdout tail=${run.stdout.slice(-1200)}`);
  return fact;
}

function gateErrorFact(run, predicate, label) {
  const fact = toolFacts(run.events).find((entry) =>
    predicate(entry) && entry.status === "error" && /^\[plan-write-gate\]/.test(entry.error));
  assert.ok(fact, `${label}: no exact plan-write-gate tool error; stdout tail=${run.stdout.slice(-1200)}`);
  return fact;
}

function outputText(fact) {
  return typeof fact.output === "string" ? fact.output : JSON.stringify(fact.output ?? "");
}

function completedTaskResultText(output, label) {
  if (typeof output !== "string") {
    throw new Error(`${label}: completed Task output must be a string envelope`);
  }
  const task = output.trim().match(/^<task\b([^>]*)>([\s\S]*)<\/task>$/);
  if (!task) {
    throw new Error(`${label}: expected exactly one task envelope`);
  }
  const attributes = new Map();
  const attributePattern = /\s+([A-Za-z_:][\w:.-]*)\s*=\s*(["'])([\s\S]*?)\2/g;
  let previousEnd = 0;
  for (const match of task[1].matchAll(attributePattern)) {
    if (!/^\s*$/.test(task[1].slice(previousEnd, match.index))) {
      throw new Error(`${label}: malformed task attributes`);
    }
    if (attributes.has(match[1])) {
      throw new Error(`${label}: duplicate task attribute ${match[1]}`);
    }
    attributes.set(match[1], match[3]);
    previousEnd = match.index + match[0].length;
  }
  if (!/^\s*$/.test(task[1].slice(previousEnd))) {
    throw new Error(`${label}: malformed task attributes`);
  }
  if (attributes.get("state") !== "completed") {
    throw new Error(`${label}: task state must be exactly completed`);
  }
  const result = task[2].match(/^\s*<task_result>([\s\S]*?)<\/task_result>\s*$/);
  if (!result || result[1].includes("</task_result>")) {
    throw new Error(`${label}: task envelope must contain exactly one task_result`);
  }
  return result[1].trim();
}

function jsonObjectWithSummary(text, label, summaryKind) {
  const source = String(text ?? "").trim();
  if (!source.startsWith("{")) throw new Error(`${label}: task_result must start with one JSON object`);
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let end = -1;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth < 0) throw new Error(`${label}: malformed JSON object boundary`);
      if (depth === 0) {
        end = index + 1;
        break;
      }
    }
  }
  if (end < 0 || depth !== 0 || quoted) throw new Error(`${label}: incomplete JSON object`);
  const summary = source.slice(end).trim();
  const invalidCommon =
    !summary ||
    /[\r\n]/.test(summary);
  const invalidContract = summaryKind === "planner"
    ? !PLANNER_SUMMARY_PATTERN.test(summary)
    : /[\[\]{}]/.test(summary) ||
      !/\b(?:plano|tarefa|tarefas|risco|aprovad[oa]|gerado)\b/i.test(summary);
  if (invalidCommon || invalidContract) {
    throw new Error(
      `${label}: expected exactly one short pt-BR product summary line ` +
      `(${summaryKind} contract) after JSON`,
    );
  }
  try {
    const value = JSON.parse(source.slice(0, end));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("JSON root must be an object");
    }
    return { value, summary };
  } catch (error) {
    throw new Error(`${label}: task_result JSON is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function exactMarkerBody(source, marker, label) {
  const text = String(source ?? "");
  const open = `[${marker}]`;
  const close = `[/${marker}]`;
  if (text.split(open).length !== 2 || text.split(close).length !== 2) {
    throw new Error(`${label}: expected exactly one ${marker} block`);
  }
  const start = text.indexOf(open) + open.length;
  const end = text.indexOf(close, start);
  if (end < start) throw new Error(`${label}: malformed ${marker} block`);
  return text.slice(start, end).trim();
}

function assertPlannerPromptFacts(prompt, expectedFeatureId, expectedModelStrategy, label) {
  const featureId = exactMarkerBody(prompt, "HARNESS_SESSION_FEATURE_ID", label);
  assert.equal(featureId, expectedFeatureId, `${label}: frozen feature marker differs`);
  const strategyText = exactMarkerBody(prompt, "HARNESS_EXPECTED_MODEL_STRATEGY", label);
  let strategy;
  try {
    strategy = JSON.parse(strategyText);
  } catch (error) {
    throw new Error(`${label}: model-strategy marker is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  assert.ok(strategy && typeof strategy === "object" && !Array.isArray(strategy), `${label}: model-strategy marker is not an object`);
  assert.deepEqual(strategy, expectedModelStrategy, `${label}: frozen strategy marker differs`);
}

function boundPlanPromptFacts(prompt, label) {
  const text = String(prompt ?? "");
  const openPattern = /\[HARNESS_BOUND_PLAN sha256=([0-9a-f]{64})\]/g;
  const openings = [...text.matchAll(openPattern)];
  const genericOpenCount = text.split("[HARNESS_BOUND_PLAN").length - 1;
  const close = "[/HARNESS_BOUND_PLAN]";
  const closeCount = text.split(close).length - 1;
  if (openings.length !== 1 || genericOpenCount !== 1 || closeCount !== 1) {
    throw new Error(`${label}: expected exactly one canonical HARNESS_BOUND_PLAN block`);
  }
  const start = /** @type {RegExpMatchArray} */ (openings[0]).index + openings[0][0].length;
  const end = text.indexOf(close, start);
  if (end < start) throw new Error(`${label}: malformed HARNESS_BOUND_PLAN block`);
  let plan;
  try {
    plan = JSON.parse(text.slice(start, end).trim());
  } catch (error) {
    throw new Error(`${label}: bound plan is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    throw new Error(`${label}: bound plan JSON root must be an object`);
  }
  return { hash: openings[0][1], plan };
}

function assertBoundPlanPromptFacts(prompt, expectedHash, expectedPlan, label) {
  const actual = boundPlanPromptFacts(prompt, label);
  assert.equal(actual.hash, expectedHash, `${label}: bound-plan semantic hash differs`);
  assert.deepEqual(actual.plan, expectedPlan, `${label}: bound-plan JSON differs from canonical`);
}

function parsePlannerTaskPlan(root, output, expectedModelStrategy, label) {
  const resultText = completedTaskResultText(output, label);
  const parsed = jsonObjectWithSummary(resultText, label, "planner");
  const classified = classifyPlannerResultViaSource(root, resultText, expectedModelStrategy);
  if (classified.kind !== "usable_plan") {
    throw new Error(`${label}: planner result violates the production contract: ${classified.errors.join("; ")}`);
  }
  assert.deepEqual(classified.plan, parsed.value, `${label}: production classifier selected a different plan`);
  return classified.plan;
}

function parsePlanReviewTaskResult(output, label) {
  const resultText = completedTaskResultText(output, label);
  const { value, summary } = jsonObjectWithSummary(resultText, label, "plan-reviewer");
  assert.deepEqual(Object.keys(value).sort(), ["findings", "verdict"], `${label}: reviewer JSON keys differ from contract`);
  if (value.verdict !== "APPROVE" && value.verdict !== "REVISE") {
    throw new Error(`${label}: reviewer verdict must be APPROVE or REVISE`);
  }
  if (!Array.isArray(value.findings)) throw new Error(`${label}: reviewer findings must be an array`);
  const areas = new Set(["decomposition", "judgment", "locked-test", "scope", "model-routing", "introduced-risk"]);
  const severities = new Set(["low", "medium", "high"]);
  let hasHigh = false;
  for (const [index, finding] of value.findings.entries()) {
    if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
      throw new Error(`${label}: reviewer finding ${index} must be an object`);
    }
    assert.deepEqual(
      Object.keys(finding).sort(),
      ["area", "planner_instruction", "problem", "severity", "task_id"],
      `${label}: reviewer finding ${index} keys differ from contract`,
    );
    if (!areas.has(finding.area) || !severities.has(finding.severity)) {
      throw new Error(`${label}: reviewer finding ${index} has invalid area/severity`);
    }
    for (const key of ["task_id", "problem", "planner_instruction"]) {
      if (typeof finding[key] !== "string" || !finding[key].trim()) {
        throw new Error(`${label}: reviewer finding ${index}.${key} must be non-empty`);
      }
    }
    if (!finding.problem.startsWith("Evidence: ")) {
      throw new Error(`${label}: reviewer finding ${index}.problem lacks Evidence anchor`);
    }
    if (finding.severity === "high") hasHigh = true;
  }
  if (value.verdict === "APPROVE" && hasHigh) {
    throw new Error(`${label}: APPROVE cannot carry a high finding`);
  }
  if (value.verdict === "REVISE" && !hasHigh) {
    throw new Error(`${label}: REVISE must carry at least one high finding`);
  }
  return { verdict: value.verdict, findings: value.findings, summary };
}

function exactBashCommandFact(fact, expectedCommand) {
  return fact?.tool === "bash" && fact.input?.command === expectedCommand;
}

function exactWriteFact(fact, expectedPath, expectedContent) {
  return fact?.tool === "write" &&
    exactToolPath(fact.input?.filePath, expectedPath) &&
    fact.input?.content === expectedContent;
}

function exactToolPath(actualPath, expectedPath) {
  const actual = String(actualPath ?? "").replace(/\\/g, "/");
  const expected = String(expectedPath).replace(/\\/g, "/");
  const actualIsAbsolute = actual.startsWith("/") || /^[A-Za-z]:\//.test(actual);
  return actual === expected || (actualIsAbsolute && actual.endsWith(`/${expected}`));
}

function exactReadPathFact(fact, expectedPath) {
  if (fact?.tool !== "read") return false;
  return exactToolPath(fact.input?.filePath ?? fact.input?.path, expectedPath);
}

function assertReturnedMatchesCanonical(returnedPlan, canonicalPlan, label) {
  try {
    assert.deepEqual(canonicalPlan, returnedPlan);
  } catch {
    throw new Error(`${label}: returned and canonical plans integrally differ`);
  }
  assert.equal(
    JSON.stringify(canonicalPlan),
    JSON.stringify(returnedPlan),
    `${label}: returned and canonical serialized semantics differ`,
  );
}

function installedVersion() {
  const output = execFileSync(OPENCODE_BIN, ["--version"], { encoding: "utf8", timeout: 20_000 }).trim();
  const actual = output.match(/\d+\.\d+\.\d+/)?.[0] || "";
  assert.equal(actual, EXPECTED_OC_VERSION, `OPENCODE_BIN version must equal EXPECTED_OC_VERSION=${EXPECTED_OC_VERSION}; got ${output}`);
}

function stateFor(root, sessionId) {
  return JSON.parse(readFileSync(join(root, ".opencode", "plans", ".state", sessionId, "gate-state.json"), "utf8"));
}

function hostApprovedSpec() {
  return `# Plan authority probe

Status: APPROVED. Delivery mode: FULL. This is not a QUICK hotfix.

The delivery spans the producer, concurrent state store, read model, and tests. Concurrent writes
are a data-integrity boundary: no update may be dropped, duplicated, or observed out of sequence.

## User journey

<a id="uj-1"></a>
An operator records two probe values concurrently and reads one deterministic ordered snapshot.

## Acceptance criteria

<a id="ac-1"></a>
Calling \`probeValue()\` returns exactly \`PLAN_AUTHORITY_PROBE\`.

<a id="ac-2"></a>
Given two concurrent calls to \`recordProbeValue\`, both values persist exactly once and
\`readProbeValues\` returns them in accepted sequence order.

<a id="ac-3"></a>
Given an empty or non-string value, \`recordProbeValue\` rejects it with the sanitized message
\`INVALID_PROBE_VALUE\` and the prior snapshot remains byte-for-byte unchanged.

## Scope

- \`src/probe.ts\`
- \`src/probe-store.ts\`
- \`src/probe-view.ts\`
- \`src/probe.test.mjs\`

## Locked product decisions

- Preserve the existing \`probeValue\` sentinel.
- Serialize concurrent writes; never use last-write-wins.
- Keep validation at the store boundary and expose only the sanitized error above.
`;
}

function planPrompt(sessionId, featureId) {
  const gateState = `.opencode/plans/.state/${sessionId}/gate-state.json`;
  const canonicalSpec = `.opencode/plans/${sessionId}-${featureId}/spec.md`;
  return (
    `Use Read exactly once on ${gateState} and Read exactly once on ${canonicalSpec}. ` +
    `These two independent Reads may run together, but wait for both to complete. ` +
    `Verify the state contains session_id "${sessionId}", feature_id "${featureId}", classified true, mode "full", brainstormed true, and adversary_fired true. ` +
    `If those facts are present, do not rerun ceremony; the native gate will verify them. ` +
    `Only after both reads, call the Task tool exactly once with subagent_type "planner" and description "Plan the authority probe". ` +
    `The approved spec owns concurrent data integrity across four files; it is not QUICK. ` +
    `The canonical approved spec is ${canonicalSpec}, with a byte-identical source mirror at docs/specs/plan-authority-probe.md. ` +
    `Its prompt must identify the canonical spec, ` +
    `preserve the locked feature_id ${featureId}, ` +
    "and follow the planner's real terminal contract: one full JSON plan followed by one short pt-BR summary line."
  );
}

async function hostOracles(tempRoot) {
  if (process.env.OC_RUNTIME_PROBE !== "1") {
    throw new Error("--host requires OC_RUNTIME_PROBE=1; refusing to run paid installed-OpenCode scenarios");
  }
  process.stdout.write(
    `HOST COST: exactly ${HOST_MAX_RUNS} bounded OpenCode runs when successful ` +
    `(1 cheap-hand official-write run + ${HOST_FIXED_RUNS} structural scenario runs; ` +
    `<=${HOST_PROCESS_TIMEOUT_MS / 1000}s each except reviewer <=${HOST_REVIEW_TIMEOUT_MS / 1000}s).\n`,
  );
  installedVersion();
  pass(`HOST: installed OpenCode matches EXPECTED_OC_VERSION=${EXPECTED_OC_VERSION}`);

  const primer = runOpenCode(tempRoot, "Reply only SESSION_PRIMER.");
  const sessionId = sessionFact(primer.events);
  assert.ok(sessionId, `HOST primer produced no parseable session ID; stdout tail=${primer.stdout.slice(-1000)}`);
  const featureId = "host-plan-authority";
  const probePaths = seedPlannerState(tempRoot, sessionId, featureId, {
    fidelity_pass: [`${featureId}/probe-task`],
    regate_pending: [],
    regate_passed: [],
  });
  const routingBytes = readFileSync(join(tempRoot, ".opencode", "harness.routing.json"));
  const projected = sourcePlanFacts(tempRoot);
  mkdirSync(join(tempRoot, "src"), { recursive: true });
  mkdirSync(join(tempRoot, "docs", "specs"), { recursive: true });
  writeFileSync(join(tempRoot, "src", "probe.ts"), "export const probeValue = () => 'PLAN_AUTHORITY_PROBE';\n");
  writeFileSync(
    join(tempRoot, "src", "probe-store.ts"),
    "export const recordProbeValue = async (value) => [value];\n",
  );
  writeFileSync(
    join(tempRoot, "src", "probe-view.ts"),
    "export const readProbeValues = (values) => [...values];\n",
  );
  writeFileSync(join(tempRoot, "src", "probe.test.mjs"), "// Approved FULL probe test boundary.\n");
  const approvedSpec = hostApprovedSpec();
  const sourceSpecPath = join(tempRoot, "docs", "specs", "plan-authority-probe.md");
  const canonicalSpecRel = `.opencode/plans/${sessionId}-${featureId}/spec.md`;
  const canonicalSpecPath = join(tempRoot, canonicalSpecRel);
  writeFileSync(sourceSpecPath, approvedSpec);
  writeFileSync(canonicalSpecPath, approvedSpec);
  sameBytes(bytes(sourceSpecPath), bytes(canonicalSpecPath), "HOST approved spec mirror/canonical");

  const plannerRun = runOpenCode(tempRoot, planPrompt(sessionId, featureId), { sessionId });
  const plannerFacts = toolFacts(plannerRun.events);
  const plannerTask = completedFact(
    plannerRun,
    (fact) => fact.tool === "task" && fact.input.subagent_type === "planner" && fact.callId,
    "HOST planner Task",
  );
  const stateRel = `.opencode/plans/.state/${sessionId}/gate-state.json`;
  const readCalls = terminalCallFacts(plannerFacts, (fact) => fact.tool === "read", "HOST build Reads");
  const taskCalls = terminalCallFacts(plannerFacts, (fact) => fact.tool === "task", "HOST build Tasks");
  const repeatedCeremonyCalls = terminalCallFacts(
    plannerFacts,
    (fact) => fact.tool === "skill" || fact.tool === "classify" || fact.tool === "mark",
    "HOST repeated ceremony",
  );
  assert.equal(readCalls.length, 2, "HOST build must issue exactly two terminal Read calls");
  assert.equal(taskCalls.length, 1, "HOST build must issue exactly one terminal Task call");
  assert.equal(repeatedCeremonyCalls.length, 0, "HOST build reran skill/classify/mark ceremony");
  assert.equal(taskCalls[0].callId, plannerTask.callId, "HOST sole Task is not the completed planner Task");
  const stateReads = readCalls.filter((fact) => exactReadPathFact(fact, stateRel));
  const specReads = readCalls.filter((fact) => exactReadPathFact(fact, canonicalSpecRel));
  assert.equal(stateReads.length, 1, "HOST build must issue exactly one exact gate-state Read");
  assert.equal(specReads.length, 1, "HOST build must issue exactly one exact canonical-spec Read");
  const stateRead = stateReads[0];
  const specRead = specReads[0];
  assert.equal(stateRead.status, "completed", "HOST exact gate-state Read did not complete");
  assert.equal(specRead.status, "completed", "HOST exact canonical-spec Read did not complete");
  for (const [label, fact] of [["gate-state Read", stateRead], ["canonical-spec Read", specRead], ["planner Task", plannerTask]]) {
    assert.ok(fact.messageId, `HOST ${label} lacks a messageID`);
    assert.ok(Number.isFinite(fact.timeStart), `HOST ${label} lacks a numeric start timestamp`);
    assert.ok(Number.isFinite(fact.timeEnd), `HOST ${label} lacks a numeric end timestamp`);
    assert.ok(fact.timeStart <= fact.timeEnd, `HOST ${label} has reversed timestamps`);
  }
  assert.ok(
    stateRead.timeEnd <= plannerTask.timeStart && specRead.timeEnd <= plannerTask.timeStart,
    "HOST build must finish both exact Reads before starting planner Task",
  );
  assert.notEqual(
    plannerTask.messageId,
    stateRead.messageId,
    "HOST planner Task shares the gate-state Read message and could predate its output",
  );
  assert.notEqual(
    plannerTask.messageId,
    specRead.messageId,
    "HOST planner Task shares the canonical-spec Read message and could predate its output",
  );
  assert.equal(plannerTask.input.description, "Plan the authority probe", "HOST planner Task description differs");
  assertPlannerPromptFacts(
    String(plannerTask.input.prompt ?? ""),
    featureId,
    projected.strategy,
    "HOST planner Task input",
  );
  const returnedPlan = parsePlannerTaskPlan(tempRoot, outputText(plannerTask), projected.strategy, "HOST planner Task");
  assert.equal(plannerTask.input.subagent_type, "planner", "HOST planner Task event lost requested role");
  assert.equal(returnedPlan.feature_id, featureId, "HOST planner Task output has wrong feature");
  assert.deepEqual(returnedPlan.model_strategy, projected.strategy, "HOST planner Task output has wrong strategy");
  const state = stateFor(tempRoot, sessionId);
  const canonicalBytes = bytes(probePaths.canonical);
  const binding = state.planner_plan_binding;
  assert.equal(state.planner_status, "usable", `HOST planner state is not usable: ${JSON.stringify(state)}`);
  assert.equal(binding?.call_id, plannerTask.callId, "HOST binding call_id differs from real Task callID");
  assert.equal(binding?.session_id, sessionId, "HOST binding session differs from real Task session");
  assert.equal(binding?.feature_id, featureId, "HOST binding feature differs from seeded session feature");
  assert.ok(canonicalBytes, "HOST planner Task did not create canonical bytes");
  const canonical = JSON.parse(canonicalBytes.toString("utf8"));
  assertReturnedMatchesCanonical(returnedPlan, canonical, "HOST planner Task/canonical");
  assert.deepEqual(canonical.model_strategy, projected.strategy, "HOST canonical strategy differs from frozen routing projection");
  const canonicalFileHash = createHash("sha256").update(canonicalBytes).digest("hex");
  assert.equal(canonicalFileHash, binding.file_hash, "HOST canonical bytes differ from binding.file_hash");
  assert.equal(canonicalFileHash, binding.snapshot_file_hash, "HOST canonical bytes differ from binding.snapshot_file_hash");
  assert.equal(typeof binding.snapshot_path, "string", "HOST binding has no snapshot_path");
  const expectedSnapshotPath = `.opencode/plans/.state/${sessionId}/bound-plans/${binding.snapshot_file_hash}.json`;
  assert.equal(binding.snapshot_path, expectedSnapshotPath, "HOST snapshot_path is not the exact content-addressed state path");
  const snapshotPath = resolve(tempRoot, expectedSnapshotPath);
  const snapshotBytes = bytes(snapshotPath);
  assert.ok(snapshotBytes, "HOST bound snapshot is absent");
  sameBytes(snapshotBytes, canonicalBytes, "HOST snapshot/canonical");
  assert.equal(createHash("sha256").update(snapshotBytes).digest("hex"), binding.snapshot_file_hash, "HOST snapshot bytes differ from snapshot_file_hash");
  const semanticHash = sourcePlanFacts(tempRoot, probePaths.canonical).semantic_hash;
  const returnedPlanPath = join(tempRoot, "probe-host-returned-plan.json");
  writeFileSync(returnedPlanPath, JSON.stringify(returnedPlan));
  assert.equal(
    sourcePlanFacts(tempRoot, returnedPlanPath).semantic_hash,
    semanticHash,
    "HOST returned plan semantic hash differs from canonical",
  );
  assert.equal(semanticHash, binding.semantic_hash, "HOST canonical semantic hash differs from binding");
  assert.equal(semanticHash, binding.snapshot_hash, "HOST canonical semantic hash differs from snapshot binding");
  pass("HOST: real planner Task is call/session/feature-bound to byte-identical canonical and snapshot hashes");

  writeFileSync(join(tempRoot, ".opencode", "harness.routing.json"), "{ invalid routing after bind");
  const reviewSentinel = "REVIEW_REQUEST_SENTINEL_7C19";
  const reviewRun = runOpenCode(
    tempRoot,
      `Call the Task tool exactly once with subagent_type "plan-reviewer" and description "Review the bound authority probe plan". ` +
      `Include this exact sentence in its prompt: "${reviewSentinel} is request-correlation metadata, not a product requirement or expected value." ` +
      `Use ${canonicalSpecRel} as the canonical approved spec; docs/specs/plan-authority-probe.md is its byte-identical source mirror. ` +
      "Require it to review honestly and follow its real terminal contract: strict verdict/findings JSON, then a short pt-BR product summary.",
    { sessionId, timeoutMs: HOST_REVIEW_TIMEOUT_MS },
  );
  const reviewFact = completedFact(
    reviewRun,
    (fact) => fact.tool === "task" && fact.input.subagent_type === "plan-reviewer",
    "HOST plan-reviewer Task",
  );
  assert.equal(
    reviewFact.input.description,
    "Review the bound authority probe plan",
    "HOST plan-reviewer Task description differs",
  );
  const reviewPrompt = String(reviewFact.input.prompt ?? "");
  assertBoundPlanPromptFacts(
    reviewPrompt,
    binding.snapshot_hash,
    canonical,
    "HOST plan-reviewer Task input",
  );
  assert.match(reviewPrompt, new RegExp(reviewSentinel), "HOST plan-reviewer input lost its sentinel");
  assert.match(
    reviewPrompt,
    new RegExp(`${reviewSentinel} is request-correlation metadata, not a product requirement or expected value\\.`),
    "HOST plan-reviewer input changed the sentinel's non-product meaning",
  );
  assert.equal(reviewFact.input.subagent_type, "plan-reviewer", "HOST plan-reviewer Task event lost requested role");
  const reviewResult = parsePlanReviewTaskResult(outputText(reviewFact), "HOST plan-reviewer Task");
  pass(
    `HOST: bound plan survives later routing invalidation and reaches a schema-valid ${reviewResult.verdict} review contract`,
  );

  // Restore routing for later independent host calls; the preceding review proved that bound-plan
  // verification itself did not reread the deliberately-invalid file.
  writeFileSync(join(tempRoot, ".opencode", "harness.routing.json"), routingBytes);

  const beforeMutation = bytes(probePaths.canonical);
  const bashReadCommand = `shasum -a 256 .opencode/plans/${sessionId}-${featureId}/execution-plan.json`;
  const readRun = runOpenCode(
    tempRoot,
    `Use Bash exactly once to run exactly this command: ${bashReadCommand}`,
    { sessionId },
  );
  const readFact = completedFact(readRun, (fact) => exactBashCommandFact(fact, bashReadCommand), "HOST canonical Bash read");
  assert.match(outputText(readFact), new RegExp(canonicalFileHash), "HOST Bash read output lacks the canonical sha256");
  const bashMutationCommand = `printf '{}' > .opencode/plans/${sessionId}-${featureId}/execution-plan.json`;
  const mutationRun = runOpenCode(
    tempRoot,
    `Execute one LOW-complexity locked negative harness probe. ` +
      `scope_paths: [".opencode/plans/${sessionId}-${featureId}/execution-plan.json"]. ` +
      `resolved_judgments: the expected plan-write-gate refusal is the test evidence, so invoke the tool instead of pre-refusing. ` +
      `criterion_refs: ["probe-gate-deny"]. locked_tests: run exactly this Bash command once: ${bashMutationCommand}. ` +
      `Do not use Read, Edit, Write, Task, Skill, classify, mark, or another Bash call.`,
    { sessionId, agent: "executor-low" },
  );
  gateErrorFact(mutationRun, (fact) => exactBashCommandFact(fact, bashMutationCommand), "HOST literal Bash mutation");
  sameBytes(bytes(probePaths.canonical), beforeMutation, "HOST literal Bash canonical bytes");

  // One real cheap-hand run complements the exhaustive role-independent DIRECT matrix.
  // Subagent runs are intentionally absent: permissions may hide Write, and parent NDJSON may
  // omit child tool_use facts, so those paid runs cannot prove this gate.
  const canonicalRel = `.opencode/plans/${sessionId}-${featureId}/execution-plan.json`;
  const deniedWriteContent = "{}";
  for (const role of HOST_WRITE_ROLES) {
    const roleRun = runOpenCode(
      tempRoot,
      `Execute one LOW-complexity locked negative harness probe. ` +
        `scope_paths: ["${canonicalRel}"]. ` +
        `resolved_judgments: the expected plan-write-gate refusal is the test evidence, so invoke the tool instead of pre-refusing. ` +
        `criterion_refs: ["probe-official-write-deny"]. ` +
        `locked_tests: use Write exactly once to overwrite ${canonicalRel} with exactly ${deniedWriteContent}. ` +
        `Do not use Read, Edit, Bash, Task, Skill, classify, mark, or another Write call.`,
      { sessionId, agent: role },
    );
    gateErrorFact(
      roleRun,
      (fact) => exactWriteFact(fact, canonicalRel, deniedWriteContent),
      `HOST role official Write ${role}`,
    );
    sameBytes(bytes(probePaths.canonical), beforeMutation, `HOST role ${role} canonical bytes`);
  }
  pass("HOST: cheap hand exact official Write hits plan-write-gate; catalog-wide role independence is proved directly");

  // Independent positive observer scenario: an allowed spec Write must emit spec-created while an
  // inert canonical full plan remains unbound and byte-neutral.
  const observerPrimer = runOpenCode(tempRoot, "Reply only OBSERVER_SESSION_PRIMER.");
  const observerSessionId = sessionFact(observerPrimer.events);
  assert.ok(observerSessionId, "HOST observer primer produced no session ID");
  const observerFeature = "host-observer-neutral";
  const observerPaths = seedPlannerState(tempRoot, observerSessionId, observerFeature, {
    planner_status: "not_started",
    planner_active_attempt: null,
    planner_plan_binding: null,
  });
  writeFileSync(observerPaths.canonical, JSON.stringify(validPlan(observerFeature, projected.strategy)));
  const observerStateBefore = bytes(observerPaths.state);
  const observerCanonicalBefore = bytes(observerPaths.canonical);
  const observerMeta = join(tempRoot, "probe-host-observer.json");
  const observerEvents = observerMeta.replace(/\.json$/, ".events.jsonl");
  const observerSpecRel = `.opencode/plans/${observerSessionId}-${observerFeature}/probe-spec.md`;
  const observerSpec = join(tempRoot, observerSpecRel);
  const observerSpecContent = "# HOST_OBSERVER_SPEC_SENTINEL\n";
  writeFileSync(observerMeta, "{}");
  const observerRun = runOpenCode(
    tempRoot,
    `Execute one LOW-complexity locked positive observation probe. ` +
      `scope_paths: ["${observerSpecRel}"]. ` +
      `resolved_judgments: this non-canonical spec Write is allowed and its spec-created event is the test evidence, so invoke the tool instead of pre-refusing. ` +
      `criterion_refs: ["probe-observer-spec-created"]. ` +
      `locked_tests: use Write exactly once to create ${observerSpecRel} with exactly this content: ${JSON.stringify(observerSpecContent)}. ` +
      `The Write input filePath must be exactly the project-relative string ${observerSpecRel}; do not prepend a slash or resolve it to an absolute path yourself. ` +
      `Do not use Read, Edit, Bash, Task, Skill, classify, mark, or another Write call.`,
    {
      sessionId: observerSessionId,
      agent: "executor-low",
      env: { HARNESS_OBSERVABILITY_RUN_PATH: observerMeta },
    },
  );
  const observerToolCalls = terminalCallFacts(toolFacts(observerRun.events), () => true, "HOST observer tools");
  assert.equal(observerToolCalls.length, 1, "HOST observer must issue exactly one terminal tool call");
  const observerWrite = observerToolCalls[0];
  assert.equal(observerWrite.status, "completed", "HOST observer sole tool call did not complete");
  assert.ok(
    exactWriteFact(observerWrite, observerSpecRel, observerSpecContent),
    "HOST observer sole tool call is not the exact spec Write",
  );
  assert.ok(outputText(observerWrite).length > 0, "HOST observer spec Write has no structural tool output");
  assert.equal(readFileSync(observerSpec, "utf8"), observerSpecContent, "HOST observer spec bytes differ");
  const emitted = parseNdjson(readFileSync(observerEvents, "utf8"), "HOST observer events");
  assert.ok(emitted.some((event) => event?.type === "spec-created"), "HOST observer emitted no spec-created fact");
  sameBytes(bytes(observerPaths.state), observerStateBefore, "HOST observer state");
  sameBytes(bytes(observerPaths.canonical), observerCanonicalBefore, "HOST observer canonical");
  assert.equal(stateFor(tempRoot, observerSessionId).planner_plan_binding ?? null, null, "HOST observer bound an inert canonical plan");
  pass("HOST: positive spec-created observation is state/canonical neutral and cannot bind an inert plan");

  assert.equal(hostRunCount, HOST_MAX_RUNS, `HOST successful path used ${hostRunCount}/${HOST_MAX_RUNS} declared runs`);
}

async function main() {
  const tempRoot = mkdtempSync(join(tmpdir(), "oc-plan-authority-probe-"));
  try {
    vendorFresh(tempRoot);
    if (runModuleSmoke) await moduleOracles(tempRoot);
    if (runHost) await hostOracles(tempRoot);
  } finally {
    if (KEEP_TEMP) process.stdout.write(`KEEP_PROBE_TMP=1 retained: ${tempRoot}\n`);
    else rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`FAIL: ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
