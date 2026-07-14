/** @description Regression tests for canonical review agents, aliases, and dispatch names. */
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

test("canonical review catalog declares explicit family policy", () => {
  assert.deepEqual(REVIEW_AGENT_CATALOG, {
    "plan-reviewer-family-1": {
      logicalRole: "plan-reviewer", family: 1, primary: true, optional: false, countsLoop: true,
    },
    "plan-reviewer-family-2": {
      logicalRole: "plan-reviewer", family: 2, primary: false, optional: true, countsLoop: false,
    },
    "adversary-family-1": {
      logicalRole: "adversary", family: 1, primary: true, optional: false, countsLoop: true,
    },
    "adversary-family-2": {
      logicalRole: "adversary", family: 2, primary: false, optional: true, countsLoop: false,
    },
  });
  for (const name of Object.keys(REVIEW_AGENT_CATALOG)) {
    assert.equal(existsSync(join(AGENTS_DIR, `${name}.md`)), true, `${name}.md`);
  }
});

test("legacy names remain loadable aliases to canonical roles for two releases", () => {
  assert.equal(REVIEW_ALIAS_COMPATIBILITY_RELEASES, 2);
  assert.deepEqual(REVIEW_ALIAS_COMPATIBILITY, {
    introducedIn: "0.44.0",
    availableReleaseLines: ["0.44.x", "0.45.x"],
    removeIn: "0.46.0",
  });
  assert.equal(REVIEW_ALIAS_COMPATIBILITY.availableReleaseLines.length, 2);
  assert.ok(REVIEW_ALIAS_COMPATIBILITY.availableReleaseLines.includes("0.44.x"));
  assert.ok(REVIEW_ALIAS_COMPATIBILITY.availableReleaseLines.includes("0.45.x"));
  assert.deepEqual(REVIEW_AGENT_ALIASES, {
    "plan-reviewer": "plan-reviewer-family-1",
    "plan-reviewer-openai": "plan-reviewer-family-2",
    adversary: "adversary-family-1",
    "adversary-openai": "adversary-family-2",
  });
  for (const [alias, canonical] of Object.entries(REVIEW_AGENT_ALIASES)) {
    const aliasPath = join(AGENTS_DIR, `${alias}.md`);
    const canonicalPath = join(AGENTS_DIR, `${canonical}.md`);
    assert.equal(existsSync(aliasPath), true, `${alias}.md`);
    assert.equal(
      agentContract(readFileSync(aliasPath, "utf8")),
      agentContract(readFileSync(canonicalPath, "utf8")),
      `${alias} must carry the complete canonical prompt; frontmatter model/description may differ`,
    );
    assert.equal(resolveReviewAgentName(alias), canonical);
    assert.equal(resolveReviewAgentName(canonical), canonical);
    assert.equal(reviewAgentIdentity(alias)?.canonicalName, canonical);
  }
  assert.equal(normalizeReviewAgentName("@harness/PLAN-REVIEWER-OPENAI.md"), "plan-reviewer-openai");
  assert.equal(
    reviewAgentIdentity("plugin:adversary-openai")?.canonicalName,
    "adversary-family-2",
  );
});

test("internal review dispatch emits canonical names without provider identity", () => {
  assert.deepEqual(reviewDispatchFor("plan-reviewer"), {
    primary: "plan-reviewer-family-1",
    secondary: "plan-reviewer-family-2",
  });
  assert.deepEqual(reviewDispatchFor("adversary"), {
    primary: "adversary-family-1",
    secondary: "adversary-family-2",
  });
  for (const role of ["plan-reviewer", "adversary"]) {
    const dispatch = reviewDispatchFor(role);
    assert.doesNotMatch(`${dispatch.primary} ${dispatch.secondary}`, /openai|anthropic|xai|ollama/i);
  }

  const dispatchDocs = [
    join(AGENTS_DIR, "build.md"),
    join(AGENTS_DIR, "planner.md"),
    join(OC_ROOT, "skills", "orchestrating-delivery", "SKILL.md"),
  ].map((path) => readFileSync(path, "utf8")).join("\n");
  assert.doesNotMatch(dispatchDocs, /dispatch `(?:plan-reviewer|adversary)(?:-openai)?`/i);
  assert.doesNotMatch(dispatchDocs, /"(?:plan_reviewer|adversary)": "(?:plan-reviewer|adversary)"/i);
});
