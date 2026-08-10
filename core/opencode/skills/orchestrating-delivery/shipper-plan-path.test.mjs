/** @description Locks the canonical plan-path contract for the OpenCode shipper brief. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const skill = join(dirname(fileURLToPath(import.meta.url)), "SKILL.md");
const shipper = join(dirname(fileURLToPath(import.meta.url)), "../../agents/shipper.md");

test("Phase 5 forwards the classify/recovery canonical plan path to shipper", () => {
  const text = readFileSync(skill, "utf8");
  const phaseFive = text.slice(text.indexOf("## Phase 5 — Harvest + ship"));

  assert.match(phaseFive, /`plan_path`.*classify.*`canonical_plan_path`.*recovery/i);
  assert.match(phaseFive, /Plan path \(authoritative\):.*<literal authoritative plan path>/i);
  assert.match(phaseFive, /LIGHT\/FULL/i);
  assert.match(phaseFive, /QUICK.*omit/i);
  assert.match(phaseFive, /never reconstruct.*session/i);
});

test("shipper accepts only the authoritative path and a constrained unreadable fallback", () => {
  const text = readFileSync(shipper, "utf8");

  assert.match(text, /authoritative.*plan path.*conductor/i);
  assert.match(text, /feature_id.*equals this run's feature/i);
  assert.match(text, /supplied path.*unreadable/i);
  assert.match(text, /LIGHT\/FULL[\s\S]*missing[\s\S]*no plan[\s\S]*do not guess/i);
  assert.match(text, /QUICK.*no plan/i);
});
