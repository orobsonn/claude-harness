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
 * Also pins that captureExitReason's last-200-lines summary stays correct on a large (~4000-line)
 * raw log without throwing — a bounded/tail read must not corrupt or truncate the summary.
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

test("captureExitReason: bounded read of a large (~4000-line) log still yields the correct last-200-lines summary, without throwing", () => {
  const dir = makeTempDir();
  try {
    const logPath = join(dir, "raw.log");
    const totalLines = 4000;
    const lines = [];
    for (let i = 1; i <= totalLines; i++) {
      lines.push(`log-${i}`);
    }
    writeFileSync(logPath, lines.join("\n"), "utf8");
    const outcome = { outcome: "requeued", issueNumber: 99, hadPr: false, finding: null };

    assert.doesNotThrow(() => {
      captureExitReason({ stateDir: dir, outcome, exitCode: 0, logPath, now: () => 1700000000 });
    });

    const reasonFile = join(dir, "issue-99-exit-reason.json");
    assert.ok(existsSync(reasonFile), "reason file must exist after a non-PR exit even for a large log");
    const parsed = JSON.parse(readFileSync(reasonFile, "utf8"));
    const expectedSummary = lines.slice(totalLines - 200, totalLines).join("\n");
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
