/**
 * @description Contract tests for persistReviewFindings (review-routing.mjs) — the fix-mode
 * findings-persistence seam that replaces the old no-op `defaultRecordFindings`. Grupo C #ac-1.2.
 *
 * The seam reads the REAL sha-keyed eye-outputs artifact the review session already writes
 * (`<reviewStateDir>/session-out/eyes-<pr>-<sha>.json`), extracts ONLY typed fields
 * (severity + a size-capped, secret-scrubbed summary), derives the authoritative fix scope from the
 * PR's changed files via `gh` (fail-CLOSED to an empty list on any gh error — never a silent
 * fail-open), keys the output by sha, and writes a self-contained `fix-findings-<root>.json` to the
 * base stateDir the dispatcher reads. Raw eye objects and free-form prose NEVER pass through
 * verbatim — the typed extraction is the injection defense at the source.
 *
 * Run with: node --test core/vps/review-routing-fix-findings.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { persistReviewFindings } from "./review-routing.mjs";

function withDirs(fn) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "fix-findings-"));
  const reviewStateDir = path.join(base, "review");
  const outStateDir = base;
  fs.mkdirSync(path.join(reviewStateDir, "session-out"), { recursive: true });
  try {
    fn({ base, reviewStateDir, outStateDir });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

/** Writes the sha-keyed eye-outputs artifact the review session would have produced. */
function writeEyes(reviewStateDir, pr, sha, eyes) {
  fs.writeFileSync(
    path.join(reviewStateDir, "session-out", `eyes-${pr}-${sha}.json`),
    JSON.stringify(eyes),
    "utf8",
  );
}

/** Fake gh returning the PR's changed files as gh's real `--json files` shape. */
function makeGh(files, { throwOnView = false } = {}) {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    if (throwOnView) throw new Error("gh unreachable");
    return { files: files.map((p) => ({ path: p })) };
  };
  return { gh, calls };
}

function readOut(outStateDir, root) {
  return JSON.parse(fs.readFileSync(path.join(outStateDir, `fix-findings-${root}.json`), "utf8"));
}

test("#ac-1.2 extracts typed {severity,summary} from the sha-keyed eye-outputs; drops raw eye objects; keys the file by sha; derives changedFiles from gh", () => {
  withDirs(({ reviewStateDir, outStateDir }) => {
    const pr = { number: 501, headRefName: "harness/42" };
    const sha = "abc123def456";
    writeEyes(reviewStateDir, pr.number, sha, {
      adversary: {
        verdict: "BLOCKED",
        findings: [
          { issue: "race on the counter", severity: "high", evidence: "cron-state.mjs:88", fix_hint: "guard with EXISTS" },
        ],
      },
      compliance: { verdict: "pass", findings: [] },
      security: { verdict: "SECURE", findings: [] },
    });
    const { gh } = makeGh(["core/vps/cron-state.mjs", "core/vps/x.mjs"]);

    persistReviewFindings(42, { status: "BLOCKED", finding: "adversary" }, {
      pr, sha, gh, reviewStateDir, outStateDir,
    });

    const out = readOut(outStateDir, 42);
    assert.equal(out.root, 42);
    assert.equal(out.sha, sha, "the file MUST be keyed by the reviewed sha (stale-detection anchor)");
    assert.equal(out.pr, 501);
    assert.deepEqual(out.changedFiles, ["core/vps/cron-state.mjs", "core/vps/x.mjs"], "scope = authoritative PR changed files");
    assert.equal(out.findings.length, 1);
    const f = out.findings[0];
    assert.equal(f.severity, "high", "severity is a typed field");
    assert.equal(typeof f.summary, "string");
    assert.ok(f.summary.includes("race on the counter"), "summary carries the finding text");
    // The raw eye object's extra keys must NOT survive — only the typed projection.
    assert.deepEqual(Object.keys(f).sort(), ["severity", "summary"], "only typed fields survive; no raw passthrough");
  });
});

test("#ac-1.2 size-caps the finding count and truncates each summary", () => {
  withDirs(({ reviewStateDir, outStateDir }) => {
    const pr = { number: 7, headRefName: "harness/7" };
    const sha = "0123456789ab";
    const many = Array.from({ length: 50 }, (_, i) => ({
      issue: "x".repeat(5000),
      severity: "low",
      evidence: `f${i}.mjs:1`,
      fix_hint: "y".repeat(5000),
    }));
    writeEyes(reviewStateDir, pr.number, sha, {
      adversary: { verdict: "BLOCKED", findings: many },
      compliance: { verdict: "pass", findings: [] },
      security: { verdict: "SECURE", findings: [] },
    });
    const { gh } = makeGh(["a.mjs"]);

    persistReviewFindings(7, { status: "BLOCKED", finding: "adversary" }, { pr, sha, gh, reviewStateDir, outStateDir });

    const out = readOut(outStateDir, 7);
    assert.ok(out.findings.length <= 20, "finding count is capped");
    for (const f of out.findings) {
      assert.ok(f.summary.length <= 500, "each summary is truncated to a bounded length");
    }
  });
});

test("#ac-1.2 secret hardening: `evidence` is DROPPED from the summary (its verbatim source-quote channel), and scrubSecrets redacts diverse secret shapes in issue/fix_hint", () => {
  withDirs(({ reviewStateDir, outStateDir }) => {
    const pr = { number: 9, headRefName: "harness/9" };
    const sha = "beadfeed0011";
    // Secret-shaped FIXTURES are assembled at runtime (never a full secret literal in the source), so
    // the repo's own secret scanner (locked-2 zero-findings invariant) does not trip on this test file
    // while scrubSecrets still receives the real joined shapes.
    const awsKey = "AKIA" + "IOSFODNN7" + "EXAMPLE";
    const jwt = ["eyJ" + "hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9", "eyJ" + "zdWIiOiIxMjM0NTY3ODkwIn0", "dozjgNr" + "yP4J3jVmNHl0w"].join(".");
    const evidenceSecret = "sk-" + "EVIDENCEONLYSECRET" + "1234567890";
    const dbPass = "hunter" + "2pass";
    writeEyes(reviewStateDir, pr.number, sha, {
      adversary: {
        verdict: "BLOCKED",
        findings: [
          // evidence carries a quoted secret — must NOT appear in the summary at all (field dropped).
          { issue: "hardcoded key", severity: "high", evidence: `line 3: const k = '${evidenceSecret}'`, fix_hint: "move token to env" },
          // secrets embedded in issue/fix_hint (the kept fields) must be scrubbed by the belt.
          { issue: `aws key ${awsKey} committed`, severity: "high", evidence: "e", fix_hint: "rotate it" },
          { issue: "jwt leak", severity: "medium", evidence: "e", fix_hint: `found ${jwt} in log` },
          { issue: "db url", severity: "medium", evidence: "e", fix_hint: `postgres://admin:${dbPass}@db.host:5432/app leaks creds` },
        ],
      },
      compliance: { verdict: "pass", findings: [] },
      security: { verdict: "SECURE", findings: [] },
    });
    const { gh } = makeGh(["a.mjs"]);

    persistReviewFindings(9, { status: "BLOCKED", finding: "adversary" }, { pr, sha, gh, reviewStateDir, outStateDir });

    const blob = JSON.stringify(readOut(outStateDir, 9));
    assert.ok(!blob.includes(evidenceSecret), "evidence is dropped — its quoted secret never reaches the summary");
    assert.ok(!blob.includes(awsKey), "AWS access-key id (no separator) must be scrubbed");
    assert.ok(!blob.includes("eyJ" + "zdWIiOiIxMjM0NTY3ODkwIn0"), "JWT payload segment must be scrubbed");
    assert.ok(!blob.includes(dbPass), "connection-string password must be scrubbed");
    // The non-secret defect text is preserved so the fix session still has a target.
    assert.ok(/aws key/.test(blob) && /jwt leak/.test(blob), "the abstract defect description survives the scrub");
  });
});

test("#ac-1.2 HIGH-2 fail-CLOSED: a gh error yields an EMPTY changedFiles scope (never a silent wide/absent scope)", () => {
  withDirs(({ reviewStateDir, outStateDir }) => {
    const pr = { number: 11, headRefName: "harness/11" };
    const sha = "cafe12345678";
    writeEyes(reviewStateDir, pr.number, sha, {
      adversary: { verdict: "BLOCKED", findings: [{ issue: "x", severity: "medium", evidence: "a.mjs:1", fix_hint: "z" }] },
      compliance: { verdict: "pass", findings: [] },
      security: { verdict: "SECURE", findings: [] },
    });
    const { gh } = makeGh(["a.mjs"], { throwOnView: true });

    persistReviewFindings(11, { status: "BLOCKED", finding: "adversary" }, { pr, sha, gh, reviewStateDir, outStateDir });

    const out = readOut(outStateDir, 11);
    assert.deepEqual(out.changedFiles, [], "gh failure MUST yield an empty scope — the dispatcher then fails closed (no fix-mode)");
  });
});

test("#ac-1.2 a path with a newline or absolute/traversal shape is dropped from changedFiles (no injected scope entry)", () => {
  withDirs(({ reviewStateDir, outStateDir }) => {
    const pr = { number: 13, headRefName: "harness/13" };
    const sha = "d00d12345678";
    writeEyes(reviewStateDir, pr.number, sha, {
      adversary: { verdict: "BLOCKED", findings: [{ issue: "x", severity: "low", evidence: "a.mjs:1", fix_hint: "z" }] },
      compliance: { verdict: "pass", findings: [] },
      security: { verdict: "SECURE", findings: [] },
    });
    const { gh } = makeGh(["ok.mjs", "/etc/passwd", "bad\nname.mjs", "../escape.mjs"]);

    persistReviewFindings(13, { status: "BLOCKED", finding: "adversary" }, { pr, sha, gh, reviewStateDir, outStateDir });

    const out = readOut(outStateDir, 13);
    assert.deepEqual(out.changedFiles, ["ok.mjs"], "only safe relative paths survive; absolute/traversal/newline dropped");
  });
});

test("#ac-1.4 each reviewed sha is judged independently: a fix commit (new sha) re-reviews and persists a FRESH sha-keyed findings payload, not the prior sha's", () => {
  withDirs(({ reviewStateDir, outStateDir }) => {
    const pr = { number: 88, headRefName: "harness/88" };
    const shaA = "aaaa11112222";
    const shaB = "bbbb33334444"; // the head sha after the fix commit
    writeEyes(reviewStateDir, pr.number, shaA, {
      adversary: { verdict: "BLOCKED", findings: [{ issue: "problem A", severity: "high", evidence: "a.mjs:1", fix_hint: "fixA" }] },
      compliance: { verdict: "pass", findings: [] },
      security: { verdict: "SECURE", findings: [] },
    });
    writeEyes(reviewStateDir, pr.number, shaB, {
      adversary: { verdict: "BLOCKED", findings: [{ issue: "problem B", severity: "medium", evidence: "b.mjs:2", fix_hint: "fixB" }] },
      compliance: { verdict: "pass", findings: [] },
      security: { verdict: "SECURE", findings: [] },
    });
    const { gh } = makeGh(["a.mjs", "b.mjs"]);

    // First reject at sha A.
    persistReviewFindings(88, { status: "BLOCKED", finding: "adversary" }, { pr, sha: shaA, gh, reviewStateDir, outStateDir });
    let out = readOut(outStateDir, 88);
    assert.equal(out.sha, shaA);
    assert.ok(out.findings[0].summary.includes("problem A"));

    // The fix commit changes the head sha → a fresh independent review at sha B overwrites with B's
    // findings (the review re-judged the NEW commit; it did not reuse sha A's verdict).
    persistReviewFindings(88, { status: "BLOCKED", finding: "adversary" }, { pr, sha: shaB, gh, reviewStateDir, outStateDir });
    out = readOut(outStateDir, 88);
    assert.equal(out.sha, shaB, "the findings file is re-keyed to the new sha after the fix commit");
    assert.ok(out.findings[0].summary.includes("problem B"), "the findings are the NEW review's, re-judged independently");
  });
});

test("#ac-1.2 NEW-3 path-safety: an invalid sha shape is never joined into the eyes path — read is aborted (empty findings), not attempted", () => {
  withDirs(({ reviewStateDir, outStateDir }) => {
    const pr = { number: 17, headRefName: "harness/17" };
    const badSha = "../../etc/passwd";
    const { gh } = makeGh(["a.mjs"]);

    persistReviewFindings(17, { status: "BLOCKED", finding: "adversary" }, { pr, sha: badSha, gh, reviewStateDir, outStateDir });

    const out = readOut(outStateDir, 17);
    assert.deepEqual(out.findings, [], "an unvalidated sha must abort the eyes read, never build a traversal path");
    assert.equal(out.sha, null, "an invalid sha is not echoed back as a real key");
  });
});

test("#ac-1.2 missing/corrupt eye-outputs → degrades to an empty findings list plus the failing-eye NAME (never a crash)", () => {
  withDirs(({ reviewStateDir, outStateDir }) => {
    const pr = { number: 15, headRefName: "harness/15" };
    const sha = "feed12345678";
    // No eyes file written.
    const { gh } = makeGh(["a.mjs"]);

    persistReviewFindings(15, { status: "BLOCKED", finding: "security" }, { pr, sha, gh, reviewStateDir, outStateDir });

    const out = readOut(outStateDir, 15);
    assert.deepEqual(out.findings, [], "no eyes file → empty findings, not a throw");
    assert.equal(out.finding, "security", "the failing-eye name is still carried so the session knows which eye");
  });
});
