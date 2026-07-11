/**
 * @description Test suite pinning the spec-adversaried marker contract in
 * stamp-triage.mjs: handle() appends a {type:'spec-adversaried', verdict, findings}
 * observability event for a 'mark.mjs spec-adversaried' payload, never writes a
 * gate-state.json for a session that only ever sends this marker (observability-only,
 * not a gate side effect), and never dedupes repeated same-verdict passes (unlike
 * plan-reviewed's dedupe behavior). Exercises the REAL stamp-triage.mjs (handle) and
 * the REAL core/vps/obs-outbox.mjs (createRun/readEvents) — no fakes stand in for
 * production code.
 * Zero-dep (node:test + node:assert/strict + node builtins only).
 * Run with: node --test core/hooks/spec-adversaried-stamp.test.mjs
 *
 * RED-by-design: stamp-triage.mjs does not yet implement spec-adversaried detection;
 * these tests are expected to fail until that production code lands.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { handle } from "./stamp-triage.mjs";
import { createRun, readEvents } from "../vps/obs-outbox.mjs";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Runs fn inside a fresh OS tmpdir (chdir'd to it), then restores cwd and removes
 * the dir. gate-lib (via stamp-triage) resolves triage.json/gate-state.json from
 * cwd, so chdir isolation prevents polluting the repo's .claude/plans/ during tests.
 * @param {() => void} fn - Synchronous test body
 */
function withTempDir(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "spec-adversaried-cwd-"));
  const savedCwd = process.cwd();
  try {
    process.chdir(tmpDir);
    fn();
  } finally {
    process.chdir(savedCwd);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore cleanup errors */
    }
  }
}

// ---------------------------------------------------------------------------
// 1. mark.mjs spec-adversaried -> {type:'spec-adversaried', verdict, findings} appended
// ---------------------------------------------------------------------------

/**
 * @description Given a 'mark.mjs spec-adversaried --feature-id vps-run-observability
 * --verdict SHIP --findings 2' payload with HARNESS_OBSERVABILITY_RUN_PATH set, when
 * stamp-triage handle() runs, then EXACTLY ONE {type:'spec-adversaried', verdict:'SHIP',
 * findings:2} event is appended to the events JSONL.
 */
test("stamp-triage handle(): mark.mjs spec-adversaried appends exactly one {type:'spec-adversaried', verdict, findings} event", () => {
  withTempDir(() => {
    const sessionId = "ses_sa1";
    const featureId = "vps-run-observability";
    const obsDir = fs.mkdtempSync(path.join(os.tmpdir(), "spec-adversaried-outbox-"));
    try {
      const metaPath = createRun({ issueNumber: 1, project: "proj", worktreePath: obsDir }, obsDir);
      process.env.HARNESS_OBSERVABILITY_RUN_PATH = metaPath;

      const payload = {
        session_id: sessionId,
        tool_name: "Bash",
        tool_input: {
          command: `node .claude/hooks/mark.mjs spec-adversaried --feature-id ${featureId} --verdict SHIP --findings 2`,
        },
        tool_response: JSON.stringify({
          marker: "spec-adversaried",
          feature_id: featureId,
          verdict: "SHIP",
          findings: 2,
        }),
      };

      handle(payload);

      const matching = readEvents(metaPath).filter((e) => e.type === "spec-adversaried");
      assert.equal(
        matching.length,
        1,
        `expected exactly one spec-adversaried event, got ${JSON.stringify(matching)}`,
      );
      // Field-scoped comparison — appendEvent stamps a `ts` field onto every event,
      // so a whole-object deepEqual against a 3-key literal would never pass.
      assert.equal(matching[0].type, "spec-adversaried");
      assert.equal(matching[0].verdict, "SHIP");
      assert.equal(matching[0].findings, 2);
    } finally {
      delete process.env.HARNESS_OBSERVABILITY_RUN_PATH;
      fs.rmSync(obsDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 2. spec-adversaried is observability-only: no gate-state.json write
// ---------------------------------------------------------------------------

/**
 * @description Given a session that has NEVER touched gate-state before, when
 * stamp-triage handle() runs a 'mark.mjs spec-adversaried' payload for that session,
 * then NO gate-state.json file is created for it — the marker is observability-only
 * and must never trigger the gate-state side effect.
 */
test("stamp-triage handle(): mark.mjs spec-adversaried writes no gate-state.json for a session that only sends this marker", () => {
  withTempDir(() => {
    const sessionId = "ses_sa2";
    const featureId = "vps-run-observability";
    const obsDir = fs.mkdtempSync(path.join(os.tmpdir(), "spec-adversaried-outbox-"));
    try {
      const metaPath = createRun({ issueNumber: 2, project: "proj", worktreePath: obsDir }, obsDir);
      process.env.HARNESS_OBSERVABILITY_RUN_PATH = metaPath;

      const payload = {
        session_id: sessionId,
        tool_name: "Bash",
        tool_input: {
          command: `node .claude/hooks/mark.mjs spec-adversaried --feature-id ${featureId} --verdict SHIP --findings 2`,
        },
        tool_response: JSON.stringify({
          marker: "spec-adversaried",
          feature_id: featureId,
          verdict: "SHIP",
          findings: 2,
        }),
      };

      handle(payload);

      const gateStatePath = path.join(".claude/plans/.state", sessionId, "gate-state.json");
      assert.ok(
        !fs.existsSync(gateStatePath),
        "spec-adversaried must never create a gate-state.json for a session that only sends this marker",
      );
    } finally {
      delete process.env.HARNESS_OBSERVABILITY_RUN_PATH;
      fs.rmSync(obsDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 3. spec-adversaried is NOT deduped: repeated same-verdict passes both emit
// ---------------------------------------------------------------------------

/**
 * @description Given the SAME 'mark.mjs spec-adversaried --verdict SHIP --findings 0'
 * payload is handled TWICE in a row, when stamp-triage handle() runs both times, then
 * TWO {type:'spec-adversaried', verdict:'SHIP', findings:0} events are appended — no
 * dedupeFn suppresses a repeated same-verdict pass, unlike plan-reviewed's dedupe
 * behavior.
 */
test("stamp-triage handle(): mark.mjs spec-adversaried is NOT deduped — a repeated same-verdict pass appends twice", () => {
  withTempDir(() => {
    const sessionId = "ses_sa3";
    const featureId = "vps-run-observability";
    const obsDir = fs.mkdtempSync(path.join(os.tmpdir(), "spec-adversaried-outbox-"));
    try {
      const metaPath = createRun({ issueNumber: 3, project: "proj", worktreePath: obsDir }, obsDir);
      process.env.HARNESS_OBSERVABILITY_RUN_PATH = metaPath;

      const payload = {
        session_id: sessionId,
        tool_name: "Bash",
        tool_input: {
          command: `node .claude/hooks/mark.mjs spec-adversaried --feature-id ${featureId} --verdict SHIP --findings 0`,
        },
        tool_response: JSON.stringify({
          marker: "spec-adversaried",
          feature_id: featureId,
          verdict: "SHIP",
          findings: 0,
        }),
      };

      handle(payload);
      handle(payload);

      const matching = readEvents(metaPath).filter((e) => e.type === "spec-adversaried");
      assert.equal(
        matching.length,
        2,
        `two repeated same-verdict spec-adversaried passes must both be appended (no dedupe), got ${JSON.stringify(matching)}`,
      );
      // Field-scoped comparison — appendEvent stamps a `ts` field onto every event,
      // so a whole-object deepEqual against a 3-key literal would never pass.
      for (const event of matching) {
        assert.equal(event.type, "spec-adversaried");
        assert.equal(event.verdict, "SHIP");
        assert.equal(event.findings, 0);
      }
    } finally {
      delete process.env.HARNESS_OBSERVABILITY_RUN_PATH;
      fs.rmSync(obsDir, { recursive: true, force: true });
    }
  });
});
