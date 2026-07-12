/**
 * @description Contract tests pinning the security-hardening surface of cron-a-exit.mjs's secret
 * scrubbing and exit-reason capture. Fixes the contract for two areas beyond the existing
 * shape-based pattern list in scrubSecrets():
 *
 *   1. Value-based redaction: scrubSecrets(text, env) must redact any literal env SECRET VALUE
 *      found verbatim in the text (not just shape-matched patterns), while leaving short/path
 *      values and ordinary log content untouched — the second `env` argument is the seam for this
 *      (default process.env in production; tests always pass an explicit env object).
 *   2. Additional secret shapes: URL-embedded userinfo credentials, Authorization: Basic headers,
 *      generic sk- prefixed keys, GitLab glpat- tokens, and colon-form (JSON-style) secret
 *      assignments — not only the `KEY=value` equals-form the current pattern list covers.
 *
 * Also pins that captureExitReason's dual-window read (first 128KiB + last 128KiB) keeps an early
 * gate-deny visible to parseOcRunLog on a large log, and that the last-200-lines summary stays
 * correct without throwing — a bounded dual-window read must not drop head-window denies or
 * corrupt the summary.
 *
 * Every fixture is inline and deterministic; temp dirs are real mkdtemp() under os.tmpdir(),
 * matching this repo's hermetic style (see cron-a-exit-reason.test.mjs). No real gh/git process is
 * ever spawned.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { scrubSecrets, captureExitReason } from "./cron-a-exit.mjs";

/** @description Fresh temp dir for one test; caller is responsible for rmSync cleanup. */
function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "exit-security-"));
}

test("scrubSecrets: value-based redaction — env secret VALUES are redacted by literal-value match, not just shape-based patterns", () => {
  const env = {
    OLLAMA_HAND_TOKEN: "super-secret-value-xyz789",
    ANTHROPIC_AUTH_TOKEN: "another-secret-abc12345",
  };
  const text = "error connecting with super-secret-value-xyz789 and another-secret-abc12345 done";

  const output = scrubSecrets(text, env);

  assert.ok(output.includes("[REDACTED]"), "output must contain the redaction marker");
  assert.ok(!output.includes("super-secret-value-xyz789"), "the OLLAMA_HAND_TOKEN value must not survive verbatim");
  assert.ok(!output.includes("another-secret-abc12345"), "the ANTHROPIC_AUTH_TOKEN value must not survive verbatim");
});

test("scrubSecrets: does not over-redact short/path env values or ordinary log words", () => {
  const ghToken = "ghp_" + "realtokenvalue" + "1234567890" + "abcdef0123";
  const env = {
    HOME: "/root",
    PWD: "/x",
    GITHUB_TOKEN: ghToken,
  };
  const text = "line-150 processed at /root normally";

  const output = scrubSecrets(text, env);

  assert.ok(output.includes("line-150"), "ordinary log content must survive redaction");
  assert.ok(output.includes("/root"), "a short/path env value must not be blanket-redacted");
});

test("scrubSecrets: redacts URL-embedded credentials (userinfo in a URL)", () => {
  const text = "cloning https://robson:myp4ssw0rd_secret@example.com/repo.git";

  const output = scrubSecrets(text, {});

  assert.ok(!output.includes("myp4ssw0rd_secret"), "the URL userinfo password must not survive verbatim");
});

test("scrubSecrets: redacts an Authorization: Basic credential", () => {
  const text = "curl sent Authorization: Basic YWxhZGRpbjpvcGVuc2VzYW1lMTIz";

  const output = scrubSecrets(text, {});

  assert.ok(!output.includes("YWxhZGRpbjpvcGVuc2VzYW1lMTIz"), "the Basic auth credential must not survive verbatim");
});

test("scrubSecrets: redacts a generic sk- OpenAI-shaped key", () => {
  const skKey = "sk-proj-" + "ABCDEF0123" + "456789abcd" + "efGHIJ0123";
  const text = `used key ${skKey}`;

  const output = scrubSecrets(text, {});

  assert.ok(!output.includes(skKey), "the sk- key must not survive verbatim");
});

test("scrubSecrets: redacts a GitLab personal access token (glpat-)", () => {
  const text = "token glpat-ABCDEF0123456789xyzQ";

  const output = scrubSecrets(text, {});

  assert.ok(!output.includes("glpat-ABCDEF0123456789xyzQ"), "the glpat- token must not survive verbatim");
});

test("scrubSecrets: redacts colon-form (JSON-style) assignments and NAME_containing_TOKEN=value assignments", () => {
  const jsonGh = "ghp_" + "jsonvalue123" + "4567890abc" + "def0123";
  const text =
    `config {"GITHUB_TOKEN": "${jsonGh}", "password": "supersecretpass"}\nTELEGRAM_BOT_TOKEN=12345:AAABBBCCCDDDsecretvalue`;

  const output = scrubSecrets(text, {});

  assert.ok(
    !output.includes(jsonGh),
    "the colon-form GITHUB_TOKEN value must not survive verbatim"
  );
  assert.ok(!output.includes("supersecretpass"), "the colon-form password value must not survive verbatim");
  assert.ok(
    !output.includes("12345:AAABBBCCCDDDsecretvalue"),
    "the TELEGRAM_BOT_TOKEN assignment value must not survive verbatim"
  );
});

test("locked: captureExitReason dual-window read (first+last 128KiB) keeps early gate-deny and last-200-lines summary on a large log", () => {
  const dir = makeTempDir();
  try {
    const logPath = join(dir, "raw.log");
    // Early gate-deny at byte 0 — outside any pure-tail window on a >256KiB log.
    const gateDenyLine = JSON.stringify({
      type: "tool_use",
      part: {
        state: {
          status: "error",
          error: "[entry-gate] dual required before task",
        },
      },
    });
    // Middle pad so total size exceeds 2×128KiB (dual-window budget) and the head is far from the tail.
    const padLine = "x".repeat(200);
    const midLines = [];
    let midBytes = 0;
    const targetMidBytes = 300 * 1024;
    for (let i = 0; midBytes < targetMidBytes; i++) {
      const line = `pad-${i} ${padLine}`;
      midLines.push(line);
      midBytes += line.length + 1;
    }
    const tailLines = [];
    for (let j = 1; j <= 200; j++) {
      tailLines.push(`log-tail-${j}`);
    }
    const content = [gateDenyLine, ...midLines, ...tailLines].join("\n");
    assert.ok(
      Buffer.byteLength(content, "utf8") > 256 * 1024,
      "fixture must exceed the dual-window total budget so head and tail are distinct"
    );
    writeFileSync(logPath, content, "utf8");
    const outcome = { outcome: "requeued", issueNumber: 99, hadPr: false, finding: null };

    assert.doesNotThrow(() => {
      captureExitReason({ stateDir: dir, outcome, exitCode: 0, logPath, now: () => 1700000000 });
    });

    const reasonFile = join(dir, "issue-99-exit-reason.json");
    assert.ok(existsSync(reasonFile), "reason file must exist after a non-PR exit even for a large log");
    const parsed = JSON.parse(readFileSync(reasonFile, "utf8"));
    assert.equal(
      parsed.category,
      "tool-deny",
      "early gate-deny in the head window must set category tool-deny (not lost to a pure-tail read)"
    );
    assert.ok(
      parsed.parserOutcome?.toolErrors?.some((e) => e.gateDeny === true),
      "parserOutcome.toolErrors must surface gateDeny from the head window"
    );
    const expectedSummary = tailLines.join("\n");
    assert.equal(
      parsed.summary,
      expectedSummary,
      "summary must equal the last 200 lines of a large log, joined by newline"
    );
    assert.equal(existsSync(logPath), false, "the raw log file must be unlinked after being read");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scrubSecrets: redacts a connection-string-style secret whose env name is DATABASE_URL (no KEY/TOKEN/SECRET/PASSWORD/AUTH substring)", () => {
  const env = {
    DATABASE_URL: "postgres://appuser:sup3r-dsn-secret@db.internal:5432/prod",
  };
  const text = "connecting with postgres://appuser:sup3r-dsn-secret@db.internal:5432/prod now";

  const output = scrubSecrets(text, env);

  assert.ok(!output.includes("sup3r-dsn-secret"), "the DATABASE_URL value must not survive verbatim");
});

test("scrubSecrets: redacts URL-embedded credentials for a non-http scheme (postgres://) by shape alone", () => {
  const text = "dsn=postgres://robson:anotherSecret1@db.internal/prod";

  const output = scrubSecrets(text, {});

  assert.ok(!output.includes("anotherSecret1"), "a non-http URL-cred password must not survive verbatim");
});

test("scrubSecrets: does not redact a path-like value for an env name that matches the AUTH pattern (forensic value preserved)", () => {
  const env = {
    AUTH_DIR: "/usr/local/harness-auth",
  };
  const text = "reading config from /usr/local/harness-auth/config.json";

  const output = scrubSecrets(text, env);

  assert.ok(
    output.includes("/usr/local/harness-auth"),
    "an absolute-path value must survive redaction even when its env name matches AUTH — it is not a secret"
  );
});

test("locked: captureExitReason deep-scrubs secrets in parserOutcome.toolErrors messages and reasons before writing exit-reason.json", () => {
  const dir = makeTempDir();
  try {
    const token = "ghp_" + "Z9y8X7w6V5u4T3s2" + "R1q0P9o8N7m6L5k4" + "J3i2";
    const logPath = join(dir, "raw.log");
    // NDJSON tool_use error so parseOcRunLog populates toolErrors + reasons with the secret.
    const ndjsonLine = JSON.stringify({
      type: "tool_use",
      part: {
        state: {
          status: "error",
          error: `failed with token ${token}`,
        },
      },
    });
    writeFileSync(logPath, ndjsonLine + "\n", "utf8");
    const outcome = { outcome: "failed", issueNumber: 42, hadPr: false, finding: null };

    captureExitReason({ stateDir: dir, outcome, exitCode: 1, logPath, now: () => 1700000000 });

    const parsed = JSON.parse(readFileSync(join(dir, "issue-42-exit-reason.json"), "utf8"));
    assert.ok(parsed.parserOutcome, "parserOutcome must be present on a non-PR exit with a parseable log");
    const blob = JSON.stringify(parsed.parserOutcome);
    assert.ok(!blob.includes(token), "parserOutcome must never contain the raw token verbatim");
    assert.ok(
      Array.isArray(parsed.parserOutcome.toolErrors) &&
        parsed.parserOutcome.toolErrors.some(
          (e) => typeof e.message === "string" && e.message.includes("[REDACTED]")
        ),
      "toolErrors messages must be scrubbed with the redaction marker"
    );
    assert.ok(
      Array.isArray(parsed.parserOutcome.reasons) &&
        parsed.parserOutcome.reasons.some((r) => typeof r === "string" && r.includes("[REDACTED]")),
      "reasons must be scrubbed with the redaction marker"
    );
    assert.ok(!parsed.summary.includes(token), "summary must also remain scrubbed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
