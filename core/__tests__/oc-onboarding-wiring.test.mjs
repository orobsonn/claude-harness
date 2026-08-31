/**
 * @description Guards the runtime-aware onboarding wiring so the OpenCode (OC) self-maintenance
 * contract cannot silently regress. F1 from the implementation review: the npm-published CLI lags
 * and may predate OpenCode support, so `@latest` would vendor a stale Claude-only harness. The
 * skills must drive the CLI from the pinned git release tag instead. These are grep-lints — the one
 * layer of the "documented command → CLI" contract that is testable without reaching the network.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const projectRoot = join(__dirname, "..");

const ccUpdating = readFileSync(join(projectRoot, "skills/updating-harness/SKILL.md"), "utf8");
const ccInit = readFileSync(join(projectRoot, "skills/initializing-projects/SKILL.md"), "utf8");
const ocUpdatingPath = join(projectRoot, "opencode/skills/updating-harness/SKILL.md");
const ocLifecycleTool = readFileSync(join(projectRoot, "opencode/tools/lifecycle-update-core.mjs"), "utf8");
const ocLifecycleToolRuntime = readFileSync(join(projectRoot, "opencode/tools/lifecycle-update.ts"), "utf8");
const ocTriage = readFileSync(join(projectRoot, "opencode/skills/triaging-requests/SKILL.md"), "utf8");
const ocBuild = readFileSync(join(projectRoot, "opencode/agents/build.md"), "utf8");
const ocAgents = readFileSync(join(projectRoot, "opencode/AGENTS.md"), "utf8");

test("CC updating-harness detects the OpenCode shell and threads --runtime", () => {
  assert.match(ccUpdating, /\.opencode\/\.harness-version/, "must detect install-vs-update on the OC shell marker");
  assert.match(ccUpdating, /--runtime/, "must thread the resolved --runtime into the engine invocation");
});

test("CC updating-harness OC-only fallback runs the CLI from the pinned git tag, not npm @latest", () => {
  assert.match(
    ccUpdating,
    /github:orobsonn\/claude-harness#/,
    "OC-only fallback must use the github:…#<tag> spec (npm lags and may predate OpenCode)",
  );
});

test("CC initializing-projects is runtime-aware (--runtime + .opencode destination)", () => {
  assert.match(ccInit, /--runtime/, "must document the --runtime flag");
  assert.match(ccInit, /\.opencode/, "must document the OpenCode destination");
});

test("OC updating-harness skill exists and its native tool pins the lifecycle CLI to a git release", () => {
  assert.ok(existsSync(ocUpdatingPath), "the OpenCode-side updating-harness skill must exist (finding 6)");
  const ocUpdating = readFileSync(ocUpdatingPath, "utf8");
  assert.match(ocUpdating, /^name: oc-updating-harness$/m, "must have the loader frontmatter name");
  assert.match(ocUpdating, /compatibility: opencode/, "must declare OpenCode compatibility");
  assert.match(
    ocLifecycleTool,
    /github:orobsonn\/claude-harness#/,
    "native tool must run the CLI from the github:…#<tag> spec, not npm @latest",
  );
  assert.match(ocUpdating, /lifecycle-update\(\{\}\)/, "skill must use the native lifecycle tool");
  assert.match(ocLifecycleToolRuntime, /\.opencode.*\.harness-version/, "tool must detect via the OC shell marker");
});

test("OC harness updates run inside build without delivery ceremony", () => {
  const updating = readFileSync(ocUpdatingPath, "utf8");
  assert.match(ocTriage, /Harness lifecycle operations run in this same root `build` conversation/i);
  assert.match(ocTriage, /oc-updating-harness/, "triage must route to the lifecycle skill");
  assert.match(updating, /Do not call `classify`[\s\S]*Do not call|Do not call `classify`[\s\S]*dispatch any subagent/i);
  assert.match(ocLifecycleTool, /hasOpenCode[\s\S]*hasClaude/, "tool must derive an OpenCode-only or dual-runtime target");
  assert.match(ocBuild, /load their matching skill without classify, plan, or Task dispatch/i);
  assert.match(ocAgents, /Lifecycle shortcuts in build[\s\S]*do not call `classify`/i);
});
