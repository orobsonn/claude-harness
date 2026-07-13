/** @description Locked tests pinning T14/T17 closeout: live TRACK rows done with a code-checkable
 * T14 notes criterion, checkNoPhase2Artifacts accepting T14 done while the static
 * autoMergeEnabled+opencode config-file guard keeps firing. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

import { parseTrackRow } from "./track-parse.mjs";
import { checkNoPhase2Artifacts } from "./cutover-preflight.test.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");

describe("cutover-preflight-t14-closeout", () => {
  it("t14-t17-done: live TRACK marks T14 and T17 done, T14 notes cite gate + T12 + T13 + T15", () => {
    const liveTrackText = readFileSync(
      join(REPO_ROOT, "docs/specs/oc-port/IMPLEMENTATION-TRACK.md"),
      "utf8"
    );

    const t14 = parseTrackRow(liveTrackText, "T14");
    const t17 = parseTrackRow(liveTrackText, "T17");

    assert.ok(t14, "T14 row must be parseable from live TRACK");
    assert.ok(t17, "T17 row must be parseable from live TRACK");

    assert.equal(t14.status, "done", "T14 must be done");
    assert.equal(t17.status, "done", "T17 must be done");

    const notes = t14.notes.toLowerCase();
    assert.match(notes, /gate/, "T14 notes must mention gate");
    assert.match(notes, /t12/, "T14 notes must mention T12");
    assert.match(notes, /t13/, "T14 notes must mention T13");
    assert.match(notes, /t15/, "T14 notes must mention T15");
  });

  it("t14-preflight-green: checkNoPhase2Artifacts stays ok:true against live repo with T14 done", () => {
    const liveTrackText = readFileSync(
      join(REPO_ROOT, "docs/specs/oc-port/IMPLEMENTATION-TRACK.md"),
      "utf8"
    );

    const result = checkNoPhase2Artifacts(REPO_ROOT, liveTrackText);
    assert.equal(result.ok, true, result.reason);
  });

  it("t14-config-guard: static autoMergeEnabled+opencode config guard still fires with T14 done", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "cutover-preflight-t14-"));
    const ocDir = join(tempRoot, "core/opencode");
    mkdirSync(ocDir, { recursive: true });
    writeFileSync(
      join(ocDir, "harness.routing.json"),
      JSON.stringify({ autoMergeEnabled: true, runtime: "opencode" }),
      "utf8"
    );

    const trackText = `| T14 | Auto-merge only after T12+T13 proven | 09 | done | 2026-07-13 | gate green after T12+T13+T15 |\n`;

    const result = checkNoPhase2Artifacts(tempRoot, trackText);
    assert.equal(result.ok, false, "config-file autoMergeEnabled+opencode guard must still block");
    assert.ok(
      result.found.some((entry) => entry.includes("autoMergeEnabled")),
      `found should include an autoMergeEnabled entry for the OC config path, got: ${JSON.stringify(result.found)}`
    );
  });
});
