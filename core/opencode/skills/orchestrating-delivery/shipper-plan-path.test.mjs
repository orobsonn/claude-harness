/** @description Locks the stable feature-plan contract for the OpenCode shipper brief. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const skill = join(dirname(fileURLToPath(import.meta.url)), "SKILL.md");
const shipper = join(dirname(fileURLToPath(import.meta.url)), "../../agents/shipper.md");

test("Phase 5 forwards the stable feature plan path to shipper", () => {
  const text = readFileSync(skill, "utf8");
  const phaseFive = text.slice(text.indexOf("## Phase 5 — Harvest + ship"));

  assert.match(phaseFive, /stable path returned by classify/i);
  assert.match(phaseFive, /\.opencode\/plans\/<feature_id>\/execution-plan\.json/i);
  assert.match(phaseFive, /LIGHT\/FULL/i);
  assert.match(phaseFive, /QUICK.*omit/i);
  assert.doesNotMatch(phaseFive, /canonical_plan_path|recovery|session-scoped/i);
});

test("shipper accepts only the supplied stable feature plan", () => {
  const text = readFileSync(shipper, "utf8");

  assert.match(text, /literal stable `plan_path` returned by classify/i);
  assert.match(text, /read only the supplied stable plan path/i);
  assert.match(text, /feature_id[\s\S]{0,40}equals[\s\S]{0,40}this run's feature/i);
  assert.match(text, /missing or unreadable on LIGHT\/FULL[\s\S]*do not glob[\s\S]*guess another path/i);
  assert.match(text, /QUICK.*no plan/i);
  assert.doesNotMatch(text, /canonical_plan_path|recovery|session-scoped/i);
});
