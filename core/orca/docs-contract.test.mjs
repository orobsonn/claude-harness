/**
 * @description Docs oracle for the Orca-dispatch design. It REPLACES
 * `core/vps/docs-review-phase.test.mjs`, which pinned the retired VPS engine's review-cron contract
 * (`HARNESS_REVIEW_ENABLED`, the every-6-hours review cadence, the `autoMergeEnabled` rollout lock) into
 * `docs/usage.md` — knobs that no longer describe how anything runs. Deleting that oracle without
 * replacing it would have left the current contract unpinned, so the merge criteria and the
 * entry-gate consequence are asserted here instead.
 *
 * What must stay true in the docs: Orca is named as the official ADE with a download link; the
 * design is described as two LAYERS (Orca dispatches, the repo's vendored `.claude/` executes); the
 * PR-review automation's merge criteria are stated; and the `entry-gate` consequence (no `-R` on the
 * merge command) is written down, because it is the one constraint an operator would otherwise
 * discover only by having a merge denied.
 */
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const DOCS = {
  readme: new URL("../../README.md", import.meta.url),
  usage: new URL("../../docs/usage.md", import.meta.url),
  playbook: new URL("../../docs/orca-headless-vps-playbook.md", import.meta.url),
  fromZero: new URL("../../docs/playbook-vps-agente-ia-do-zero.md", import.meta.url),
  selector: new URL("./README.md", import.meta.url),
  deprecated: new URL("../vps/DEPRECATED.md", import.meta.url),
};

/** @param {URL} fileUrl @returns {string} */
function readDoc(fileUrl) {
  try {
    return readFileSync(fileUrl, "utf-8");
  } catch (error) {
    throw new Error(`expected doc to exist at ${fileUrl}: ${error.message}`);
  }
}

test("Orca is named the official ADE, with a download link, in the README and in EVERY playbook", () => {
  for (const key of ["readme", "playbook", "fromZero"]) {
    const doc = readDoc(DOCS[key]);
    assert.match(doc, /ADE oficial/i, `${key} must name Orca as the official ADE`);
    assert.match(doc, /https:\/\/onorca\.dev/, `${key} must carry the Orca download link`);
    assert.match(
      doc,
      /https:\/\/github\.com\/stablyai\/orca\/releases/,
      `${key} must carry the Orca releases link`,
    );
  }
  assert.match(readDoc(DOCS.usage), /https:\/\/onorca\.dev/, "usage.md must carry the Orca download link");
});

test("the docs describe TWO LAYERS (Orca dispatches, the repo's vendored .claude/ executes), not two engines", () => {
  const combined = [DOCS.readme, DOCS.usage, DOCS.playbook].map(readDoc).join("\n");
  assert.match(combined, /duas camadas, n[ãa]o dois motores/i);
  assert.match(combined, /vendorad[oa]/i);
  assert.match(combined, /core\/orca\/select-and-dispatch\.mjs/);
});

test("the PR-review automation's merge criteria are documented, including the mandatory --match-head-commit", () => {
  const combined = [DOCS.usage, DOCS.playbook, DOCS.selector].map(readDoc).join("\n");
  assert.match(combined, /--match-head-commit/, "the merge must be pinned to a head sha");
  assert.match(combined, /ARMADO de severidade alta/i, "no armed high-severity finding may merge");
  assert.match(combined, /SUCCESS/, "CI must have concluded SUCCESS");
  assert.match(combined, /conflito/i, "a conflicting PR must not merge");
});

test("the entry-gate consequence is written down: the merge command cannot pass -R/--repo", () => {
  const combined = [DOCS.usage, DOCS.playbook, DOCS.selector].map(readDoc).join("\n");
  assert.match(combined, /entry-gate/);
  assert.match(combined, /-R\/--repo|--repo.*-R/);
  assert.match(combined, /amb[íi]gu/i, "the gate denies an ambiguous merge target");
});

test("core/vps is documented as retired, and its removal is gated on a verification runbook rather than a blind delete", () => {
  const deprecated = readDoc(DOCS.deprecated);
  assert.match(deprecated, /APOSENTADO/);
  assert.match(deprecated, /run-drain/, "the runbook must name the crontab entries other projects may still have");
  assert.match(deprecated, /run-reaper/);
  assert.match(deprecated, /crontab -l/, "the runbook must show how to inventory the surviving crons");
  assert.match(readDoc(DOCS.readme), /core\/vps\/DEPRECATED\.md/, "the README must point at the retirement notice");
});

test("the two measured failures are recorded where an operator will hit them — canary filter and CLOSED-issue dependency gate", () => {
  const selector = readDoc(DOCS.selector);
  assert.match(selector, /titleIncludes/);
  assert.match(selector, /can[áa]ri/i);
  assert.match(selector, /CLOSED/);
  assert.match(selector, /chain-validate/, "the doc must record that the old validator could not see this failure class");
});
