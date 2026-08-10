/** @description Parity manifesto tests: agents presence, no token reads, single-evaluator routing, vendored smoke. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  mkdtempSync,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import {
  runParity,
  checkAgentsPresent,
  checkDualConfig,
  checkNoTokenReads,
  checkGatesAndOracle,
  checkPluginLoad,
  checkImportsResolve,
  OC_REQUIRED_AGENTS,
} from "./parity-manifest.mjs";
import {
  harnessOcPluginFiles,
  vendorOpenCode,
} from "../core/claude-code/skills/initializing-projects/references/vendor-core.mjs";

/** @description ESM fixture root so `.js`/`.ts` plugins under it load as modules, not CJS. */
function makeModuleFixture(prefix) {
  const tmp = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(tmp, "package.json"), JSON.stringify({ type: "module" }));
  mkdirSync(join(tmp, "plugin"), { recursive: true });
  return tmp;
}

/** @description Mirrors the production relative-import scanner, including legal comment trivia. */
const LIB_IMPORT_TRIVIA_PATTERN = String.raw`(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*(?:\r?\n|$))*`;
const LIB_RELATIVE_IMPORT_PATTERNS = [
  new RegExp(String.raw`\bfrom${LIB_IMPORT_TRIVIA_PATTERN}["'](\.[^"']+)["']`, "g"),
  new RegExp(
    String.raw`\bimport${LIB_IMPORT_TRIVIA_PATTERN}\(${LIB_IMPORT_TRIVIA_PATTERN}["'](\.[^"']+)["']${LIB_IMPORT_TRIVIA_PATTERN}(?=[,)])`,
    "g",
  ),
  new RegExp(String.raw`\bimport${LIB_IMPORT_TRIVIA_PATTERN}["'](\.[^"']+)["']`, "g"),
];

/** @description Lists static and literal-dynamic imports from lib/** that resolve into plugin/lib/. */
function findLibBackImports(root) {
  const libRoot = join(root, "lib");
  const pluginLibRoot = resolve(root, "plugin", "lib");
  const found = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) {
        walk(abs);
        continue;
      }
      if (!/\.(?:mjs|cjs|js|ts|tsx|jsx)$/.test(name)) continue;
      const text = readFileSync(abs, "utf8");
      for (const pattern of LIB_RELATIVE_IMPORT_PATTERNS) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(text)) !== null) {
          const specifier = match[1];
          if (!specifier.startsWith(".")) continue;
          const target = resolve(dirname(abs), specifier);
          const fromPluginLib = relative(pluginLibRoot, target);
          if (fromPluginLib === "" || (fromPluginLib !== ".." && !fromPluginLib.startsWith(`..${sep}`))) {
            found.push({ file: relative(root, abs), specifier });
          }
        }
      }
    }
  };
  walk(libRoot);
  return found;
}

const OC_MODULE_MANIFEST_PATH = "docs/specs/oc-port/oc-plugin-module-manifest.json";
const OC_MODULE_FIELDS = ["cc_evidence", "consumers", "current_path", "failure_policy", "original_path", "reason", "rule_ids", "tests", "verdict"];
const OC_RULE_IDS = ["A1", ...Array.from({ length: 15 }, (_, index) => `R${index + 1}`)];
const OC_MODULE_VERDICTS = new Set(["KEEP", "KEEP (MOVE)", "REWRITE", "DELETE"]);
const OC_PENDING_DELETE_PATHS = [];
const OC_AUTOLOAD_PLUGIN_PATHS = new Set(
  harnessOcPluginFiles().map((entry) => entry.replace(/^\.\/\.opencode\//, "")),
);
const OC_FROZEN_MODULES = {
  "plugin/agent-idle-nudge.ts": { current_path: "plugin/agent-idle-nudge.ts", verdict: "KEEP" },
  "plugin/autonomy-controller.ts": { current_path: "plugin/autonomy-controller.ts", verdict: "REWRITE" },
  "plugin/entry-gate.ts": { current_path: "plugin/entry-gate.ts", verdict: "REWRITE" },
  "plugin/harvest-guard.ts": { current_path: "plugin/harvest-guard.ts", verdict: "DELETE" },
  "plugin/lavish-command-gate.ts": { current_path: "plugin/lavish-command-gate.ts", verdict: "KEEP" },
  "plugin/lib/agent-catalog-health.mjs": { current_path: "plugin/lib/agent-catalog-health.mjs", verdict: "DELETE" },
  "plugin/lib/agent-idle-nudge.mjs": { current_path: "plugin/lib/agent-idle-nudge.mjs", verdict: "KEEP" },
  "plugin/lib/autonomy-controller.mjs": { current_path: "plugin/lib/autonomy-controller.mjs", verdict: "REWRITE" },
  "plugin/lib/bash-decide.mjs": { current_path: "plugin/lib/bash-decide.mjs", verdict: "REWRITE" },
  "plugin/lib/ceremony-binding.mjs": { current_path: "plugin/lib/ceremony-binding.mjs", verdict: "DELETE" },
  "plugin/lib/ceremony-transition.mjs": { current_path: "plugin/lib/ceremony-transition.mjs", verdict: "DELETE" },
  "plugin/lib/dispatch-scope.mjs": { current_path: "lib/dispatch-scope.mjs", verdict: "REWRITE" },
  "plugin/lib/entry-decide.mjs": { current_path: "lib/entry-decide.mjs", verdict: "REWRITE" },
  "lib/classify-resume.mjs": { current_path: "lib/classify-resume.mjs", verdict: "KEEP" },
  "lib/feature-resume.mjs": { current_path: "lib/feature-resume.mjs", verdict: "KEEP" },
  "plugin/lib/gate-state.mjs": { current_path: "lib/gate-state.mjs", verdict: "KEEP (MOVE)" },
  "plugin/lib/hand-records.mjs": { current_path: "lib/hand-records.mjs", verdict: "REWRITE" },
  "plugin/lib/harvest-findings.mjs": { current_path: "plugin/lib/harvest-findings.mjs", verdict: "DELETE" },
  "plugin/lib/hook-identity.mjs": { current_path: "plugin/lib/hook-identity.mjs", verdict: "KEEP" },
  "plugin/lib/host-hand-capture.mjs": { current_path: "plugin/lib/host-hand-capture.mjs", verdict: "REWRITE" },
  "plugin/lib/is-delivery-command.mjs": { current_path: "plugin/lib/is-delivery-command.mjs", verdict: "KEEP" },
  "plugin/lib/lavish-command-decide.mjs": { current_path: "plugin/lib/lavish-command-decide.mjs", verdict: "KEEP" },
  "plugin/lib/mark-gate.mjs": { current_path: "plugin/lib/mark-gate.mjs", verdict: "DELETE" },
  "plugin/lib/obs-emit.mjs": { current_path: "lib/obs-emit.mjs", verdict: "KEEP (MOVE)" },
  "plugin/lib/plan-decide.mjs": { current_path: "plugin/lib/plan-decide.mjs", verdict: "REWRITE" },
  "plugin/lib/plan-hash.mjs": { current_path: "lib/plan-hash.mjs", verdict: "KEEP (MOVE)" },
  "plugin/lib/plan-path-session.mjs": { current_path: "plugin/lib/plan-path-session.mjs", verdict: "KEEP" },
  "plugin/lib/plan-write-decide.mjs": { current_path: "plugin/lib/plan-write-decide.mjs", verdict: "REWRITE" },
  "plugin/lib/planner-artifact.mjs": { current_path: "lib/planner-artifact.mjs", verdict: "REWRITE" },
  "plugin/lib/planner-brief.mjs": { current_path: "plugin/lib/planner-brief.mjs", verdict: "REWRITE" },
  "plugin/lib/planner-fallback-config.mjs": { current_path: "lib/planner-fallback-config.mjs", verdict: "DELETE" },
  "plugin/lib/planner-result.mjs": { current_path: "plugin/lib/planner-result.mjs", verdict: "REWRITE" },
  "plugin/lib/planner-state.mjs": { current_path: "lib/planner-state.mjs", verdict: "REWRITE" },
  "plugin/lib/regate-arm.mjs": { current_path: "plugin/lib/regate-arm.mjs", verdict: "DELETE" },
  "plugin/lib/roles.mjs": { current_path: "lib/roles.mjs", verdict: "REWRITE" },
  "plugin/lib/scope-runtime-identity.mjs": { current_path: "plugin/lib/scope-runtime-identity.mjs", verdict: "REWRITE" },
  "plugin/lib/session-state.mjs": { current_path: "plugin/lib/session-state.mjs", verdict: "REWRITE" },
  "plugin/lib/task-dispatch-identity.mjs": { current_path: "lib/task-dispatch-identity.mjs", verdict: "KEEP (MOVE)" },
  "lib/runtime-todo-projection.mjs": { current_path: "lib/runtime-todo-projection.mjs", verdict: "KEEP" },
  "lib/todo-projection.mjs": { current_path: "lib/todo-projection.mjs", verdict: "KEEP" },
  "lib/worktree-baseline.mjs": { current_path: "lib/worktree-baseline.mjs", verdict: "KEEP" },
  "plugin/lib/version-check-core.ts": { current_path: "plugin/lib/version-check-core.ts", verdict: "REWRITE" },
  "plugin/marker-authority.ts": { current_path: "plugin/marker-authority.ts", verdict: "REWRITE" },
  "plugin/obs-eye.ts": { current_path: "plugin/obs-eye.ts", verdict: "KEEP" },
  "plugin/obs-hand.ts": { current_path: "plugin/obs-hand.ts", verdict: "REWRITE" },
  "plugin/obs-plan-write.ts": { current_path: "plugin/obs-plan-write.ts", verdict: "REWRITE" },
  "plugin/plan-gate.ts": { current_path: "plugin/plan-gate.ts", verdict: "REWRITE" },
  "plugin/plan-write-gate.ts": { current_path: "plugin/plan-write-gate.ts", verdict: "REWRITE" },
  "plugin/planner-recovery.ts": { current_path: "plugin/planner-recovery.ts", verdict: "REWRITE" },
  "plugin/reinject-state.ts": { current_path: "plugin/reinject-state.ts", verdict: "REWRITE" },
  "plugin/version-check.ts": { current_path: "plugin/version-check.ts", verdict: "KEEP" },
};

const OC_MODULE_NORMATIVE_METADATA = {
  "plugin/agent-idle-nudge.ts": { failure_policy: "always fail-open/advisory", tests: ["core/opencode/plugin/agent-idle-nudge.test.mjs"], cc_op: ["CC_OP:core/claude-code/hooks/agent-idle-nudge.mjs"] },
  "plugin/autonomy-controller.ts": { failure_policy: "operator capture and continuation faults open; delivery rails remain unchanged", tests: ["core/opencode/plugin/autonomy-controller.test.mjs"], cc_op: ["CC_OP:core/claude-code/hooks/agent-idle-nudge.mjs"] },
  "plugin/entry-gate.ts": { failure_policy: "factual deny; infrastructure failures open and log", tests: ["core/opencode/plugin/entry-gate.test.mjs"] },
  "plugin/harvest-guard.ts": { failure_policy: "no remaining caller after atomic deletion", tests: ["scripts/parity-manifest.test.mjs"] },
  "plugin/lavish-command-gate.ts": { failure_policy: "matched fact denies; parser and adapter errors open", tests: ["core/opencode/plugin/lavish-command-gate.test.mjs"] },
  "plugin/lib/agent-catalog-health.mjs": { failure_policy: "no remaining caller after dynamic branch removal", tests: ["scripts/parity-manifest.test.mjs"] },
  "plugin/lib/agent-idle-nudge.mjs": { failure_policy: "always fail-open/advisory", tests: ["core/opencode/plugin/lib/agent-idle-nudge.test.mjs"], cc_op: ["CC_OP:core/claude-code/hooks/agent-idle-nudge.mjs"] },
  "plugin/lib/autonomy-controller.mjs": { failure_policy: "pure projection never throws; malformed or disabled state produces no continuation", tests: ["core/opencode/plugin/lib/autonomy-controller.test.mjs"], cc_op: ["CC_OP:core/claude-code/hooks/agent-idle-nudge.mjs"] },
  "plugin/lib/bash-decide.mjs": { failure_policy: "factual deny; every other error opens and logs", tests: ["core/opencode/plugin/lib/bash-decide.test.mjs"] },
  "plugin/lib/ceremony-binding.mjs": { failure_policy: "no remaining caller after R10 simplification", tests: ["core/opencode/plugin/entry-gate.test.mjs", "core/opencode/plugin/plan-gate.test.mjs"] },
  "plugin/lib/ceremony-transition.mjs": { failure_policy: "no remaining caller after direct factual marks", tests: ["core/opencode/plugin/entry-gate.test.mjs", "core/opencode/plugin/marker-authority.test.mjs"] },
  "plugin/lib/dispatch-scope.mjs": { failure_policy: "known identity or scope violation denies; storage fault opens with diagnostic", tests: ["core/opencode/lib/dispatch-scope.test.mjs"] },
  "plugin/lib/entry-decide.mjs": { failure_policy: "factual deny; unexpected adapter error opens and logs", tests: ["core/opencode/lib/entry-decide.test.mjs"] },
  "lib/classify-resume.mjs": { failure_policy: "invalid resumed state returns no metadata and never creates a plan", tests: ["core/opencode/lib/classify-resume.test.mjs"] },
  "lib/feature-resume.mjs": { failure_policy: "invalid or missing prior artifacts do not resume; adoption writes no plan", tests: ["core/opencode/lib/feature-resume.test.mjs"] },
  "plugin/lib/gate-state.mjs": { failure_policy: "lock and write results are explicit; each reader chooses its factual rail policy", tests: ["core/opencode/lib/gate-state.test.mjs"] },
  "plugin/lib/hand-records.mjs": { failure_policy: "malformed or missing record never absolves delivery", tests: ["core/opencode/lib/hand-records.test.mjs"] },
  "plugin/lib/harvest-findings.mjs": { failure_policy: "no remaining caller after harvest bundle", tests: ["scripts/parity-manifest.test.mjs"] },
  "plugin/lib/hook-identity.mjs": { failure_policy: "trusted context conflict denies; absent non-writing context opens", tests: ["core/opencode/plugin/lib/hook-identity.test.mjs"] },
  "plugin/lib/host-hand-capture.mjs": { failure_policy: "completion and capture are separate idempotent operations", tests: ["core/opencode/plugin/lib/host-hand-capture.test.mjs"] },
  "plugin/lib/is-delivery-command.mjs": { failure_policy: "malformed input returns false", tests: ["core/opencode/plugin/lib/is-delivery-command.test.mjs"] },
  "plugin/lib/lavish-command-decide.mjs": { failure_policy: "allow unless the exact forbidden command matches", tests: ["core/opencode/plugin/lavish-command-gate.test.mjs"] },
  "plugin/lib/mark-gate.mjs": { failure_policy: "no dedicated privileged shell CLI or stale allowlist remains", tests: ["core/claude-code/skills/initializing-projects/references/vendor-core.test.mjs", "scripts/parity-manifest.test.mjs"] },
  "plugin/lib/obs-emit.mjs": { failure_policy: "always fail-open and never gates", tests: ["core/opencode/lib/obs-emit.test.mjs"], cc_op: ["CC_OP:core/claude-code/hooks/obs-eye-append.mjs"] },
  "plugin/lib/plan-decide.mjs": { failure_policy: "invalid plan denies; validator exception opens and logs", tests: ["core/opencode/plugin/plan-gate.test.mjs"] },
  "plugin/lib/plan-hash.mjs": { failure_policy: "pure deterministic hash", tests: ["core/opencode/lib/planner-canonical-write.test.mjs"] },
  "plugin/lib/plan-path-session.mjs": { failure_policy: "malformed path returns null", tests: ["core/opencode/plugin/lib/plan-path-session.test.mjs"], cc_op: ["CC_OP:core/claude-code/hooks/obs-plan-write.mjs"] },
  "plugin/lib/plan-write-decide.mjs": { failure_policy: "state, unauthorized plan and out-of-scope facts deny; incomplete unrelated context opens", tests: ["core/opencode/plugin/plan-write-gate.test.mjs"] },
  "plugin/lib/planner-artifact.mjs": { failure_policy: "invalid identity or content never binds; I/O result is explicit", tests: ["core/opencode/lib/planner-canonical-write.test.mjs"] },
  "plugin/lib/planner-brief.mjs": { failure_policy: "omit malformed optional data; no nonce or counters", tests: ["core/opencode/plugin/lib/planner-brief.test.mjs"] },
  "plugin/lib/planner-fallback-config.mjs": { failure_policy: "no remaining caller or routing role", tests: ["core/shared/lib/routing-validate.test.mjs", "core/opencode/agents/agents-manifest.test.mjs", "core/opencode/plugin/planner-recovery.test.mjs", "scripts/parity-manifest.test.mjs"] },
  "plugin/lib/planner-result.mjs": { failure_policy: "invalid or ambiguous response is factual invalid plan", tests: ["core/opencode/plugin/lib/planner-result.test.mjs"] },
  "plugin/lib/planner-state.mjs": { failure_policy: "identity mismatch rejects; I/O is explicit; no attempt caps", tests: ["core/opencode/lib/planner-state.test.mjs"] },
  "plugin/lib/regate-arm.mjs": { failure_policy: "no orphan auto-arm; explicit native marker owns the fact", tests: ["core/claude-code/skills/initializing-projects/references/vendor-core.test.mjs", "scripts/parity-manifest.test.mjs"] },
  "plugin/lib/roles.mjs": { failure_policy: "unknown role returns false", tests: ["core/opencode/agents/agents-manifest.test.mjs"] },
  "plugin/lib/scope-runtime-identity.mjs": { failure_policy: "verified writing-hand mismatch denies; non-hand or missing SDK opens", tests: ["core/opencode/plugin/plan-write-gate.test.mjs", "core/opencode/plugin/obs-hand.test.mjs"] },
  "plugin/lib/session-state.mjs": { failure_policy: "read-only recovery opens; corrupt factual pending is omitted or rejected", tests: ["core/opencode/plugin/reinject-state.test.mjs"], cc_op: ["CC_OP:core/claude-code/hooks/reinject-state.mjs"] },
  "plugin/lib/task-dispatch-identity.mjs": { failure_policy: "parse failure is pure and never mutates", tests: ["core/opencode/lib/task-dispatch-identity.test.mjs"] },
  "lib/runtime-todo-projection.mjs": { failure_policy: "missing, corrupt, or unverified runtime artifacts make the visual projection unavailable and never gate delivery", tests: ["core/opencode/plugin/marker-authority.test.mjs", "core/opencode/lib/todo-projection.test.mjs"], cc_op: ["CC_OP:core/claude-code/hooks/reinject-state.mjs"] },
  "lib/todo-projection.mjs": { failure_policy: "malformed plan or state yields a safe visual projection and never gates delivery", tests: ["core/opencode/lib/todo-projection.test.mjs"], cc_op: ["CC_OP:core/claude-code/hooks/reinject-state.mjs"] },
  "lib/worktree-baseline.mjs": { failure_policy: "unstable, invalid, or unavailable snapshots never suppress touched paths", tests: ["core/opencode/lib/worktree-baseline.test.mjs", "core/opencode/lib/dispatch-scope.test.mjs", "core/opencode/plugin/lib/host-hand-capture.test.mjs"] },
  "plugin/lib/version-check-core.ts": { failure_policy: "advisory; network and cache failures open", tests: ["core/opencode/plugin/version-check.test.mjs"], cc_op: ["CC_OP:core/claude-code/hooks/version-check.mjs"] },
  "plugin/marker-authority.ts": { failure_policy: "invalid identity, action or record denies", tests: ["core/opencode/plugin/marker-authority.test.mjs", "core/opencode/plugin/lib/marker-security.test.mjs"] },
  "plugin/obs-eye.ts": { failure_policy: "always fail-open", tests: ["core/opencode/plugin/obs-eye.test.mjs"], cc_op: ["CC_OP:core/claude-code/hooks/obs-eye-append.mjs"] },
  "plugin/obs-hand.ts": { failure_policy: "before/after observation opens; hand record never self-captures", tests: ["core/opencode/plugin/obs-hand.test.mjs", "core/opencode/plugin/obs-hooks.test.mjs"], cc_op: ["CC_OP:core/claude-code/hooks/stamp-triage.mjs"] },
  "plugin/obs-plan-write.ts": { failure_policy: "always fail-open; never mutates plan authority", tests: ["core/opencode/plugin/obs-hooks.test.mjs"], cc_op: ["CC_OP:core/claude-code/hooks/obs-plan-write.mjs"] },
  "plugin/plan-gate.ts": { failure_policy: "invalid bound plan denies; missing or unreadable infrastructure opens and logs", tests: ["core/opencode/plugin/plan-gate.test.mjs"] },
  "plugin/plan-write-gate.ts": { failure_policy: "known unauthorized write denies; unrelated identity or SDK error opens", tests: ["core/opencode/plugin/plan-write-gate.test.mjs"] },
  "plugin/planner-recovery.ts": { failure_policy: "invalid plan remains unbound; no retry, count or fallback gate", tests: ["core/opencode/plugin/planner-recovery.test.mjs"] },
  "plugin/reinject-state.ts": { failure_policy: "read and garbage-collection faults open; never gates dispatch", tests: ["core/opencode/plugin/reinject-state.test.mjs"], cc_op: ["CC_OP:core/claude-code/hooks/reinject-state.mjs"] },
  "plugin/version-check.ts": { failure_policy: "always advisory and fail-open", tests: ["core/opencode/plugin/version-check.test.mjs", "scripts/parity-manifest.test.mjs"], cc_op: ["CC_OP:core/claude-code/hooks/version-check.mjs"] },
};

const OC_MODULE_NORMATIVE_REASONS = {
  "plugin/agent-idle-nudge.ts": "Thin OpenCode adapter preserves the Claude operational nudge.",
  "plugin/autonomy-controller.ts": "Native controller turns an explicit operator autonomy directive into bounded same-session continuation.",
  "plugin/entry-gate.ts": "Retain only factual entry rails and host adaptation.",
  "plugin/harvest-guard.ts": "OpenCode-only harvest ceremony has no factual rule.",
  "plugin/lavish-command-gate.ts": "Preserves the exact share/setup-hooks command boundary.",
  "plugin/lib/agent-catalog-health.mjs": "OpenCode-only advisory is outside factual parity.",
  "plugin/lib/agent-idle-nudge.mjs": "Pure operational decision mirrors Claude behavior.",
  "plugin/lib/autonomy-controller.mjs": "Pure directive and phase projection keeps continuation policy outside the host adapter.",
  "plugin/lib/bash-decide.mjs": "Reduce Bash judgment to the factual delivery boundary.",
  "plugin/lib/ceremony-binding.mjs": "R10 is represented by plain booleans and feature match.",
  "plugin/lib/ceremony-transition.mjs": "Host marker writes ordered R10 facts directly with no sidecar.",
  "plugin/lib/dispatch-scope.mjs": "Call-keyed records prevent sibling scope borrowing and bind capture to its producer.",
  "plugin/lib/entry-decide.mjs": "Pure decision retains only triage, fidelity, re-gate and planner facts.",
  "lib/classify-resume.mjs": "Pure retry metadata keeps an adopted approved plan on the delivery route.",
  "lib/feature-resume.mjs": "Feature-scoped adoption preserves a prior plan and factual progress across sessions.",
  "plugin/lib/gate-state.mjs": "Framework-owned atomic primitive belongs outside plugin/lib.",
  "plugin/lib/hand-records.mjs": "Record identity and capture facts must remain independently verifiable.",
  "plugin/lib/harvest-findings.mjs": "Helper exists only for the deleted OpenCode harvest ceremony.",
  "plugin/lib/hook-identity.mjs": "Normalizes official host aliases without inventing authority.",
  "plugin/lib/host-hand-capture.mjs": "Host authority must not let Task completion self-certify capture.",
  "plugin/lib/is-delivery-command.mjs": "Small predicate scopes Bash rails to delivery commands.",
  "plugin/lib/lavish-command-decide.mjs": "Pure counterpart implements A1 without side effects.",
  "plugin/lib/mark-gate.mjs": "Pure formatter and HEAD resolver moved to factual owners; shell observability retired.",
  "plugin/lib/obs-emit.mjs": "Framework observation primitive is shared outside plugin adapters.",
  "plugin/lib/plan-decide.mjs": "Validation must precede plan usability.",
  "plugin/lib/plan-hash.mjs": "Shared semantic primitive belongs in the framework lib closure.",
  "plugin/lib/plan-path-session.mjs": "Observation-only parser preserves operational parity.",
  "plugin/lib/plan-write-decide.mjs": "Pure decision centralizes factual write ownership without composition machinery.",
  "plugin/lib/planner-artifact.mjs": "Sole canonical artifact path supports plan, session and scope consumers.",
  "plugin/lib/planner-brief.mjs": "Planner brief carries canonical facts without retry accounting.",
  "plugin/lib/planner-fallback-config.mjs": "R11 records plan fallback strategy, not a native fallback planner.",
  "plugin/lib/planner-result.mjs": "Parse exactly one full plan without provider retry accounting.",
  "plugin/lib/planner-state.mjs": "Identity lifecycle replaces native retry/count authority.",
  "plugin/lib/regate-arm.mjs": "Unused OC-only auto-arm contradicted the explicit parent-side re-gate flow.",
  "plugin/lib/roles.mjs": "Remove planner-fallback and keep the factual owner/hand/eye taxonomy.",
  "plugin/lib/scope-runtime-identity.mjs": "Resolve exact runtime identity without a mutable global context.",
  "plugin/lib/session-state.mjs": "Keep bounded factual recovery and remove dual/count/fallback state.",
  "plugin/lib/task-dispatch-identity.mjs": "Shared runtime identity parser belongs outside plugin/lib.",
  "lib/runtime-todo-projection.mjs": "One best-effort runtime adapter supplies the exact todo projection to both sync and durable task markers.",
  "lib/todo-projection.mjs": "Projects durable workflow facts to the best-effort OpenCode todo surface.",
  "lib/worktree-baseline.mjs": "Dispatch snapshot prevents pre-existing worktree dirt from being attributed to a writing hand.",
  "plugin/lib/version-check-core.ts": "Remove catalog-health branch and retain only version warning parity.",
  "plugin/marker-authority.ts": "Narrow authority to factual host mutations with no generic file claim.",
  "plugin/obs-eye.ts": "Observation remains operational and never authorizes delivery.",
  "plugin/obs-hand.ts": "Produce terminal facts while removing authorization side effects.",
  "plugin/obs-plan-write.ts": "Remove auto-bind/authorship and retain observation only.",
  "plugin/plan-gate.ts": "Remove second-eye reseal and ceremony sidecars.",
  "plugin/plan-write-gate.ts": "Remove composition/single-flight wall and check exact call record.",
  "plugin/planner-recovery.ts": "Keep one canonical writer and remove provider accounting.",
  "plugin/reinject-state.ts": "Reinject simplified factual session state only.",
  "plugin/version-check.ts": "Thin default-export adapter preserves version warning parity.",
};

const OC_INVENTORY_PROVENANCE = {
  base_commit: "faded65759fbab932a4362d63745c5cb4d1ea365",
  base_module_count: 55,
  frozen_module_count: 46,
  pr3_death_list: [
    "plugin/lib/second-eye-authority.mjs",
    "plugin/second-eye-coordinator.ts",
    "plugin/lib/loop-decide.mjs",
    "plugin/review-guard.ts",
    "plugin/lib/adversary-nudge.mjs",
    "plugin/lib/revise-nudge.mjs",
    "plugin/lib/review-restart.mjs",
    "plugin/ceremony-coordinator.ts",
    "plugin/lib/scope-runtime-composition.mjs",
    "plugin/lib/bound-plan.mjs",
    "plugin/lib/obs-test-isolation.mjs",
  ],
  pr3_removed_count: 11,
};

const OC_RULE_SEMANTICS = {
  R1: {
    required_outcome: "ScheduleWakeup forbidden in routine/headless",
    classification: "N/A platform",
    failure_policy: "N/A",
    implementation_targets: [],
    locked_evidence: ["parity artifact records the N/A explicitly"],
  },
  R2: {
    required_outcome: "writing hand runs foreground-only",
    classification: "N/A platform",
    failure_policy: "N/A",
    implementation_targets: [],
    locked_evidence: ["parity artifact records the N/A explicitly"],
  },
  R3: {
    required_outcome: "fidelity pass precedes executor/spawn-hand",
    classification: "preserved/rewrite",
    failure_policy: "missing factual stamp denies; lookup fault opens",
    implementation_targets: ["plugin/entry-gate.ts", "plugin/lib/bash-decide.mjs", "lib/entry-decide.mjs", "lib/gate-state.mjs", "plugin/marker-authority.ts"],
    locked_evidence: ["executor denied before fidelity; test-author/sniper exempt"],
  },
  R4: {
    required_outcome: "delivery cannot run on protected branch",
    classification: "preserve",
    failure_policy: "known protected branch denies; git probe fault opens",
    implementation_targets: ["plugin/entry-gate.ts", "plugin/lib/bash-decide.mjs", "plugin/lib/is-delivery-command.mjs"],
    locked_evidence: ["main/master/default deny"],
  },
  R5: {
    required_outcome: "delivery requires commits ahead",
    classification: "preserve",
    failure_policy: "known zero-ahead denies; git probe fault opens",
    implementation_targets: ["plugin/entry-gate.ts", "plugin/lib/bash-decide.mjs", "plugin/lib/is-delivery-command.mjs"],
    locked_evidence: ["zero ahead deny"],
  },
  R6: {
    required_outcome: "pending high-fix re-gate must be absolved",
    classification: "preserve/rewrite",
    failure_policy: "corrupt readable pending denies; I/O opens",
    implementation_targets: ["plugin/entry-gate.ts", "plugin/lib/bash-decide.mjs", "lib/entry-decide.mjs", "lib/gate-state.mjs", "plugin/lib/is-delivery-command.mjs", "plugin/lib/session-state.mjs", "plugin/marker-authority.ts"],
    locked_evidence: ["shipper and push deny stale/non-ancestor stamps"],
  },
  R7: {
    required_outcome: "hand_finished and capture_verified are distinct events",
    classification: "rewrite",
    failure_policy: "completion records only; capture absent keeps delivery blocked",
    implementation_targets: ["plugin/entry-gate.ts", "plugin/lib/bash-decide.mjs", "lib/gate-state.mjs", "lib/hand-records.mjs", "lib/worktree-baseline.mjs", "plugin/lib/host-hand-capture.mjs", "plugin/lib/is-delivery-command.mjs", "plugin/lib/session-state.mjs", "plugin/marker-authority.ts", "plugin/obs-hand.ts"],
    locked_evidence: ["Task return alone never captures"],
  },
  R8: {
    required_outcome: "capture points to a real DONE record and current ancestral SHA",
    classification: "rewrite",
    failure_policy: "missing/mismatched record is no-op/reject; delivery remains blocked",
    implementation_targets: ["plugin/entry-gate.ts", "plugin/lib/bash-decide.mjs", "lib/dispatch-scope.mjs", "lib/gate-state.mjs", "lib/hand-records.mjs", "lib/worktree-baseline.mjs", "plugin/lib/host-hand-capture.mjs", "plugin/lib/is-delivery-command.mjs", "plugin/lib/session-state.mjs", "plugin/marker-authority.ts"],
    locked_evidence: ["real record, task/feature/session/call/SHA all match"],
  },
  R9: {
    required_outcome: "LIGHT/FULL triage precedes delivery roles",
    classification: "preserve",
    failure_policy: "missing factual triage denies; unreadable state opens only when identity exists",
    implementation_targets: ["plugin/entry-gate.ts", "lib/entry-decide.mjs", "lib/gate-state.mjs", "lib/roles.mjs", "plugin/lib/session-state.mjs", "lib/task-dispatch-identity.mjs"],
    locked_evidence: ["all delivery roles denied outside LIGHT/FULL"],
  },
  R10: {
    required_outcome: "planner requires brainstorming and spec adversary",
    classification: "simplify",
    failure_policy: "missing marker/feature mismatch denies; state read fault opens",
    implementation_targets: ["plugin/entry-gate.ts", "lib/entry-decide.mjs", "lib/gate-state.mjs", "lib/roles.mjs", "plugin/lib/session-state.mjs", "plugin/marker-authority.ts"],
    locked_evidence: ["no ceremony sidecar/HMAC/recovery coordinator"],
  },
  R11: {
    required_outcome: "dispatch/plan records strategy, model, fallback and canonical task scope",
    classification: "rewrite",
    failure_policy: "malformed canonical plan/dispatch denies; observation failures open",
    implementation_targets: ["lib/classify-resume.mjs", "lib/dispatch-scope.mjs", "lib/feature-resume.mjs", "lib/gate-state.mjs", "plugin/lib/hook-identity.mjs", "lib/plan-hash.mjs", "lib/planner-artifact.mjs", "plugin/lib/planner-brief.mjs", "lib/planner-state.mjs", "lib/roles.mjs", "plugin/lib/session-state.mjs", "lib/task-dispatch-identity.mjs", "plugin/obs-hand.ts", "plugin/plan-gate.ts", "plugin/planner-recovery.ts"],
    locked_evidence: ["plan model strategy and task scope survive compaction/vendor"],
  },
  R12: {
    required_outcome: "runtime state and plan files have an authorized owner",
    classification: "rewrite",
    failure_policy: "unauthorized official Write/Edit denies",
    implementation_targets: ["lib/gate-state.mjs", "plugin/lib/hook-identity.mjs", "plugin/lib/plan-write-decide.mjs", "lib/roles.mjs", "plugin/lib/scope-runtime-identity.mjs", "plugin/marker-authority.ts", "plugin/plan-write-gate.ts"],
    locked_evidence: ["model cannot author .state or plan outside planner path"],
  },
  R13: {
    required_outcome: "writing-hand writes respect scope_paths/allowed_writes",
    classification: "rewrite",
    failure_policy: "known hand/out-of-scope denies; missing non-hand context opens",
    implementation_targets: ["lib/dispatch-scope.mjs", "lib/gate-state.mjs", "plugin/lib/hook-identity.mjs", "plugin/lib/plan-write-decide.mjs", "lib/roles.mjs", "plugin/lib/scope-runtime-identity.mjs", "lib/task-dispatch-identity.mjs", "plugin/obs-hand.ts", "plugin/plan-write-gate.ts"],
    locked_evidence: ["concurrent hands cannot borrow sibling scope"],
  },
  R14: {
    required_outcome: "only planner authors/revises the plan",
    classification: "align to CC",
    failure_policy: "non-planner plan write denies",
    implementation_targets: ["lib/gate-state.mjs", "plugin/lib/plan-write-decide.mjs", "lib/planner-artifact.mjs", "lib/planner-state.mjs", "lib/roles.mjs", "plugin/plan-write-gate.ts", "plugin/planner-recovery.ts"],
    locked_evidence: ["orchestrator/eye/hand cannot write plan"],
  },
  R15: {
    required_outcome: "plan validates model strategy before becoming usable",
    classification: "align to CC",
    failure_policy: "invalid content denies; internal validator fault opens/logs",
    implementation_targets: ["lib/gate-state.mjs", "plugin/lib/plan-decide.mjs", "lib/plan-hash.mjs", "plugin/lib/plan-write-decide.mjs", "lib/planner-artifact.mjs", "plugin/lib/planner-result.mjs", "lib/planner-state.mjs", "plugin/plan-gate.ts", "plugin/plan-write-gate.ts", "plugin/planner-recovery.ts"],
    locked_evidence: ["legacy tiers and missing/invalid hand_tiers rejected"],
  },
  A1: {
    required_outcome: "block lavish share and setup hooks",
    classification: "preserve 1:1",
    failure_policy: "matched command denies; parser fault opens",
    implementation_targets: ["plugin/lavish-command-gate.ts", "plugin/lib/lavish-command-decide.mjs"],
    locked_evidence: ["focused command matrix"],
  },
};

function readOcModuleManifest() {
  assert.equal(existsSync(OC_MODULE_MANIFEST_PATH), true, `missing normative manifest: ${OC_MODULE_MANIFEST_PATH}`);
  return JSON.parse(readFileSync(OC_MODULE_MANIFEST_PATH, "utf8"));
}

const OC_SOURCE_MODULE_RE = /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
const OC_TEST_MODULE_RE = /\.(?:test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
const OC_EXCLUDED_LIVE_DIRS = new Set([".git", "__fixtures__", "__tests__", "fixtures", "history", "node_modules", "test", "tests"]);
const OC_IMPORT_EXTENSIONS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];
const OC_IMPORT_INDEX_FILES = ["index.ts", "index.tsx", "index.js", "index.jsx", "index.mjs", "index.cjs", "index.mts", "index.cts"];
const OC_OPAQUE_LOADER_ALLOWLIST = new Map([
  ["scripts/parity-manifest.mjs", new Set(["pathToFileURL(join(pluginDir, name)).href"])],
  [
    "core/vps/run-cron-review.mjs",
    new Set([
      'join(root, ".claude/modules/codex-adversary/references/codex-adversary.mjs")',
      'join(root, ".claude/modules/codex-adversary/references/merge-findings.mjs")',
    ]),
  ],
]);
function slashPath(path) {
  return path.split(sep).join("/");
}

function walkLiveModules(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) return OC_EXCLUDED_LIVE_DIRS.has(entry.name) ? [] : walkLiveModules(absolute);
    return OC_SOURCE_MODULE_RE.test(entry.name) && !OC_TEST_MODULE_RE.test(entry.name) ? [absolute] : [];
  });
}

function currentOcModuleInventory(root = resolve("core/opencode")) {
  return [join(root, "lib"), join(root, "plugin")]
    .flatMap(walkLiveModules)
    .map((file) => slashPath(relative(root, file)))
    .sort();
}

function repositoryLiveModules(repositoryRoot) {
  return ["core", "scripts", "modules"]
    .map((root) => join(repositoryRoot, root))
    .flatMap(walkLiveModules);
}

function specifierCanResolveToTarget(fromFile, specifier, target) {
  const pathOnlySpecifier = specifier.replace(/[?#].*$/, "");
  if (!pathOnlySpecifier.startsWith(".")) return false;
  const base = resolve(dirname(fromFile), pathOnlySpecifier);
  return OC_IMPORT_EXTENSIONS.some((extension) => base + extension === target)
    || OC_IMPORT_INDEX_FILES.some((indexFile) => join(base, indexFile) === target);
}

function skipLineComment(source, index, limit = source.length) {
  let cursor = index + 2;
  while (cursor < limit && source[cursor] !== "\n" && source[cursor] !== "\r") cursor += 1;
  return cursor;
}

function skipBlockComment(source, index, limit = source.length) {
  const close = source.indexOf("*/", index + 2);
  return close === -1 || close >= limit ? limit : close + 2;
}

function skipQuotedString(source, index, limit = source.length) {
  const quote = source[index];
  let cursor = index + 1;
  while (cursor < limit) {
    if (source[cursor] === "\\") cursor += 2;
    else if (source[cursor] === quote) return cursor + 1;
    else cursor += 1;
  }
  return limit;
}

function looksLikeRegexLiteral(source, index) {
  let cursor = index - 1;
  while (cursor >= 0 && /\s/.test(source[cursor])) cursor -= 1;
  if (cursor < 0) return true;
  if (
    (source[cursor] === "+" || source[cursor] === "-")
    && source[cursor - 1] === source[cursor]
  ) return false;
  if (
    source[cursor] === ")"
    && /\b(?:if|while|for|with|switch|catch)\s*\([^;{}]*\)\s*$/.test(source.slice(0, index))
  ) return true;
  if (/[=(:,!\[\{;?&|+\-*%^~<>]/.test(source[cursor])) return true;
  const prefixWord = source.slice(0, cursor + 1).match(/([A-Za-z_$][\w$]*)$/)?.[1];
  return new Set(["await", "case", "delete", "else", "return", "throw", "typeof", "void", "yield"]).has(prefixWord);
}

function skipRegexLiteral(source, index, limit = source.length) {
  let cursor = index + 1;
  let inCharacterClass = false;
  while (cursor < limit) {
    const char = source[cursor];
    if (char === "\\") cursor += 2;
    else if (char === "[") {
      inCharacterClass = true;
      cursor += 1;
    } else if (char === "]") {
      inCharacterClass = false;
      cursor += 1;
    } else if (char === "/" && !inCharacterClass) {
      cursor += 1;
      while (cursor < limit && /[A-Za-z]/.test(source[cursor])) cursor += 1;
      return cursor;
    } else cursor += 1;
  }
  return limit;
}

function skipTrivia(source, index, limit = source.length) {
  let cursor = index;
  while (cursor < limit) {
    if (/\s/.test(source[cursor])) cursor += 1;
    else if (source.startsWith("//", cursor)) cursor = skipLineComment(source, cursor, limit);
    else if (source.startsWith("/*", cursor)) cursor = skipBlockComment(source, cursor, limit);
    else break;
  }
  return cursor;
}

function findMatchingDelimiter(source, openIndex, openChar, closeChar, limit = source.length) {
  let depth = 1;
  let cursor = openIndex + 1;
  while (cursor < limit) {
    if (source.startsWith("//", cursor)) cursor = skipLineComment(source, cursor, limit);
    else if (source.startsWith("/*", cursor)) cursor = skipBlockComment(source, cursor, limit);
    else if (source[cursor] === '"' || source[cursor] === "'") cursor = skipQuotedString(source, cursor, limit);
    else if (source[cursor] === "`") cursor = skipTemplateLiteral(source, cursor, limit);
    else if (source[cursor] === "/" && looksLikeRegexLiteral(source, cursor)) cursor = skipRegexLiteral(source, cursor, limit);
    else if (source[cursor] === openChar) {
      depth += 1;
      cursor += 1;
    } else if (source[cursor] === closeChar) {
      depth -= 1;
      if (depth === 0) return cursor;
      cursor += 1;
    } else cursor += 1;
  }
  return limit;
}

function skipTemplateLiteral(source, index, limit = source.length) {
  let cursor = index + 1;
  while (cursor < limit) {
    if (source[cursor] === "\\") cursor += 2;
    else if (source[cursor] === "`") return cursor + 1;
    else if (source[cursor] === "$" && source[cursor + 1] === "{") {
      const close = findMatchingDelimiter(source, cursor + 1, "{", "}", limit);
      cursor = close < limit ? close + 1 : limit;
    } else cursor += 1;
  }
  return limit;
}

function firstCallArgument(source, openIndex, closeIndex) {
  let cursor = openIndex + 1;
  while (cursor < closeIndex) {
    if (source.startsWith("//", cursor)) cursor = skipLineComment(source, cursor, closeIndex);
    else if (source.startsWith("/*", cursor)) cursor = skipBlockComment(source, cursor, closeIndex);
    else if (source[cursor] === '"' || source[cursor] === "'") cursor = skipQuotedString(source, cursor, closeIndex);
    else if (source[cursor] === "`") cursor = skipTemplateLiteral(source, cursor, closeIndex);
    else if (source[cursor] === "/" && looksLikeRegexLiteral(source, cursor)) cursor = skipRegexLiteral(source, cursor, closeIndex);
    else if (source[cursor] === "(" || source[cursor] === "[" || source[cursor] === "{") {
      const pairs = { "(": ")", "[": "]", "{": "}" };
      const close = findMatchingDelimiter(source, cursor, source[cursor], pairs[source[cursor]], closeIndex);
      cursor = close < closeIndex ? close + 1 : closeIndex;
    } else if (source[cursor] === ",") return source.slice(openIndex + 1, cursor);
    else cursor += 1;
  }
  return source.slice(openIndex + 1, closeIndex);
}

function directLiteralImportSpecifier(firstArgument) {
  let cursor = skipTrivia(firstArgument, 0);
  if (firstArgument[cursor] !== '"' && firstArgument[cursor] !== "'") return null;
  const end = skipQuotedString(firstArgument, cursor);
  const specifier = firstArgument.slice(cursor + 1, end - 1);
  cursor = skipTrivia(firstArgument, end);
  return cursor === firstArgument.length ? specifier : null;
}

function scanModuleLoaderSyntax(source) {
  const calls = [];
  const literalSpecifiers = [];
  const opaqueLoaderTokens = [];
  const identifierEscapes = [];

  function scanCode(start, limit) {
    let cursor = start;
    while (cursor < limit) {
      if (source.startsWith("//", cursor)) cursor = skipLineComment(source, cursor, limit);
      else if (source.startsWith("/*", cursor)) cursor = skipBlockComment(source, cursor, limit);
      else if (source[cursor] === '"' || source[cursor] === "'") cursor = skipQuotedString(source, cursor, limit);
      else if (source[cursor] === "`") {
        let templateCursor = cursor + 1;
        while (templateCursor < limit) {
          if (source[templateCursor] === "\\") templateCursor += 2;
          else if (source[templateCursor] === "`") {
            templateCursor += 1;
            break;
          } else if (source[templateCursor] === "$" && source[templateCursor + 1] === "{") {
            const close = findMatchingDelimiter(source, templateCursor + 1, "{", "}", limit);
            scanCode(templateCursor + 2, close);
            templateCursor = close < limit ? close + 1 : limit;
          } else templateCursor += 1;
        }
        cursor = templateCursor;
      } else if (source[cursor] === "/" && looksLikeRegexLiteral(source, cursor)) {
        cursor = skipRegexLiteral(source, cursor, limit);
      } else if (source[cursor] === "\\" && /^\\u(?:\{[0-9A-Fa-f]+\}|[0-9A-Fa-f]{4})/.test(source.slice(cursor))) {
        const escapedIdentifier = source.slice(cursor).match(/^\\u(?:\{[0-9A-Fa-f]+\}|[0-9A-Fa-f]{4})/)[0];
        identifierEscapes.push(escapedIdentifier);
        cursor += escapedIdentifier.length;
      } else if (/[A-Za-z_$]/.test(source[cursor])) {
        const identifierStart = cursor;
        cursor += 1;
        while (cursor < limit && /[\w$]/.test(source[cursor])) cursor += 1;
        const identifier = source.slice(identifierStart, cursor);
        const argumentOpen = skipTrivia(source, cursor, limit);
        if (["import", "require", "createRequire"].includes(identifier) && source[argumentOpen] === "(") {
          const argumentClose = findMatchingDelimiter(source, argumentOpen, "(", ")", limit);
          const firstArgument = firstCallArgument(source, argumentOpen, argumentClose);
          const literalSpecifier = identifier === "import" ? directLiteralImportSpecifier(firstArgument) : null;
          calls.push({ name: identifier, firstArgument, literalSpecifier });
          if (literalSpecifier !== null) literalSpecifiers.push(literalSpecifier);
        } else if (identifier === "require" || identifier === "createRequire") {
          opaqueLoaderTokens.push(identifier);
        } else if (identifier === "import" && (source[argumentOpen] === '"' || source[argumentOpen] === "'")) {
          const end = skipQuotedString(source, argumentOpen, limit);
          literalSpecifiers.push(source.slice(argumentOpen + 1, end - 1));
        } else if (identifier === "from" && (source[argumentOpen] === '"' || source[argumentOpen] === "'")) {
          const end = skipQuotedString(source, argumentOpen, limit);
          literalSpecifiers.push(source.slice(argumentOpen + 1, end - 1));
        }
      } else cursor += 1;
    }
  }

  scanCode(0, source.length);
  return { calls, identifierEscapes, literalSpecifiers, opaqueLoaderTokens };
}

function normalizeOpaqueLoaderArgument(argument) {
  return argument.trim();
}

function assertOpaqueLoadersAudited(syntax, importerPath, observedAllowlist) {
  if (syntax.identifierEscapes.length > 0) {
    throw new Error(`identifier escape is not auditable: ${importerPath}: ${syntax.identifierEscapes[0]}`);
  }
  if (syntax.opaqueLoaderTokens.length > 0) {
    throw new Error(`opaque module loader is not allowlisted: ${importerPath}: ${syntax.opaqueLoaderTokens[0]} value`);
  }
  for (const { name, firstArgument, literalSpecifier } of syntax.calls) {
    const normalized = normalizeOpaqueLoaderArgument(firstArgument);
    if (name !== "import") {
      throw new Error(`opaque module loader is not allowlisted: ${importerPath}: ${name}(${normalized})`);
    }
    if (literalSpecifier !== null) continue;
    if (!OC_OPAQUE_LOADER_ALLOWLIST.get(importerPath)?.has(normalized)) {
      throw new Error(`opaque module loader is not allowlisted: ${importerPath}: import(${normalized})`);
    }
    observedAllowlist.add(`${importerPath}\0${normalized}`);
  }
}

function assertPresentAllowlistObserved(repositoryRoot, observedAllowlist) {
  for (const [importerPath, argumentsAllowlist] of OC_OPAQUE_LOADER_ALLOWLIST) {
    if (!existsSync(join(repositoryRoot, importerPath))) continue;
    for (const argument of argumentsAllowlist) {
      assert.equal(
        observedAllowlist.has(`${importerPath}\0${argument}`),
        true,
        `allowlisted loader is absent or changed: ${importerPath}: import(${argument})`,
      );
    }
  }
}

function assertSupportedLiteralSpecifier(specifier, importerPath) {
  const encodedRelativePrefix = /^(?:%2e|\\u(?:\{0*2e\}|0*02e)|\\x2e)/i;
  const looksRelative = specifier.startsWith(".") || encodedRelativePrefix.test(specifier);
  const hasEncoding = /%[0-9A-Fa-f]{2}/.test(specifier) || /\\(?:u\{[0-9A-Fa-f]+\}|u[0-9A-Fa-f]{4}|x[0-9A-Fa-f]{2}|.)/.test(specifier);
  if (looksRelative && hasEncoding) {
    throw new Error(`unsupported encoded relative import: ${importerPath}: ${specifier}`);
  }
}

function liveImportersOf(modulePath, repositoryRoot = resolve(".")) {
  const target = resolve(repositoryRoot, "core/opencode", modulePath);
  const importers = [];
  const observedAllowlist = new Set();
  for (const file of repositoryLiveModules(repositoryRoot)) {
    if (file === target) continue;
    const raw = readFileSync(file, "utf8");
    const importerPath = slashPath(relative(repositoryRoot, file));
    const syntax = scanModuleLoaderSyntax(raw);
    assertOpaqueLoadersAudited(syntax, importerPath, observedAllowlist);
    for (const specifier of syntax.literalSpecifiers) assertSupportedLiteralSpecifier(specifier, importerPath);
    const importsTarget = syntax.literalSpecifiers.some((specifier) => specifierCanResolveToTarget(file, specifier, target));
    if (importsTarget) importers.push(importerPath);
  }
  assertPresentAllowlistObserved(repositoryRoot, observedAllowlist);
  return importers.sort();
}

function declaredPathConsumers(row) {
  return row.consumers.filter((consumer) => /^(?:core|modules|scripts)\/.+\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(consumer)).sort();
}

function assertExactModuleTriples(rows) {
  const actual = Object.fromEntries(rows.map(({ original_path, current_path, verdict }) => [original_path, { current_path, verdict }]));
  assert.deepEqual(actual, OC_FROZEN_MODULES, "module original/current/verdict triples drifted");
}

function assertCurrentInventoryCovered(rows, inventory = currentOcModuleInventory()) {
  const represented = rows
    .filter(({ current_path }) => existsSync(join("core/opencode", current_path)))
    .map(({ current_path }) => current_path)
    .sort();
  assert.deepEqual(represented, inventory, "current source inventory differs from the normative manifest");
}

function assertRuleSemantics(rules) {
  const actual = Object.fromEntries(rules.map(({ id, ...semantics }) => [id, semantics]));
  assert.deepEqual(actual, OC_RULE_SEMANTICS, "factual rule semantics drifted");
}

function assertRepositoryRelativeFile(file, repositoryRoot, label) {
  assert.equal(isAbsolute(file), false, `${label} must be repo-relative: ${file}`);
  assert.equal(file.includes("\\"), false, `${label} must use repo-relative slash paths: ${file}`);
  const absolute = resolve(repositoryRoot, file);
  const fromRoot = relative(repositoryRoot, absolute);
  assert.equal(fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`), false, `${label} escapes the repo: ${file}`);
  assert.equal(existsSync(absolute), true, `${label} does not exist: ${file}`);
  assert.equal(statSync(absolute).isFile(), true, `${label} is not a file: ${file}`);
}

function assertRuleTargetContract(manifest, repositoryRoot = resolve(".")) {
  const modulesByCurrentPath = new Map(manifest.modules.map((row) => [row.current_path, row]));
  for (const rule of manifest.rules) {
    const declaredByModules = manifest.modules
      .filter(({ rule_ids }) => rule_ids.includes(rule.id))
      .map(({ current_path }) => current_path)
      .sort();
    assert.deepEqual(declaredByModules, rule.implementation_targets.slice().sort(), `module/rule target mismatch: ${rule.id}`);
    for (const target of rule.implementation_targets) {
      assert.equal(modulesByCurrentPath.has(target), true, `rule target is not a current module path: ${rule.id}:${target}`);
      assertRepositoryRelativeFile(`${manifest.path_root}/${target}`, repositoryRoot, `rule target ${rule.id}`);
    }
  }
}

function assertModuleEvidence(row, repositoryRoot = resolve(".")) {
  assert.equal(new Set(row.cc_evidence).size, row.cc_evidence.length, `duplicate evidence: ${row.current_path}`);
  if (row.verdict === "DELETE") {
    assert.deepEqual(row.cc_evidence, ["NO_CC_COUNTERPART"], `DELETE evidence must use the exact sentinel: ${row.current_path}`);
    return;
  }
  const ruleEvidence = row.cc_evidence.filter((evidence) => evidence.startsWith("RULE:"));
  const ccOpEvidence = row.cc_evidence.filter((evidence) => evidence.startsWith("CC_OP:"));
  if (row.rule_ids.length > 0) {
    const expected = row.rule_ids.map((id) => `RULE:${id}`).sort();
    assert.deepEqual(ruleEvidence.slice().sort(), expected, `RULE evidence must exactly cover rule_ids: ${row.current_path}`);
  } else {
    assert.deepEqual(ruleEvidence, [], `non-rule evidence cannot claim a RULE: ${row.current_path}`);
  }
  assert.equal(ruleEvidence.length + ccOpEvidence.length, row.cc_evidence.length, `evidence must be RULE or CC_OP: ${row.current_path}`);
  assert.ok(ruleEvidence.length > 0 || ccOpEvidence.length > 0, `evidence must be non-empty: ${row.current_path}`);
  for (const evidence of ccOpEvidence) {
    assertRepositoryRelativeFile(evidence.slice("CC_OP:".length), repositoryRoot, `CC_OP evidence for ${row.current_path}`);
  }
  const normativeMetadata = OC_MODULE_NORMATIVE_METADATA[row.original_path];
  assert.notEqual(normativeMetadata, undefined, `missing normative evidence fixture: ${row.original_path}`);
  assert.deepEqual(
    ccOpEvidence,
    normativeMetadata.cc_op ?? [],
    `normative CC_OP evidence drifted: ${row.current_path}`,
  );
}

function assertModuleTests(row, repositoryRoot = resolve(".")) {
  for (const testPath of row.tests) assertRepositoryRelativeFile(testPath, repositoryRoot, `locked test for ${row.current_path}`);
}

function assertNormativeModuleMetadata(rows) {
  assert.deepEqual(
    rows.map(({ original_path }) => original_path).sort(),
    Object.keys(OC_MODULE_NORMATIVE_METADATA).sort(),
    "normative module metadata inventory drifted",
  );
  assert.deepEqual(
    Object.keys(OC_MODULE_NORMATIVE_REASONS).sort(),
    Object.keys(OC_MODULE_NORMATIVE_METADATA).sort(),
    "normative reason inventory drifted",
  );
  for (const row of rows) {
    const metadata = OC_MODULE_NORMATIVE_METADATA[row.original_path];
    const expected = {
      failure_policy: metadata.failure_policy,
      tests: metadata.tests,
      reason: OC_MODULE_NORMATIVE_REASONS[row.original_path],
      cc_op: metadata.cc_op ?? [],
    };
    const actual = {
      failure_policy: row.failure_policy,
      tests: row.tests,
      reason: row.reason,
      cc_op: row.cc_evidence.filter((evidence) => evidence.startsWith("CC_OP:")),
    };
    assert.deepEqual(actual, expected, `normative module metadata drifted: ${row.original_path}`);
  }
}

function assertConsumerContract(row, repositoryRoot = resolve(".")) {
  const actual = liveImportersOf(row.current_path, repositoryRoot);
  assert.equal(new Set(row.consumers).size, row.consumers.length, `duplicate consumer: ${row.current_path}`);
  const hasNoLiveConsumer = row.consumers.includes("NO_LIVE_CONSUMER");
  const hasAutoloadConsumer = row.consumers.includes("OPENCODE_PLUGIN_AUTOLOAD");
  const isCatalogedAutoload = OC_AUTOLOAD_PLUGIN_PATHS.has(row.current_path);
  if (hasNoLiveConsumer) {
    assert.deepEqual(row.consumers, ["NO_LIVE_CONSUMER"], `NO_LIVE_CONSUMER must be exclusive: ${row.current_path}`);
    assert.equal(isCatalogedAutoload, false, `cataloged autoload plugin cannot declare NO_LIVE_CONSUMER: ${row.current_path}`);
    assert.deepEqual(actual, [], `NO_LIVE_CONSUMER hides a caller: ${row.current_path}`);
    return;
  }
  assert.equal(hasAutoloadConsumer, isCatalogedAutoload, `autoload consumer does not match vendor catalog: ${row.current_path}`);
  if (isCatalogedAutoload) {
    assert.equal(existsSync(join(repositoryRoot, "core/opencode", row.current_path)), true, `autoload plugin is absent: ${row.current_path}`);
  }
  const declared = declaredPathConsumers(row);
  assert.equal(
    declared.length + Number(hasAutoloadConsumer),
    row.consumers.length,
    `consumer must be the autoload sentinel or a source path: ${row.current_path}`,
  );
  for (const consumer of declared) {
    assert.equal(existsSync(join(repositoryRoot, consumer)), true, `declared consumer is not a live file: ${consumer}`);
  }
  assert.deepEqual(actual, declared, `consumer drift: ${row.current_path}`);
}

function assertPendingDeleteFixture(manifest) {
  assert.deepEqual(manifest.pending_delete_paths, OC_PENDING_DELETE_PATHS, "pending DELETE fixture drifted");
}

/** @description Enforces the explicit PR4.1 pending state and the final PR4.2 deleted state on every run. */
function assertDeleteTransitionContract(manifest, repositoryRoot = resolve(".")) {
  assert.equal(Array.isArray(manifest.pending_delete_paths), true, "pending_delete_paths must be an array");
  const pending = new Set(manifest.pending_delete_paths);
  assert.equal(pending.size, manifest.pending_delete_paths.length, "duplicate pending DELETE path");
  const deleteRows = manifest.modules.filter(({ verdict }) => verdict === "DELETE");
  const deleteByPath = new Map(deleteRows.map((row) => [row.current_path, row]));
  for (const pendingPath of pending) {
    assert.equal(deleteByPath.has(pendingPath), true, `pending path is not a DELETE row: ${pendingPath}`);
  }
  for (const row of deleteRows) {
    const sourceExists = existsSync(join(repositoryRoot, manifest.path_root, row.current_path));
    if (sourceExists) {
      assert.equal(pending.has(row.current_path), true, `present DELETE source is not pending: ${row.current_path}`);
      assertConsumerContract(row, repositoryRoot);
      continue;
    }
    assert.equal(pending.has(row.current_path), false, `pending DELETE source is absent: ${row.current_path}`);
    assert.deepEqual(row.consumers, ["NO_LIVE_CONSUMER"], `deleted module retains caller metadata: ${row.current_path}`);
    assert.deepEqual(liveImportersOf(row.current_path, repositoryRoot), [], `deleted module still has a live importer: ${row.current_path}`);
  }
}

describe("parity-manifest", () => {
  const canonicalRouting = JSON.parse(
    readFileSync(new URL("../core/opencode/harness.routing.json", import.meta.url), "utf8"),
  );
  it("t11-agents: fails when required OC agent file missing unless on skip list", () => {
    const res = checkAgentsPresent("core/opencode", "opencode");
    assert.equal(res.ok, true, `missing OC agents: ${(res.missing || []).join(", ")}`);
    assert.equal(res.missing.length, 0);

    const tmp = mkdtempSync(join(tmpdir(), "parity-agents-"));
    try {
      mkdirSync(join(tmp, "agents"), { recursive: true });
      writeFileSync(join(tmp, "agents", "planner.md"), "# planner\n");
      const bad = checkAgentsPresent(tmp, "opencode");
      assert.equal(bad.ok, false);
      assert.ok(bad.missing.includes("adversary"));
      assert.ok(bad.missing.includes("build"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("t11-canonical-review-agents: single evaluator + alias stubs are mandatory", () => {
    for (const required of [
      "plan-reviewer",
      "adversary",
      "plan-reviewer-family-1",
      "adversary-family-1",
      "plan-reviewer-family-2",
      "adversary-family-2",
    ]) {
      assert.ok(OC_REQUIRED_AGENTS.includes(required), required);
    }
    for (const missing of ["plan-reviewer", "adversary"]) {
      const tmp = mkdtempSync(join(tmpdir(), "parity-canonical-agent-"));
      try {
        mkdirSync(join(tmp, "agents"), { recursive: true });
        for (const agent of OC_REQUIRED_AGENTS.filter((name) => name !== missing)) {
          writeFileSync(join(tmp, "agents", `${agent}.md`), `# ${agent}\n`);
        }
        const result = checkAgentsPresent(tmp, "opencode");
        assert.equal(result.ok, false);
        assert.deepEqual(result.missing, [missing]);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }
  });

  it("t11-tokens: fails when OC plugins source contains hand auth token reads", () => {
    const clean = checkNoTokenReads("core/opencode");
    assert.equal(clean.ok, true, `token hits: ${JSON.stringify(clean.hits)}`);

    const tmp = mkdtempSync(join(tmpdir(), "parity-tok-"));
    try {
      mkdirSync(join(tmp, "plugin"), { recursive: true });
      writeFileSync(join(tmp, "plugin", "entry-gate.ts"), "export default {}\n");
      writeFileSync(
        join(tmp, "plugin", "evil.ts"),
        'const t = process.env.OLLAMA_HAND_TOKEN;\n',
      );
      const dirty = checkNoTokenReads(tmp);
      assert.equal(dirty.ok, false);
      assert.ok(dirty.hits.length >= 1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("t11-routing: asserts single-evaluator routing validates", () => {
    const res = checkDualConfig("core/opencode");
    assert.equal(res.ok, true, res.reason || "single-evaluator routing required");
    assert.equal(canonicalRouting.roles.adversary.model, "openai/gpt-5.6-sol");
    assert.equal(canonicalRouting.roles["plan-reviewer"].model, "openai/gpt-5.6-sol");
    assert.equal(canonicalRouting.roles["test-author"].model, "openai/gpt-5.6-sol");
  });

  it("t11-routing-validator: fails on manipulated model capabilities", () => {
    for (const mutate of [
      (routing) => { routing.roles.build.model = "tampered/missing-capability"; },
      (routing) => { delete routing.roles.adversary.model; },
      (routing) => { routing.roles.adversary.secondEyeModel = "not-a-slug"; },
    ]) {
      const tmp = mkdtempSync(join(tmpdir(), "parity-routing-validator-"));
      try {
        mkdirSync(join(tmp, "plugin"), { recursive: true });
        writeFileSync(join(tmp, "plugin", "entry-gate.ts"), "export {};\n");
        const routing = structuredClone(canonicalRouting);
        mutate(routing);
        writeFileSync(join(tmp, "harness.routing.json"), JSON.stringify(routing));
        const result = checkDualConfig(tmp);
        assert.equal(result.ok, false);
        assert.equal(typeof result.reason, "string");
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }
  });

  it("t11-real-gates: gates + oracle and full parity run against the real repo, not a fixture", () => {
    for (const target of ["core/opencode", "core/claude-code"]) {
      const res = checkGatesAndOracle(target);
      assert.equal(res.ok, true, `${target} missing gates/oracle: ${res.missing.join(", ")}`);
    }
    const parity = runParity();
    const broken = Object.entries(parity.results)
      .flatMap(([target, r]) =>
        Object.entries(r)
          .filter(([, check]) => check && check.ok === false)
          .map(([name, check]) => `${target}.${name}: ${JSON.stringify(check)}`),
      );
    assert.deepEqual(broken, []);
    assert.equal(parity.ok, true);
  });

  it("t11-tokens-missing-root: an OC target with no plugin/ fails instead of passing vacuously", () => {
    const tmp = mkdtempSync(join(tmpdir(), "parity-opencode-empty-"));
    try {
      const res = checkNoTokenReads(tmp);
      assert.equal(res.ok, false);
      assert.deepEqual(res.missingRoots, ["plugin"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("t11-plugin-load: every auto-globbed plugin of core/opencode imports, default-exports a function, and that factory returns hooks when called", async () => {
    const res = await checkPluginLoad("core/opencode");
    assert.equal(
      res.ok,
      true,
      `failures: ${JSON.stringify(res.failures)} missing: ${res.missing.join(", ")}`,
    );
    assert.ok(res.files.length >= 8, `expected auto-globbed plugins, got ${res.files.length}`);
  });

  it("t11-plugin-load-broken-import: a plugin importing a missing module fails the check (P0 — OC skips it in silence)", async () => {
    const tmp = makeModuleFixture("parity-plugin-broken-");
    try {
      writeFileSync(
        join(tmp, "plugin", "entry-gate.ts"),
        'import "./lib/does-not-exist.mjs";\nexport default function plugin() {}\n',
      );
      const res = await checkPluginLoad(tmp);
      assert.equal(res.ok, false);
      const failure = res.failures.find((f) => f.file === "entry-gate.ts");
      assert.ok(failure, `expected entry-gate.ts failure, got ${JSON.stringify(res.failures)}`);
      assert.match(failure.reason, /import failed/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("t11-plugin-load-no-default: a plugin without a function default export fails the check", async () => {
    const tmp = makeModuleFixture("parity-plugin-nodefault-");
    try {
      writeFileSync(join(tmp, "plugin", "entry-gate.ts"), "export const notAPlugin = 1;\n");
      const res = await checkPluginLoad(tmp);
      assert.equal(res.ok, false);
      const failure = res.failures.find((f) => f.file === "entry-gate.ts");
      assert.ok(failure, `expected entry-gate.ts failure, got ${JSON.stringify(res.failures)}`);
      assert.match(failure.reason, /default export is undefined/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("t11-plugin-load-host-value-import-no-default: M1 value host imports cannot skip default-export validation", async () => {
    const tmp = makeModuleFixture("parity-plugin-host-value-nodefault-");
    try {
      for (const entry of harnessOcPluginFiles()) {
        const name = entry.split("/").pop();
        const source = name === "plan-gate.ts"
          ? 'import { Plugin } from "@opencode-ai/plugin";\nexport const notAPlugin = Plugin;\n'
          : 'import { Plugin } from "@opencode-ai/plugin";\nexport default function plugin() { return { Plugin }; }\n';
        writeFileSync(join(tmp, "plugin", name), source);
      }
      const res = await checkPluginLoad(tmp);
      assert.equal(res.ok, false, `M1 silently passed: ${JSON.stringify(res)}`);
      const failure = res.failures.find((f) => f.file === "plan-gate.ts");
      assert.ok(failure, `expected plan-gate.ts failure, got ${JSON.stringify(res.failures)}`);
      assert.match(failure.reason, /default export is undefined/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("t11-plugin-load-host-value-import-factory: M2 value host imports cannot skip factory validation", async () => {
    const tmp = makeModuleFixture("parity-plugin-host-value-factory-");
    try {
      for (const entry of harnessOcPluginFiles()) {
        const name = entry.split("/").pop();
        const source = name === "plan-gate.ts"
          ? 'import { Plugin } from "@opencode-ai/plugin";\nexport default function plugin() { return Plugin ? 1 : 0; }\n'
          : 'import { Plugin } from "@opencode-ai/plugin";\nexport default function plugin() { return { Plugin }; }\n';
        writeFileSync(join(tmp, "plugin", name), source);
      }
      const res = await checkPluginLoad(tmp);
      assert.equal(res.ok, false, `M2 silently passed: ${JSON.stringify(res)}`);
      const failure = res.failures.find((f) => f.file === "plan-gate.ts");
      assert.ok(failure, `expected plan-gate.ts failure, got ${JSON.stringify(res.failures)}`);
      assert.match(failure.reason, /factory returned number/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("t11-plugin-load-missing: an expected harness plugin absent from the auto-glob is reported", async () => {
    const tmp = makeModuleFixture("parity-plugin-missing-");
    try {
      writeFileSync(join(tmp, "plugin", "entry-gate.ts"), "export default function plugin() { return {}; }\n");
      const res = await checkPluginLoad(tmp);
      assert.equal(res.ok, false);
      assert.deepEqual(res.failures, []);
      assert.ok(res.missing.includes("plan-gate.ts"));
      assert.equal(res.missing.includes("entry-gate.ts"), false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("t11-plugin-load-broken-dynamic-import: a factory whose dynamic import is missing fails — the shape a plain module import cannot see", async () => {
    const tmp = makeModuleFixture("parity-plugin-dyn-");
    try {
      writeFileSync(
        join(tmp, "plugin", "entry-gate.ts"),
        "export default async function plugin() {\n" +
          '  await import("./lib/nao-existe.mjs");\n' +
          "  return {};\n}\n",
      );
      const res = await checkPluginLoad(tmp);
      assert.equal(res.ok, false);
      const failure = res.failures.find((f) => f.file === "entry-gate.ts");
      assert.ok(failure, `expected entry-gate.ts failure, got ${JSON.stringify(res.failures)}`);
      assert.match(failure.reason, /factory call failed/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("t11-plugin-load-host-package: OpenCode host imports use the deterministic stub and still run factories", async () => {
    const tmp = makeModuleFixture("parity-plugin-host-");
    const names = harnessOcPluginFiles().map((entry) => entry.split("/").pop());
    try {
      for (const name of names) {
        writeFileSync(
          join(tmp, "plugin", name),
          'import { Plugin } from "@opencode-ai/plugin";\n' +
            "export default async function plugin() {\n" +
            '  const { tool } = await import("@opencode-ai/plugin/tool");\n' +
            "  return { Plugin, tool };\n}\n",
        );
      }
      const res = await checkPluginLoad(tmp);
      assert.equal(res.ok, true, `failures: ${JSON.stringify(res.failures)}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("t11-plugin-load-host-package-typo: a package that merely shares the @opencode-ai scope is NOT tolerated", async () => {
    const tmp = makeModuleFixture("parity-plugin-typo-");
    try {
      for (const entry of harnessOcPluginFiles()) {
        writeFileSync(
          join(tmp, "plugin", entry.split("/").pop()),
          "export default async function plugin() {\n" +
            '  await import("@opencode-ai/plgin/tool");\n' +
            "  return {};\n}\n",
        );
      }
      const res = await checkPluginLoad(tmp);
      assert.equal(res.ok, false, "a typo'd package name must not pass as host-provided");
      assert.equal(res.failures.length, harnessOcPluginFiles().length);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("t11-plugin-load-non-object-factory: a factory returning a non-object fails", async () => {
    const tmp = makeModuleFixture("parity-plugin-nonobj-");
    try {
      writeFileSync(join(tmp, "plugin", "entry-gate.ts"), "export default function plugin() { return 1; }\n");
      const res = await checkPluginLoad(tmp);
      assert.equal(res.ok, false);
      const failure = res.failures.find((f) => f.file === "entry-gate.ts");
      assert.ok(failure, `expected entry-gate.ts failure, got ${JSON.stringify(res.failures)}`);
      assert.match(failure.reason, /factory returned number/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("t11-plugin-manifest-drift: harnessOcPluginFiles() equals the auto-globbed set on disk, so deleting a plugin is deliberate", () => {
    const declared = harnessOcPluginFiles()
      .map((entry) => entry.split("/").pop())
      .sort();
    const onDisk = readdirSync("core/opencode/plugin")
      .filter((name) => /\.(ts|js)$/.test(name) && !/\.test\.(ts|js)$/.test(name))
      .sort();
    assert.deepEqual(
      declared,
      onDisk,
      "harnessOcPluginFiles() drifted from core/opencode/plugin/: a plugin OpenCode auto-loads is absent from the vendoring manifest (or vice-versa)",
    );
  });

  it("t11-imports-empty-target: a target with no source file fails instead of passing vacuously", () => {
    const missing = checkImportsResolve(join(tmpdir(), "parity-imports-absent-does-not-exist"));
    assert.equal(missing.ok, false);
    assert.equal(missing.scanned, 0);

    const tmp = mkdtempSync(join(tmpdir(), "parity-imports-empty-"));
    try {
      const empty = checkImportsResolve(tmp);
      assert.equal(empty.ok, false);
      assert.equal(empty.scanned, 0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("t11-imports-dynamic: a literal dynamic import to a missing file is caught (tools/classify.ts shape)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "parity-imports-"));
    try {
      mkdirSync(join(tmp, "tools"), { recursive: true });
      mkdirSync(join(tmp, "lib"), { recursive: true });
      writeFileSync(join(tmp, "lib", "obs-emit.mjs"), "export const emit = () => {};\n");
      writeFileSync(
        join(tmp, "tools", "classify.ts"),
        'const ok = await import("../lib/obs-emit.mjs");\n' +
          'const gone = await import("../lib/planner-state.mjs");\n',
      );
      const res = checkImportsResolve(tmp);
      assert.equal(res.ok, false);
      assert.deepEqual(res.unresolved, [
        { file: join("tools", "classify.ts"), specifier: "../lib/planner-state.mjs" },
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("t11-imports-static-comment-trivia: a broken static import with legal comment trivia fails", () => {
    const tmp = mkdtempSync(join(tmpdir(), "parity-imports-static-comment-"));
    try {
      writeFileSync(
        join(tmp, "entry.ts"),
        'import value from /* legal trivia */ "./missing-static.mjs";\nvoid value;\n',
      );
      const res = checkImportsResolve(tmp);
      assert.equal(res.ok, false);
      assert.deepEqual(res.unresolved, [
        { file: "entry.ts", specifier: "./missing-static.mjs" },
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("t11-imports-dynamic-options: a broken literal import with options fails", () => {
    const tmp = mkdtempSync(join(tmpdir(), "parity-imports-dynamic-options-"));
    try {
      writeFileSync(
        join(tmp, "entry.mjs"),
        'await import("./missing-dynamic.json", { with: { type: "json" } });\n',
      );
      const res = checkImportsResolve(tmp);
      assert.equal(res.ok, false);
      assert.deepEqual(res.unresolved, [
        { file: "entry.mjs", specifier: "./missing-dynamic.json" },
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("t11-imports-read-error: an unreadable source fails instead of disappearing from a partial scan", () => {
    const tmp = mkdtempSync(join(tmpdir(), "parity-imports-read-error-"));
    const unreadable = join(tmp, "unreadable.mjs");
    try {
      writeFileSync(join(tmp, "readable.mjs"), "export {};\n");
      writeFileSync(unreadable, 'import "./missing.mjs";\n');
      chmodSync(unreadable, 0o000);
      const res = checkImportsResolve(tmp);
      assert.equal(res.ok, false);
      assert.deepEqual(res.readErrors.map(({ file }) => file), ["unreadable.mjs"]);
    } finally {
      if (existsSync(unreadable)) chmodSync(unreadable, 0o600);
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("t11-imports-real: every relative import under core/opencode resolves on disk", () => {
    const res = checkImportsResolve("core/opencode");
    assert.equal(res.ok, true, `unresolved: ${JSON.stringify(res.unresolved)}`);
    assert.ok(res.scanned > 0, "scanner walked no files");
  });

  it("t11-lib-back-import-mutation: detects static comment-trivia and literal dynamic imports from a lib test into plugin/lib", () => {
    const tmp = mkdtempSync(join(tmpdir(), "parity-lib-back-import-"));
    try {
      mkdirSync(join(tmp, "lib"), { recursive: true });
      mkdirSync(join(tmp, "plugin", "lib"), { recursive: true });
      writeFileSync(
        join(tmp, "lib", "back-import.test.mjs"),
        'import x from /* legal */ "../plugin/lib/static-legacy.mjs";\nawait import("../plugin/lib/legacy.mjs");\n',
      );
      writeFileSync(join(tmp, "plugin", "lib", "legacy.mjs"), "export {};\n");
      writeFileSync(join(tmp, "plugin", "lib", "static-legacy.mjs"), "export default {};\n");
      assert.deepEqual(findLibBackImports(tmp), [
        { file: join("lib", "back-import.test.mjs"), specifier: "../plugin/lib/static-legacy.mjs" },
        { file: join("lib", "back-import.test.mjs"), specifier: "../plugin/lib/legacy.mjs" },
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("t11-closure-10: source and fresh vendored lib tree have no plugin/lib back-imports", () => {
    const closure = [
      "gate-state.mjs",
      "entry-decide.mjs",
      "dispatch-scope.mjs",
      "hand-records.mjs",
      "planner-state.mjs",
      "obs-emit.mjs",
      "plan-hash.mjs",
      "planner-artifact.mjs",
      "roles.mjs",
      "task-dispatch-identity.mjs",
    ];
    const assertClosure = (root) => {
      for (const name of closure) {
        const current = join(root, "lib", name);
        assert.ok(existsSync(current), `closure source must live at lib/${name}`);
      }
      assert.deepEqual(findLibBackImports(root), [], "no source or test under lib/ may import back into plugin/lib");
    };

    assertClosure("core/opencode");
    const tmp = mkdtempSync(join(tmpdir(), "parity-closure-10-vendored-"));
    try {
      const project = join(tmp, "project");
      mkdirSync(project, { recursive: true });
      vendorOpenCode({ coreDir: join(process.cwd(), "core"), targetDir: project, version: "test", stampDate: "2026-07-31" });
      assertClosure(join(project, ".opencode"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("t11-vendored-positive-load: a fresh real vendoring resolves imports and calls every plugin factory", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "parity-vendored-load-"));
    const project = join(tmp, "project");
    const isolatedHome = join(tmp, "home");
    const previousHome = process.env.HOME;
    const previousStdoutWrite = process.stdout.write;
    const previousWarn = console.warn;
    try {
      mkdirSync(project, { recursive: true });
      mkdirSync(isolatedHome, { recursive: true });
      process.env.HOME = isolatedHome;
      process.stdout.write = () => true;
      console.warn = () => {};

      vendorOpenCode({
        coreDir: join(process.cwd(), "core"),
        targetDir: project,
        version: "test",
        stampDate: "2026-07-31",
      });

      const vendored = join(project, ".opencode");
      const imports = checkImportsResolve(vendored);
      assert.equal(imports.ok, true, `unresolved: ${JSON.stringify(imports.unresolved)} read errors: ${JSON.stringify(imports.readErrors)}`);

      const load = await checkPluginLoad(vendored);
      const expected = harnessOcPluginFiles().map((entry) => entry.split("/").pop()).sort();
      assert.equal(load.ok, true, `failures: ${JSON.stringify(load.failures)} missing: ${load.missing.join(", ")}`);
      assert.deepEqual(load.files, expected);
      assert.deepEqual(load.failures, []);
      assert.deepEqual(load.missing, []);
      assert.equal(existsSync(join(isolatedHome, ".config", "opencode")), false);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      process.stdout.write = previousStdoutWrite;
      console.warn = previousWarn;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("t11-smoke: new-clone / project-vendored smoke proves harness works without relying on global ~/.config/opencode (#ac-5.3)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "parity-smoke-"));
    try {
      const home = join(tmp, "home");
      mkdirSync(home, { recursive: true });
      const prevHome = process.env.HOME;
      process.env.HOME = home;
      try {
        const tgt = join(tmp, "proj");
        mkdirSync(join(tgt, ".opencode/agents"), { recursive: true });
        mkdirSync(join(tgt, ".opencode/plugin"), { recursive: true });
        mkdirSync(join(tgt, ".opencode/shared/lib"), { recursive: true });
        for (const a of OC_REQUIRED_AGENTS) {
          writeFileSync(join(tgt, `.opencode/agents/${a}.md`), `# ${a}\n`);
        }
        writeFileSync(join(tgt, ".opencode/plugin/entry-gate.ts"), "export {}\n");
        writeFileSync(join(tgt, ".opencode/plugin/plan-gate.ts"), "export {}\n");
        writeFileSync(join(tgt, ".opencode/shared/lib/capture-oracle.mjs"), "export {}\n");
        writeFileSync(
          join(tgt, ".opencode/harness.routing.json"),
          JSON.stringify(canonicalRouting),
        );
        const gates = checkGatesAndOracle(join(tgt, ".opencode"));
        assert.equal(gates.ok, true);
        const res = runParity([join(tgt, ".opencode")]);
        assert.equal(res.ok, true);
        assert.equal(existsSync(join(home, ".config/opencode")), false);
      } finally {
        process.env.HOME = prevHome;
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("t12-module-manifest: freezes all 44 original modules and explicit runtime additions with the exact normative row schema", () => {
    const manifest = readOcModuleManifest();
    assert.deepEqual(Object.keys(manifest).sort(), ["inventory_provenance", "modules", "path_root", "pending_delete_paths", "rules", "schema_version"]);
    assert.equal(manifest.schema_version, 1);
    assert.equal(manifest.path_root, "core/opencode");
    assert.deepEqual(manifest.inventory_provenance, OC_INVENTORY_PROVENANCE);
    assert.deepEqual(manifest.pending_delete_paths, OC_PENDING_DELETE_PATHS);
    assert.equal(Array.isArray(manifest.modules), true);
    assert.equal(manifest.modules.filter(({ original_path }) => original_path.startsWith("plugin/")).length, OC_INVENTORY_PROVENANCE.frozen_module_count);
    assert.equal(manifest.modules.length, Object.keys(OC_FROZEN_MODULES).length);
    assertExactModuleTriples(manifest.modules);
    assert.equal(new Set(manifest.modules.map(({ original_path }) => original_path)).size, manifest.modules.length, "original paths must be unique");
    assert.equal(new Set(manifest.modules.map(({ current_path }) => current_path)).size, manifest.modules.length, "current paths must be unique");
    for (const row of manifest.modules) {
      assert.deepEqual(Object.keys(row).sort(), OC_MODULE_FIELDS, `wrong fields for ${row.original_path}`);
      for (const field of ["original_path", "current_path", "failure_policy", "reason"]) {
        assert.equal(typeof row[field], "string", `${field} must be a string: ${row.original_path}`);
        assert.notEqual(row[field].trim(), "", `${field} must be non-empty: ${row.original_path}`);
      }
      assert.match(row.original_path, /^(?:lib|plugin)\//);
      assert.match(row.current_path, /^(?:lib|plugin)\//);
      assert.equal(OC_MODULE_VERDICTS.has(row.verdict), true, `unknown verdict ${row.verdict}: ${row.original_path}`);
      for (const field of ["cc_evidence", "consumers", "tests"]) {
        assert.equal(Array.isArray(row[field]), true, `${field} must be an array: ${row.original_path}`);
        assert.ok(row[field].length > 0, `${field} must be non-empty: ${row.original_path}`);
        assert.equal(row[field].every((value) => typeof value === "string" && value.trim()), true, `${field} has an empty/non-string value: ${row.original_path}`);
      }
      assert.equal(Array.isArray(row.rule_ids), true, `rule_ids must be an array: ${row.original_path}`);
      assert.equal(new Set(row.rule_ids).size, row.rule_ids.length, `duplicate rule ID: ${row.original_path}`);
      assert.equal(row.rule_ids.every((id) => OC_RULE_IDS.includes(id)), true, `unknown rule ID: ${row.original_path}`);
    }

    const swappedPaths = structuredClone(manifest.modules);
    [swappedPaths[0].current_path, swappedPaths[1].current_path] = [swappedPaths[1].current_path, swappedPaths[0].current_path];
    assert.throws(() => assertExactModuleTriples(swappedPaths), /triples drifted/);

    const swappedVerdicts = structuredClone(manifest.modules);
    const markGate = swappedVerdicts.find(({ original_path }) => original_path === "plugin/lib/mark-gate.mjs");
    const obsEye = swappedVerdicts.find(({ original_path }) => original_path === "plugin/obs-eye.ts");
    [markGate.verdict, obsEye.verdict] = [obsEye.verdict, markGate.verdict];
    assert.throws(() => assertExactModuleTriples(swappedVerdicts), /triples drifted/);

    const derivedCounts = manifest.modules.reduce((counts, { verdict }) => {
      const family = verdict.startsWith("KEEP") ? "KEEP" : verdict;
      counts[family] = (counts[family] ?? 0) + 1;
      return counts;
    }, {});
    assert.equal(Object.values(derivedCounts).reduce((sum, count) => sum + count, 0), manifest.modules.length);
  });

  it("t12-module-manifest: freezes R1-R15/A1 semantics and links targets bidirectionally", () => {
    const manifest = readOcModuleManifest();
    assert.equal(Array.isArray(manifest.rules), true);
    assert.equal(manifest.rules.length, 16);
    assert.deepEqual(manifest.rules.map(({ id }) => id).sort(), [...OC_RULE_IDS].sort());
    assert.equal(new Set(manifest.rules.map(({ id }) => id)).size, 16);
    for (const rule of manifest.rules) {
      assert.deepEqual(Object.keys(rule).sort(), ["classification", "failure_policy", "id", "implementation_targets", "locked_evidence", "required_outcome"]);
      for (const field of ["classification", "failure_policy", "required_outcome"]) {
        assert.equal(typeof rule[field], "string", `${field} must be a string: ${rule.id}`);
        assert.notEqual(rule[field].trim(), "", `${field} must be non-empty: ${rule.id}`);
      }
      for (const field of ["implementation_targets", "locked_evidence"]) {
        assert.equal(Array.isArray(rule[field]), true, `${field} must be an array: ${rule.id}`);
        assert.equal(rule[field].every((value) => typeof value === "string" && value.trim()), true, `${field} has invalid entries: ${rule.id}`);
      }
      assert.ok(rule.locked_evidence.length > 0, `locked_evidence must be non-empty: ${rule.id}`);
      if (rule.id === "R1" || rule.id === "R2") {
        assert.deepEqual(rule.implementation_targets, []);
        assert.equal(rule.classification, "N/A platform");
      }
    }
    assertRuleSemantics(manifest.rules);
    assertRuleTargetContract(manifest);

    const swappedSemantics = structuredClone(manifest.rules);
    const r4 = swappedSemantics.find(({ id }) => id === "R4");
    const r5 = swappedSemantics.find(({ id }) => id === "R5");
    [r4.required_outcome, r5.required_outcome] = [r5.required_outcome, r4.required_outcome];
    [r4.failure_policy, r5.failure_policy] = [r5.failure_policy, r4.failure_policy];
    assert.throws(() => assertRuleSemantics(swappedSemantics), /semantics drifted/);

    const staleMoveTarget = structuredClone(manifest);
    const r3 = staleMoveTarget.rules.find(({ id }) => id === "R3");
    r3.implementation_targets[r3.implementation_targets.indexOf("lib/gate-state.mjs")] = "plugin/lib/gate-state.mjs";
    assert.throws(() => assertRuleTargetContract(staleMoveTarget), /current module path|does not exist|target mismatch/);
  });

  it("t12-module-manifest: locks real tests and a closed cc_evidence grammar", () => {
    const manifest = readOcModuleManifest();
    const failures = [];
    for (const row of manifest.modules) {
      for (const validate of [assertModuleEvidence, assertModuleTests]) {
        try {
          validate(row);
        } catch (error) {
          failures.push(error.message);
        }
      }
    }
    assert.deepEqual(failures, []);
    assertNormativeModuleMetadata(manifest.modules);

    const ruleMutation = structuredClone(manifest.modules.find(({ rule_ids }) => rule_ids.length > 0));
    ruleMutation.cc_evidence = ["arbitrary prose"];
    assert.throws(() => assertModuleEvidence(ruleMutation), /RULE evidence/);

    const deleteMutation = structuredClone(manifest.modules.find(({ verdict }) => verdict === "DELETE"));
    deleteMutation.cc_evidence = ["No counterpart in prose"];
    assert.throws(() => assertModuleEvidence(deleteMutation), /exact sentinel/);

    const ccOpMutation = structuredClone(manifest.modules.find(({ verdict, rule_ids }) => verdict !== "DELETE" && rule_ids.length === 0));
    ccOpMutation.cc_evidence = ["CC_OP:core/claude-code/hooks/missing-counterpart.mjs"];
    assert.throws(() => assertModuleEvidence(ccOpMutation), /does not exist/);

    const hybridEvidence = structuredClone(manifest.modules.find(({ original_path }) => original_path === "plugin/lib/session-state.mjs"));
    assert.doesNotThrow(() => assertModuleEvidence(hybridEvidence));
    hybridEvidence.cc_evidence = hybridEvidence.cc_evidence.filter((evidence) => !evidence.startsWith("CC_OP:"));
    assert.throws(() => assertModuleEvidence(hybridEvidence), /normative CC_OP evidence/);

    const testMutation = structuredClone(manifest.modules[0]);
    testMutation.tests = ["core/opencode/plugin/missing.test.mjs"];
    assert.throws(() => assertModuleTests(testMutation), /does not exist/);
  });

  it("t12-module-manifest: rejects swapped module failure policies", () => {
    const rows = structuredClone(readOcModuleManifest().modules);
    [rows[0].failure_policy, rows[1].failure_policy] = [rows[1].failure_policy, rows[0].failure_policy];
    assert.throws(() => assertNormativeModuleMetadata(rows), /normative module metadata drifted/);
  });

  it("t12-module-manifest: rejects swapped existing test paths", () => {
    const manifest = readOcModuleManifest();
    const rows = structuredClone(manifest.modules);
    const idle = rows.find(({ original_path }) => original_path === "plugin/agent-idle-nudge.ts");
    const version = rows.find(({ original_path }) => original_path === "plugin/version-check.ts");
    [idle.tests, version.tests] = [version.tests, idle.tests];
    assert.throws(() => assertNormativeModuleMetadata(rows), /normative module metadata drifted/);
  });

  it("t12-module-manifest: rejects swapped existing CC_OP counterparts", () => {
    const manifest = readOcModuleManifest();
    const rows = structuredClone(manifest.modules);
    const idle = rows.find(({ original_path }) => original_path === "plugin/agent-idle-nudge.ts");
    const version = rows.find(({ original_path }) => original_path === "plugin/version-check.ts");
    [idle.cc_evidence, version.cc_evidence] = [version.cc_evidence, idle.cc_evidence];
    assert.throws(() => assertNormativeModuleMetadata(rows), /normative module metadata drifted/);
  });

  it("t12-module-manifest: rejects swapped exact reasons", () => {
    const rows = structuredClone(readOcModuleManifest().modules);
    [rows[0].reason, rows[1].reason] = [rows[1].reason, rows[0].reason];
    assert.throws(() => assertNormativeModuleMetadata(rows), /normative module metadata drifted/);
  });

  it("t12-module-manifest: covers the complete current module inventory and every surviving path exists", () => {
    const manifest = readOcModuleManifest();
    assertCurrentInventoryCovered(manifest.modules);
    for (const row of manifest.modules.filter(({ verdict }) => verdict !== "DELETE")) {
      assert.equal(existsSync(join("core/opencode", row.current_path)), true, `surviving module missing: ${row.current_path}`);
    }

    const tmp = mkdtempSync(join(tmpdir(), "oc-module-inventory-"));
    try {
      mkdirSync(join(tmp, "lib"), { recursive: true });
      mkdirSync(join(tmp, "plugin"), { recursive: true });
      writeFileSync(join(tmp, "plugin", "zombie.js"), "export default {}\n");
      writeFileSync(join(tmp, "plugin", "zombie.mts"), "export default {}\n");
      writeFileSync(join(tmp, "plugin", "zombie.cts"), "export default {}\n");
      writeFileSync(join(tmp, "plugin", "ignored.test.js"), "export default {}\n");
      writeFileSync(join(tmp, "plugin", "ignored.test.cts"), "export default {}\n");
      assert.deepEqual(currentOcModuleInventory(tmp), ["plugin/zombie.cts", "plugin/zombie.js", "plugin/zombie.mts"]);
      const mutatedInventory = [...currentOcModuleInventory(), "plugin/zombie.js", "plugin/zombie.mts", "plugin/zombie.cts"].sort();
      assert.throws(() => assertCurrentInventoryCovered(manifest.modules, mutatedInventory), /inventory differs/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("t12-module-manifest: consumers exactly match global live imports with reserved sentinels only", () => {
    const manifest = readOcModuleManifest();
    const failures = [];
    for (const row of manifest.modules) {
      try {
        assertConsumerContract(row);
      } catch (error) {
        failures.push(error.message);
      }
    }
    assert.deepEqual(failures, []);
  });

  it("t12-module-manifest: derives autoload consumers from the vendor catalog", () => {
    const manifest = readOcModuleManifest();
    const planGate = structuredClone(manifest.modules.find(({ current_path }) => current_path === "plugin/plan-gate.ts"));
    planGate.consumers = ["OPENCODE_PLUGIN_AUTOLOAD", "scripts/probe-oc-gates-headless.mjs"];
    assert.doesNotThrow(() => assertConsumerContract(planGate));

    planGate.consumers = ["scripts/probe-oc-gates-headless.mjs"];
    assert.throws(() => assertConsumerContract(planGate), /autoload/);

    const internalModule = structuredClone(manifest.modules.find(({ current_path }) => current_path === "plugin/lib/agent-idle-nudge.mjs"));
    internalModule.consumers = ["OPENCODE_PLUGIN_AUTOLOAD", ...internalModule.consumers];
    assert.throws(() => assertConsumerContract(internalModule), /autoload/);
  });

  it("t12-module-manifest: enforces the explicit DELETE transition state", () => {
    const manifest = readOcModuleManifest();
    assertPendingDeleteFixture(manifest);
    assertDeleteTransitionContract(manifest);

    const unexpectedPending = structuredClone(manifest);
    unexpectedPending.pending_delete_paths.push("lib/planner-fallback-config.mjs");
    assert.throws(() => assertPendingDeleteFixture(unexpectedPending), /pending DELETE fixture drifted/);
    assert.throws(() => assertDeleteTransitionContract(unexpectedPending), /pending DELETE source is absent/);

    const duplicatePending = structuredClone(manifest);
    duplicatePending.pending_delete_paths.push("plugin/entry-gate.ts", "plugin/entry-gate.ts");
    assert.throws(() => assertDeleteTransitionContract(duplicatePending), /duplicate pending DELETE/);

    const extraPending = structuredClone(manifest);
    extraPending.pending_delete_paths.push("plugin/entry-gate.ts");
    assert.throws(() => assertDeleteTransitionContract(extraPending), /pending path is not a DELETE row/);
  });

  it("t12-module-manifest: accepts the PR4.2 deleted-state contract", () => {
    const tmp = mkdtempSync(join(tmpdir(), "oc-deleted-transition-"));
    try {
      mkdirSync(join(tmp, "core/opencode/plugin/lib"), { recursive: true });
      const deleted = {
        path_root: "core/opencode",
        pending_delete_paths: [],
        modules: [{ current_path: "plugin/lib/doomed.mjs", verdict: "DELETE", consumers: ["NO_LIVE_CONSUMER"] }],
      };
      assert.doesNotThrow(() => assertDeleteTransitionContract(deleted, tmp));
      writeFileSync(join(tmp, "core/opencode/plugin/lib/doomed.mjs"), "export default 1\n");
      assert.throws(() => assertDeleteTransitionContract(deleted, tmp), /present DELETE source is not pending/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("t12-roadmap: active backlog never prescribes rebuilding the deleted harvest guard", () => {
    const roadmap = readFileSync(new URL("../docs/opencode-closure-roadmap.md", import.meta.url), "utf8");
    const activeStart = roadmap.indexOf("## AINDA FAZ SENTIDO — backlog ativo");
    const historyStart = roadmap.indexOf("## Histórico");
    assert.ok(activeStart >= 0 && historyStart > activeStart, "roadmap active/history boundaries must remain explicit");
    const activeBacklog = roadmap.slice(activeStart, historyStart);
    const deletedHarvestPrescription = /(?:\bharvest-(?:guard|findings)\b[\s\S]{0,100}\b(?:tool\s+real|implementar?|implementação|rewrite|reescrev\w*)\b|\b(?:tool\s+real|implementar?|implementação|rewrite|reescrev\w*)\b[\s\S]{0,100}\bharvest-(?:guard|findings)\b)/iu;
    assert.doesNotMatch(activeBacklog, deletedHarvestPrescription);
  });

  it("t12-docs: catalog-health pruning decision is explicitly superseded by PR4.2", () => {
    const pruningPrd = readFileSync(new URL("../docs/prd/oc-parity-pruning.md", import.meta.url), "utf8");
    const catalogMention = pruningPrd.indexOf("plugin/lib/agent-catalog-health.mjs");
    assert.ok(catalogMention >= 0, "historical pruning decision must remain auditable");
    const localDecisionContext = pruningPrd.slice(catalogMention, catalogMention + 500);
    assert.match(localDecisionContext, /decisão superada[^\n]*PR4\.2/iu);
  });

  it("t12-docs: R10 active prose and normative fixtures contain no ceremony sidecar contract", () => {
    for (const relativePath of [
      "../core/opencode/AGENTS.md",
      "../core/opencode/agents/build.md",
      "../core/opencode/skills/orchestrating-delivery/SKILL.md",
    ]) {
      const active = readFileSync(new URL(relativePath, import.meta.url), "utf8");
      assert.doesNotMatch(
        active,
        /brainstormed_binding|adversary_fired_binding|ceremony_generation|ceremony_evidence|unsigned boolean|fingerprints the canonical|binds the runtime-captured/,
        relativePath,
      );
    }
    for (const fixturePath of [
      "../docs/prd/fixtures/gate-state-exemplo-a-adversary-both.json",
      "../docs/prd/fixtures/gate-state-exemplo-b-plan-review-both.json",
    ]) {
      const fixture = JSON.parse(readFileSync(new URL(fixturePath, import.meta.url), "utf8"));
      assert.equal(fixture.brainstormed, true, fixturePath);
      assert.equal(fixture.adversary_fired, true, fixturePath);
      for (const retired of ["brainstormed_binding", "adversary_fired_binding", "ceremony_generation", "ceremony_evidence"]) {
        assert.equal(Object.hasOwn(fixture, retired), false, `${fixturePath}: ${retired}`);
      }
    }
    for (const historyPath of [
      "../docs/OC-CC-PARITY-REPORT.md",
      "../docs/OC-CC-PARITY-ROADMAP-INPUT.md",
      "../docs/opencode-runtime-gaps-2026-07-17-final.md",
    ]) {
      const history = readFileSync(new URL(historyPath, import.meta.url), "utf8");
      assert.match(history.slice(0, 1_500), /PR4\.2[\s\S]*(?:superad|históric)/iu, historyPath);
    }
  });

  it("t12-module-manifest: importer scanner catches global, extensionless and trivia-heavy callers", () => {
    const tmp = mkdtempSync(join(tmpdir(), "oc-delete-importers-"));
    try {
      mkdirSync(join(tmp, "core/opencode/plugin/lib"), { recursive: true });
      mkdirSync(join(tmp, "core/vps"), { recursive: true });
      mkdirSync(join(tmp, "scripts/fixtures"), { recursive: true });
      mkdirSync(join(tmp, "scripts/history"), { recursive: true });
      writeFileSync(join(tmp, "core/opencode/plugin/lib/doomed.mjs"), "export default 1\n");
      writeFileSync(join(tmp, "scripts/static.js"), "import value from /* caller trivia */ '../core/opencode/plugin/lib/doomed.mjs'\nvoid value\n");
      writeFileSync(join(tmp, "core/vps/dynamic.tsx"), "await import(/* caller trivia */ '../opencode/plugin/lib/doomed.mjs', { with: { type: 'json' } })\n");
      writeFileSync(join(tmp, "scripts/static-query.js"), "import '../core/opencode/plugin/lib/doomed.mjs?raw'\n");
      writeFileSync(join(tmp, "scripts/static-fragment.js"), "import '../core/opencode/plugin/lib/doomed.mjs#runtime'\n");
      writeFileSync(join(tmp, "scripts/dynamic-query.js"), "await import('../core/opencode/plugin/lib/doomed.mjs?raw')\n");
      writeFileSync(join(tmp, "scripts/dynamic-fragment.js"), "await import('../core/opencode/plugin/lib/doomed.mjs#runtime')\n");
      writeFileSync(join(tmp, "scripts/reexport.mjs"), "export { default } from '../core/opencode/plugin/lib/doomed.mjs#reexport'\n");
      writeFileSync(join(tmp, "scripts/extensionless.jsx"), "import '../core/opencode/plugin/lib/doomed'\n");
      writeFileSync(join(tmp, "scripts/typed.mts"), "import '../core/opencode/plugin/lib/doomed.mjs'\n");
      writeFileSync(join(tmp, "scripts/typed.cts"), "import '../core/opencode/plugin/lib/doomed.mjs'\n");
      writeFileSync(join(tmp, "scripts/comment.cjs"), "// import '../core/opencode/plugin/lib/doomed.mjs'\n/*\nimport '../core/opencode/plugin/lib/doomed.mjs'\n*/\n");
      writeFileSync(join(tmp, "scripts/ignored.test.js"), "import '../core/opencode/plugin/lib/doomed.mjs'\n");
      writeFileSync(join(tmp, "scripts/fixtures/ignored.js"), "import '../../core/opencode/plugin/lib/doomed.mjs'\n");
      writeFileSync(join(tmp, "scripts/history/ignored.js"), "import '../../core/opencode/plugin/lib/doomed.mjs'\n");
      const expectedConsumers = [
        "core/vps/dynamic.tsx",
        "scripts/dynamic-fragment.js",
        "scripts/dynamic-query.js",
        "scripts/extensionless.jsx",
        "scripts/reexport.mjs",
        "scripts/static-fragment.js",
        "scripts/static-query.js",
        "scripts/static.js",
        "scripts/typed.cts",
        "scripts/typed.mts",
      ];
      assert.deepEqual(liveImportersOf("plugin/lib/doomed.mjs", tmp), expectedConsumers);
      assertConsumerContract({ current_path: "plugin/lib/doomed.mjs", verdict: "DELETE", consumers: expectedConsumers }, tmp);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("t12-module-manifest: allows only the three exact audited live loader expressions", () => {
    const tmp = mkdtempSync(join(tmpdir(), "oc-loader-allowlist-"));
    try {
      mkdirSync(join(tmp, "core/opencode/plugin/lib"), { recursive: true });
      mkdirSync(join(tmp, "core/vps"), { recursive: true });
      mkdirSync(join(tmp, "scripts"), { recursive: true });
      writeFileSync(join(tmp, "core/opencode/plugin/lib/doomed.mjs"), "export default 1\n");
      writeFileSync(
        join(tmp, "scripts/parity-manifest.mjs"),
        "await import(pathToFileURL(join(pluginDir, name)).href)\n",
      );
      writeFileSync(
        join(tmp, "core/vps/run-cron-review.mjs"),
        "await import(join(root, \".claude/modules/codex-adversary/references/codex-adversary.mjs\"))\n"
          + "await import(join(root, \".claude/modules/codex-adversary/references/merge-findings.mjs\"))\n",
      );
      assert.deepEqual(liveImportersOf("plugin/lib/doomed.mjs", tmp), []);

      writeFileSync(
        join(tmp, "core/vps/run-cron-review.mjs"),
        "await import(join(root, \".claude/modules/codex-adversary/references/codex- adversary.mjs\"))\n"
          + "await import(join(root, \".claude/modules/codex-adversary/references/merge-findings.mjs\"))\n",
      );
      assert.throws(() => liveImportersOf("plugin/lib/doomed.mjs", tmp), /opaque module loader is not allowlisted/);
      writeFileSync(
        join(tmp, "core/vps/run-cron-review.mjs"),
        "await import(join(root, \".claude/modules/codex-adversary/references/codex-adversary.mjs\"))\n"
          + "await import(join(root, \".claude/modules/codex-adversary/references/merge-findings.mjs\"))\n",
      );

      writeFileSync(
        join(tmp, "scripts/parity-manifest.mjs"),
        "await import(pathToFileURL(join(pluginDir, name + '.mjs')).href)\n",
      );
      assert.throws(() => liveImportersOf("plugin/lib/doomed.mjs", tmp), /opaque module loader is not allowlisted/);

      writeFileSync(join(tmp, "scripts/parity-manifest.mjs"), "export default 1\n");
      writeFileSync(
        join(tmp, "scripts/parity-manifest-copy.mjs"),
        "await import(pathToFileURL(join(pluginDir, name)).href)\n",
      );
      assert.throws(() => liveImportersOf("plugin/lib/doomed.mjs", tmp), /opaque module loader is not allowlisted/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("t12-module-manifest: rejects encoded or escaped relative literal specifiers", () => {
    const tmp = mkdtempSync(join(tmpdir(), "oc-encoded-specifiers-"));
    try {
      mkdirSync(join(tmp, "core/opencode/plugin/lib"), { recursive: true });
      mkdirSync(join(tmp, "scripts"), { recursive: true });
      writeFileSync(join(tmp, "core/opencode/plugin/lib/doomed.mjs"), "export default 1\n");
      writeFileSync(join(tmp, "scripts/encoded.mjs"), "import '../core/opencode/plugin/lib/doomed%2Emjs'\n");
      assert.throws(() => liveImportersOf("plugin/lib/doomed.mjs", tmp), /unsupported encoded relative import/);
      writeFileSync(join(tmp, "scripts/encoded.mjs"), "await import('\\u002e\\u002e/core/opencode/plugin/lib/doomed.mjs')\n");
      assert.throws(() => liveImportersOf("plugin/lib/doomed.mjs", tmp), /unsupported encoded relative import/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("t12-module-manifest: audits nested calls and template interpolations structurally", () => {
    const tmp = mkdtempSync(join(tmpdir(), "oc-structural-loaders-"));
    try {
      mkdirSync(join(tmp, "core/opencode/plugin/lib"), { recursive: true });
      mkdirSync(join(tmp, "scripts"), { recursive: true });
      writeFileSync(join(tmp, "core/opencode/plugin/lib/doomed.mjs"), "export default 1\n");
      writeFileSync(
        join(tmp, "scripts/nested.mjs"),
        "const target = '../core/opencode/plugin/lib/doomed.mjs'\n"
          + "await import('node:fs', { with: await import(target) })\n",
      );
      assert.throws(() => liveImportersOf("plugin/lib/doomed.mjs", tmp), /opaque module loader is not allowlisted/);

      writeFileSync(join(tmp, "scripts/nested.mjs"), "export default 1\n");
      writeFileSync(
        join(tmp, "scripts/template.mjs"),
        "const target = '../core/opencode/plugin/lib/doomed.mjs'\n"
          + "const rendered = `\n/* ${await import(target)} */\n`\n",
      );
      assert.throws(() => liveImportersOf("plugin/lib/doomed.mjs", tmp), /opaque module loader is not allowlisted/);

      writeFileSync(
        join(tmp, "scripts/template.mjs"),
        "const target = '../core/opencode/plugin/lib/doomed.mjs'\n"
          + "const rendered = `${await import(target)}`\n",
      );
      assert.throws(() => liveImportersOf("plugin/lib/doomed.mjs", tmp), /opaque module loader is not allowlisted/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("t12-module-manifest: ignores loader text outside executable code", () => {
    const tmp = mkdtempSync(join(tmpdir(), "oc-inert-loader-text-"));
    try {
      mkdirSync(join(tmp, "core/opencode/plugin/lib"), { recursive: true });
      mkdirSync(join(tmp, "scripts"), { recursive: true });
      writeFileSync(join(tmp, "core/opencode/plugin/lib/doomed.mjs"), "export default 1\n");
      writeFileSync(
        join(tmp, "scripts/inert.mjs"),
        "// import(target)\n"
          + "/* require('../core/opencode/plugin/lib/doomed.mjs') */\n"
          + "const quoted = \"import('../core/opencode/plugin/lib/doomed.mjs')\"\n"
          + "const raw = `import('../core/opencode/plugin/lib/doomed.mjs')`\n"
          + "const pattern = /import(target)/\n"
          + "if (true) /import(target)/.test('inert')\n",
      );
      assert.deepEqual(liveImportersOf("plugin/lib/doomed.mjs", tmp), []);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("t12-module-manifest: distinguishes division after postfix updates from regex literals", () => {
    const tmp = mkdtempSync(join(tmpdir(), "oc-division-loaders-"));
    try {
      mkdirSync(join(tmp, "core/opencode/plugin/lib"), { recursive: true });
      mkdirSync(join(tmp, "scripts"), { recursive: true });
      writeFileSync(join(tmp, "core/opencode/plugin/lib/doomed.mjs"), "export default 1\n");
      writeFileSync(
        join(tmp, "scripts/division.mjs"),
        "const target = '../core/opencode/plugin/lib/doomed.mjs'\nlet n = 1\nn++ / import(target) / 2\n",
      );
      assert.throws(() => liveImportersOf("plugin/lib/doomed.mjs", tmp), /opaque module loader is not allowlisted/);
      writeFileSync(
        join(tmp, "scripts/division.mjs"),
        "const target = '../core/opencode/plugin/lib/doomed.mjs'\nlet n = 1\nn-- / import(target) / 2\n",
      );
      assert.throws(() => liveImportersOf("plugin/lib/doomed.mjs", tmp), /opaque module loader is not allowlisted/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("t12-module-manifest: importer scanner rejects require and opaque references for every verdict", () => {
    const tmp = mkdtempSync(join(tmpdir(), "oc-opaque-importers-"));
    try {
      mkdirSync(join(tmp, "core/opencode/plugin/lib"), { recursive: true });
      mkdirSync(join(tmp, "scripts"), { recursive: true });
      writeFileSync(join(tmp, "core/opencode/plugin/lib/doomed.mjs"), "export default 1\n");
      writeFileSync(join(tmp, "scripts/opaque.cjs"), "require('../core/opencode/plugin/lib/doomed.mjs')\n");
      assert.throws(() => liveImportersOf("plugin/lib/doomed.mjs", tmp), /opaque module loader is not allowlisted/);
      for (const verdict of ["KEEP", "REWRITE"]) {
        const survivingRow = { current_path: "plugin/lib/doomed.mjs", verdict, consumers: ["NO_LIVE_CONSUMER"] };
        assert.throws(() => assertConsumerContract(survivingRow, tmp), /opaque module loader is not allowlisted/);
      }
      writeFileSync(
        join(tmp, "scripts/opaque.cjs"),
        "const target =\n  '../core/opencode/plugin/lib/doomed.mjs'\nawait import(target)\n",
      );
      assert.throws(() => liveImportersOf("plugin/lib/doomed.mjs", tmp), /opaque module loader is not allowlisted/);
      writeFileSync(
        join(tmp, "scripts/opaque.cjs"),
        "let target = '../core/opencode/plugin/lib/safe.mjs'\ntarget = '../core/opencode/plugin/lib/doomed.mjs'\nawait import(target)\n",
      );
      assert.throws(() => liveImportersOf("plugin/lib/doomed.mjs", tmp), /opaque module loader is not allowlisted/);
      writeFileSync(
        join(tmp, "scripts/opaque.cjs"),
        "const directory = '../core/opencode/plugin/lib/'\nconst file = 'doomed.mjs'\nawait import(directory + file)\n",
      );
      assert.throws(() => liveImportersOf("plugin/lib/doomed.mjs", tmp), /opaque module loader is not allowlisted/);
      writeFileSync(
        join(tmp, "scripts/opaque.cjs"),
        "const stem = 'doomed'\nawait import('../core/opencode/plugin/lib/' + stem + '.mjs')\n",
      );
      assert.throws(() => liveImportersOf("plugin/lib/doomed.mjs", tmp), /opaque module loader is not allowlisted/);
      assert.throws(
        () => assertConsumerContract({ current_path: "plugin/lib/doomed.mjs", verdict: "REWRITE", consumers: ["NO_LIVE_CONSUMER"] }, tmp),
        /opaque module loader is not allowlisted/,
      );
      writeFileSync(
        join(tmp, "scripts/opaque.cjs"),
        "const req = createRequire(import.meta.url)\nreq('../core/opencode/plugin/lib/doomed.mjs')\n",
      );
      assert.throws(() => liveImportersOf("plugin/lib/doomed.mjs", tmp), /opaque module loader is not allowlisted/);
      assert.throws(
        () => assertConsumerContract({ current_path: "plugin/lib/doomed.mjs", verdict: "KEEP", consumers: ["NO_LIVE_CONSUMER"] }, tmp),
        /opaque module loader is not allowlisted/,
      );
      writeFileSync(
        join(tmp, "scripts/opaque.cjs"),
        "const target = '../core/opencode/plugin/lib/doomed.mjs'\nconst load = require\nload(target)\n",
      );
      assert.throws(() => liveImportersOf("plugin/lib/doomed.mjs", tmp), /opaque module loader is not allowlisted/);
      writeFileSync(
        join(tmp, "scripts/opaque.cjs"),
        "const target = '../core/opencode/plugin/lib/doomed.mjs'\nrequ\\u0069re(target)\n",
      );
      assert.throws(() => liveImportersOf("plugin/lib/doomed.mjs", tmp), /identifier escape is not auditable/);
      writeFileSync(join(tmp, "scripts/opaque.cjs"), "const doomed = '../core/opencode/plugin/lib/doomed.mjs'\nawait import(doomed)\n");
      assert.throws(() => liveImportersOf("plugin/lib/doomed.mjs", tmp), /opaque module loader is not allowlisted/);
      writeFileSync(join(tmp, "scripts/opaque.cjs"), "await import('../core/opencode/plugin/lib/' + 'doom' + 'ed.mjs')\n");
      assert.throws(() => liveImportersOf("plugin/lib/doomed.mjs", tmp), /opaque module loader is not allowlisted/);

      for (const verdict of ["KEEP", "REWRITE"]) {
        const survivingRow = { current_path: "plugin/lib/doomed.mjs", verdict, consumers: ["NO_LIVE_CONSUMER"] };
        assert.throws(() => assertConsumerContract(survivingRow, tmp), /opaque module loader is not allowlisted/);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
