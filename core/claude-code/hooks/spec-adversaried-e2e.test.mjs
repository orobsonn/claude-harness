/**
 * @description End-to-end frozen oracle for the 'spec-adversaried' checkpoint. Drives the REAL
 * chain across both remaining production files — mark.mjs (parseArgs/run) -> stamp-triage.mjs
 * (handle) -> core/shared/lib/obs-outbox.mjs (readEvents) — with NO fakes standing in for any of
 * them. This is the guard that catches any field-name divergence between the producer (mark.mjs)
 * and the consumer (stamp-triage.mjs), e.g. a producer stamping `findings` while the parser reads
 * `count`, and that `findings` is coerced to a NUMBER (not left as the string mark.mjs was given).
 * The Telegram renderer that used to sit downstream of this outbox (notify-telegram.mjs) was
 * retired in #834 with no live caller — see docs/vps-retirement.md; this oracle now stops at the
 * outbox, the last live consumer in the chain. Zero-dep (node:test + node:assert/strict + node
 * builtins only).
 * Run with: node --test core/claude-code/hooks/spec-adversaried-e2e.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createRun, readEvents } from "../../shared/lib/obs-outbox.mjs";
import { run as markRun } from "./mark.mjs";
import { handle } from "./stamp-triage.mjs";

test("#spec-adversaried-e2e mark.mjs -> stamp-triage.mjs -> obs-outbox.mjs: a SHIP verdict with findings:2 produces the 'spec-adversaried' outbox event end to end", () => {
  const obsStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "spec-adversaried-e2e-outbox-"));
  const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), "spec-adversaried-e2e-worktree-"));
  try {
    const metaPath = createRun({ issueNumber: 301, project: "proj", worktreePath }, obsStateDir);
    process.env.HARNESS_OBSERVABILITY_RUN_PATH = metaPath;

    const markResult = markRun({
      marker: "spec-adversaried",
      feature_id: "f",
      verdict: "SHIP",
      findings: "2",
    });
    assert.equal(markResult.success, true, "the real mark.mjs run() must accept the spec-adversaried marker");

    const payload = {
      session_id: "ses_e2e1",
      tool_name: "Bash",
      tool_input: {
        command: "node .claude/hooks/mark.mjs spec-adversaried --feature-id f --verdict SHIP --findings 2",
      },
      tool_response: JSON.stringify(markResult.output),
    };
    handle(payload);

    const matching = readEvents(metaPath).filter((e) => e.type === "spec-adversaried");
    assert.equal(matching.length, 1, `expected exactly one 'spec-adversaried' event, got ${JSON.stringify(matching)}`);
    assert.equal(matching[0].verdict, "SHIP", "the outbox event must carry the SHIP verdict");
    assert.equal(
      matching[0].findings,
      2,
      "the outbox event must carry findings as a NUMBER (mark.mjs coerces the string '2')",
    );
  } finally {
    delete process.env.HARNESS_OBSERVABILITY_RUN_PATH;
    fs.rmSync(obsStateDir, { recursive: true, force: true });
    fs.rmSync(worktreePath, { recursive: true, force: true });
  }
});
