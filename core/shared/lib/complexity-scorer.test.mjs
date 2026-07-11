/** @description Locked tests for complexity-scorer (T5b). Bands low/medium/high/max/split per contract. Never throw. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreFile } from "./complexity-scorer.mjs";

test("t5b-band: fixture source scores a stable documented band", () => {
  // fixture chosen to land in medium (11-30) per resolved_judgments thresholds
  const fixtureSource =
    'import x from "x";\n' + Array(25).fill("await bar();\n").join("");
  const r = scoreFile(fixtureSource, "core/shared/lib/example.mjs");
  assert.equal(r.ok, true);
  assert.equal(r.band, "medium");
  assert.ok(r.score >= 11 && r.score <= 30);
  assert.ok(r.signals);
});

test("t5b-malformed: empty or malformed input returns documented result without throw", () => {
  assert.doesNotThrow(() => scoreFile(""));
  const empty = scoreFile("");
  assert.equal(empty.ok, true);
  assert.equal(empty.score, 0);
  assert.equal(empty.band, "low");
  assert.equal(empty.signals.empty, true);

  assert.doesNotThrow(() => scoreFile(null));
  const bad = scoreFile(123);
  assert.equal(bad.ok, false);
  assert.equal(typeof bad.reason, "string");

  const undef = scoreFile(undefined);
  assert.equal(undef.ok, false);
});
