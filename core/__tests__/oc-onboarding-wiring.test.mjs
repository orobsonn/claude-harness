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

test("OC updating-harness skill exists, is loader-shaped, and runs the CLI from the pinned git tag", () => {
  assert.ok(existsSync(ocUpdatingPath), "the OpenCode-side updating-harness skill must exist (finding 6)");
  const ocUpdating = readFileSync(ocUpdatingPath, "utf8");
  assert.match(ocUpdating, /^name: oc-updating-harness$/m, "must have the loader frontmatter name");
  assert.match(ocUpdating, /compatibility: opencode/, "must declare OpenCode compatibility");
  assert.match(
    ocUpdating,
    /github:orobsonn\/claude-harness#/,
    "must run the CLI from the github:…#<tag> spec, not npm @latest",
  );
  assert.match(ocUpdating, /\.opencode\/\.harness-version/, "must detect via the OC shell marker");
});

test("OC harness updates use a direct lifecycle lane without delivery ceremony", () => {
  const updating = readFileSync(ocUpdatingPath, "utf8");
  assert.match(ocTriage, /Harness lifecycle operations do \*\*not\*\* run here[\s\S]*`harness-config`/i);
  assert.match(ocTriage, /\/updating-harness/, "triage must route to the command, not run the skill");
  assert.match(updating, /Do not call `classify`[\s\S]*Do not call|Do not call `classify`[\s\S]*dispatch any subagent/i);
  assert.match(
    updating,
    /Only `\.opencode\/\.harness-version` exists:[\s\S]*`opencode`[\s\S]*absent Claude shell is optional/i,
    "an OpenCode-only project must update without depending on a Claude shell",
  );
  assert.match(
    updating,
    /Both `\.claude\/\.harness-version` and `\.opencode\/\.harness-version` exist:[\s\S]*`both`/i,
    "a dual-runtime project must synchronize both installed shells",
  );
  assert.match(ocBuild, /lifecycle operations are the exception[\s\S]*never classifies/i);
  assert.match(ocAgents, /Harness lifecycle lane[\s\S]*does not call `classify`/i);
});
