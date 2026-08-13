/** @description Regression tests for single-evaluator review agents, inverted aliases, and dispatch. */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  REVIEW_AGENT_ALIASES,
  REVIEW_AGENT_CATALOG,
  REVIEW_ALIAS_COMPATIBILITY,
  REVIEW_ALIAS_COMPATIBILITY_RELEASES,
  normalizeReviewAgentName,
  reviewAgentIdentity,
  resolveReviewAgentName,
  reviewDispatchFor,
} from "./review-catalog.mjs";

const AGENTS_DIR = dirname(fileURLToPath(import.meta.url));
const OC_ROOT = join(AGENTS_DIR, "..");

function agentContract(markdown) {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
}

test("canonical review catalog is single-evaluator", () => {
  assert.deepEqual(REVIEW_AGENT_CATALOG, {
    "plan-reviewer": {
      logicalRole: "plan-reviewer", family: 1, primary: true, optional: false, countsLoop: true,
    },
    adversary: {
      logicalRole: "adversary", family: 1, primary: true, optional: false, countsLoop: true,
    },
  });
  for (const name of Object.keys(REVIEW_AGENT_CATALOG)) {
    assert.equal(existsSync(join(AGENTS_DIR, `${name}.md`)), true, `${name}.md`);
  }
  // Compatibility alias files stay loadable for older vendored configurations.
  for (const alias of Object.keys(REVIEW_AGENT_ALIASES)) {
    assert.equal(existsSync(join(AGENTS_DIR, `${alias}.md`)), true, `${alias}.md alias stub`);
  }
});

test("legacy dual-family names invert to the single evaluator for two releases", () => {
  assert.equal(REVIEW_ALIAS_COMPATIBILITY_RELEASES, 2);
  assert.deepEqual(REVIEW_ALIAS_COMPATIBILITY, {
    introducedIn: "0.52.0",
    availableReleaseLines: ["0.52.x", "0.53.x"],
    removeIn: "0.54.0",
  });
  assert.deepEqual(REVIEW_AGENT_ALIASES, {
    "plan-reviewer-family-1": "plan-reviewer",
    "plan-reviewer-family-2": "plan-reviewer",
    "plan-reviewer-openai": "plan-reviewer",
    "adversary-family-1": "adversary",
    "adversary-family-2": "adversary",
    "adversary-openai": "adversary",
  });
  for (const [alias, canonical] of Object.entries(REVIEW_AGENT_ALIASES)) {
    assert.equal(resolveReviewAgentName(alias), canonical);
    assert.equal(resolveReviewAgentName(canonical), canonical);
    assert.equal(reviewAgentIdentity(alias)?.canonicalName, canonical);
  }
  assert.equal(reviewAgentIdentity("adversary-family-1")?.family, 1);
  assert.equal(reviewAgentIdentity("adversary-family-1")?.countsLoop, true);
  assert.equal(reviewAgentIdentity("adversary-family-2")?.family, 2);
  assert.equal(reviewAgentIdentity("adversary-family-2")?.countsLoop, false);
  assert.equal(reviewAgentIdentity("plan-reviewer-openai")?.family, 2);
  assert.equal(normalizeReviewAgentName("@harness/PLAN-REVIEWER-OPENAI.md"), "plan-reviewer-openai");
  assert.equal(
    reviewAgentIdentity("plugin:adversary-openai")?.canonicalName,
    "adversary",
  );
});

test("internal review dispatch emits single primary; secondary only with secondEyeModel", () => {
  assert.deepEqual(reviewDispatchFor("plan-reviewer"), {
    primary: "plan-reviewer",
    secondary: null,
  });
  assert.deepEqual(reviewDispatchFor("adversary"), {
    primary: "adversary",
    secondary: null,
  });
  assert.deepEqual(
    reviewDispatchFor("adversary", {
      roles: { adversary: { model: "openai/gpt-5.6-sol", secondEyeModel: "xai/grok-4.5" } },
    }),
    { primary: "adversary", secondary: "adversary-family-2" },
  );
  // Legacy v2 families shape (vendored projects) must not lose the second eye silently.
  assert.deepEqual(
    reviewDispatchFor("adversary", {
      roles: {
        adversary: {
          families: {
            "family-1": { model: "openai/gpt-5.6-sol", primary: true, optional: false, countsLoop: true },
            "family-2": { model: "xai/grok-4.5", primary: false, optional: true, countsLoop: false },
          },
        },
      },
    }),
    { primary: "adversary", secondary: "adversary-family-2" },
  );
  for (const role of ["plan-reviewer", "adversary"]) {
    const dispatch = reviewDispatchFor(role);
    assert.doesNotMatch(`${dispatch.primary}`, /openai|anthropic|xai|ollama/i);
  }

  const dispatchDocs = [
    join(AGENTS_DIR, "build.md"),
    join(AGENTS_DIR, "planner.md"),
    join(OC_ROOT, "skills", "orchestrating-delivery", "SKILL.md"),
  ].map((path) => readFileSync(path, "utf8")).join("\n");
  // Canonical single-evaluator names are the dispatch target; legacy dual "always dispatch family-2" is gone.
  assert.match(dispatchDocs, /`adversary`/);
  assert.match(dispatchDocs, /`plan-reviewer`/);
  assert.doesNotMatch(dispatchDocs, /Always dual|requireDualOn/i);
});

test("adversary prompts preserve the executable report schema without verdict fields", () => {
  const body = agentContract(readFileSync(join(AGENTS_DIR, "adversary.md"), "utf8"));
  assert.match(body, /JSON contract is exact/);
  assert.match(body, /Never add `verdict`/);
  assert.doesNotMatch(body, /"suggested_sniper_tier"\s*:/);
  assert.doesNotMatch(body, /emit `BLOCKED`/);
});

test("spec re-attacks verify prior findings and direct consequences instead of widening the architecture", () => {
  const body = agentContract(readFileSync(join(AGENTS_DIR, "adversary.md"), "utf8"));
  assert.match(body, /spec re-attack[\s\S]{0,300}prior material findings[\s\S]{0,300}direct consequences/i);
  assert.match(body, /rare hypothesis[\s\S]{0,180}open risk/i);
});

test("plan re-reviews verify the repair instead of serializing new edge-case hunts", () => {
  const reviewer = agentContract(readFileSync(join(AGENTS_DIR, "plan-reviewer.md"), "utf8"));
  const delivery = readFileSync(join(OC_ROOT, "skills", "orchestrating-delivery", "SKILL.md"), "utf8");

  assert.match(delivery, /On REVISE,[\s\S]{0,220}exact findings[\s\S]{0,220}review it again/i);
  assert.match(delivery, /revision review[\s\S]{0,220}prior findings[\s\S]{0,220}direct consequences/i);
  assert.match(reviewer, /revision review[\s\S]{0,450}prior finding[\s\S]{0,450}direct consequences/i);
  assert.match(reviewer, /altered[\s\S]{0,180}(added|removed|changed)[\s\S]{0,220}direct consequences/i);
  assert.match(reviewer, /Do \*\*not\*\*[\s\S]{0,120}new[\s\S]{0,120}(hypothetical|edge-case|boundary)/i);
  assert.match(reviewer, /APPROVE[\s\S]{0,250}prior finding/i);
  assert.match(reviewer, /INITIAL only[\s\S]{0,200}two mandatory, separate passes/i);
  assert.match(reviewer, /REVISION[\s\S]{0,250}do not run these categories as a fresh audit/i);
  assert.doesNotMatch(delivery, /approval receipt|plan_review_verdict|bound plan/i);
});
