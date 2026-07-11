/**
 * @description End-to-end frozen oracle for the 'spec-adversaried' checkpoint. Drives the REAL
 * chain across all three production files — mark.mjs (parseArgs/run), stamp-triage.mjs (handle),
 * and notify-telegram.mjs (drainTelegramOutbox) — with NO fakes standing in for any of them; the
 * only injected seam is the `send` callback (the network boundary). This is the guard that catches
 * any field-name divergence across the three modules (e.g. a producer stamping `findings` while the
 * renderer reads `count`). Zero-dep (node:test + node:assert/strict + node builtins only).
 * Run with: node --test core/vps/spec-adversaried-e2e.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createRun } from "./obs-outbox.mjs";
import { run as markRun } from "../hooks/mark.mjs";
import { handle } from "../hooks/stamp-triage.mjs";
import { drainTelegramOutbox } from "./notify-telegram.mjs";

test("#spec-adversaried-e2e mark.mjs -> stamp-triage.mjs -> notify-telegram.mjs: a SHIP verdict with findings:2 produces and delivers the 'Spec atacada' checkpoint end to end", async () => {
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

    const sendCalls = [];
    const fakeSend = async (message) => {
      sendCalls.push(message);
      return { sent: true };
    };

    await drainTelegramOutbox({ stateDir: obsStateDir, chatId: "shared-chat", threadId: 999 }, { send: fakeSend });

    const matching = sendCalls.filter((call) => call.event?.type === "spec-adversaried");
    const text = matching.map((call) => call.text).join(" ");
    assert.match(text, /🗡️/, "the checkpoint must render the spec-adversaried emoji");
    assert.match(text, /Spec atacada/, "the checkpoint must render the 'Spec atacada' label");
    assert.match(text, /2 achados/, "the checkpoint must count the findings as '2 achados'");
    assert.match(text, /aprovado/, "a SHIP verdict must render as 'aprovado'");
  } finally {
    delete process.env.HARNESS_OBSERVABILITY_RUN_PATH;
    fs.rmSync(obsStateDir, { recursive: true, force: true });
    fs.rmSync(worktreePath, { recursive: true, force: true });
  }
});
