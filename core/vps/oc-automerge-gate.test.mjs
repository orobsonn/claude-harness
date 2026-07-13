/**
 * @description Pinned contract tests for oc-automerge-gate.mjs — the pure OC auto-merge
 * precondition gate. This suite is intentionally RED until oc-automerge-gate.mjs (and, for the
 * integration-style locked test, scripts/track-parse.mjs) exist: it pins the exact seam contract
 * the executor must implement.
 *
 * Exported shape under test: `ocAutoMergeGateOpen(config, deps)` — a pure function.
 *   - `config`: plain object, may carry `runtime`, `driver`, `autoMergeEnabled`.
 *   - `deps`: optional filesystem injection object (`existsSync`, `readFileSync`,
 *     `statusFilePath`) — every unit test below injects fakes instead of touching real disk.
 *
 * Behavior pinned:
 *   1. Non-OC config (`runtime !== 'opencode'` and no `driver === 'opencode'`) with
 *      `autoMergeEnabled: true` short-circuits to `true` BEFORE any filesystem check — no
 *      status-file read is ever attempted.
 *   2. OC-driven config reads the status file via injected `deps`; the gate is open (`true`)
 *      only when every tracked precondition (T12, T13, T15) is `true`.
 *   3. Any single precondition `false` closes the gate.
 *   4. Missing/unreadable/malformed status state is default-deny — the gate returns `false`,
 *      never default-allow, on a status file that is absent, throws on read, or is malformed JSON.
 *   5. Integration-style, no injection: the REAL status file
 *      (`core/opencode/oc-automerge-preconditions.json`) must agree with the REAL
 *      IMPLEMENTATION-TRACK.md row status (`row.status === 'done'`) for T12/T13/T15, proving the
 *      two real sources of truth are in sync today.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { ocAutoMergeGateOpen } from "./oc-automerge-gate.mjs";
import { parseTrackRow } from "../../scripts/track-parse.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "../..");

describe("ocAutoMergeGateOpen", () => {
  it("non-OC config short-circuits to true BEFORE any filesystem check (no status-file read attempted)", () => {
    const calls = { existsSync: 0, readFileSync: 0 };
    const deps = {
      existsSync: (...args) => {
        calls.existsSync += 1;
        return false;
      },
      readFileSync: (...args) => {
        calls.readFileSync += 1;
        throw new Error("readFileSync must never be called for a non-OC config");
      },
      statusFilePath: "/fake/path/oc-automerge-preconditions.json",
    };
    const config = { runtime: "claude", autoMergeEnabled: true };

    const result = ocAutoMergeGateOpen(config, deps);

    assert.equal(result, true);
    assert.equal(calls.existsSync, 0, "existsSync must never be invoked for a non-OC config");
    assert.equal(calls.readFileSync, 0, "readFileSync must never be invoked for a non-OC config");
  });

  it("OC config with T12/T13/T15 all true returns true", () => {
    const deps = {
      existsSync: () => true,
      readFileSync: () => JSON.stringify({ T12: true, T13: true, T15: true }),
      statusFilePath: "/fake/path/oc-automerge-preconditions.json",
    };
    const config = { runtime: "opencode", autoMergeEnabled: true };

    assert.equal(ocAutoMergeGateOpen(config, deps), true);
  });

  it("OC config with one precondition (T15) false returns false", () => {
    const deps = {
      existsSync: () => true,
      readFileSync: () => JSON.stringify({ T12: true, T13: true, T15: false }),
      statusFilePath: "/fake/path/oc-automerge-preconditions.json",
    };
    const config = { runtime: "opencode", autoMergeEnabled: true };

    assert.equal(ocAutoMergeGateOpen(config, deps), false);
  });

  it("OC config with an absent status file returns false (default-deny, never default-allow)", () => {
    const deps = {
      existsSync: () => false,
      readFileSync: () => {
        const err = new Error("ENOENT: no such file or directory");
        err.code = "ENOENT";
        throw err;
      },
      statusFilePath: "/fake/path/oc-automerge-preconditions.json",
    };
    const config = { runtime: "opencode", autoMergeEnabled: true };

    assert.equal(ocAutoMergeGateOpen(config, deps), false);
  });

  it("OC config with a status file that throws on read returns false (default-deny, never default-allow)", () => {
    const deps = {
      existsSync: () => true,
      readFileSync: () => {
        throw new Error("simulated unreadable status file");
      },
      statusFilePath: "/fake/path/oc-automerge-preconditions.json",
    };
    const config = { runtime: "opencode", autoMergeEnabled: true };

    assert.equal(ocAutoMergeGateOpen(config, deps), false);
  });

  it("OC config with a malformed-JSON status file returns false (default-deny, never default-allow)", () => {
    const deps = {
      existsSync: () => true,
      readFileSync: () => "{not json",
      statusFilePath: "/fake/path/oc-automerge-preconditions.json",
    };
    const config = { runtime: "opencode", autoMergeEnabled: true };

    assert.equal(ocAutoMergeGateOpen(config, deps), false);
  });

  it("REAL status file booleans strictly match the REAL IMPLEMENTATION-TRACK.md 'done' status for T12/T13/T15", () => {
    const statusFilePath = resolve(REPO_ROOT, "core/opencode/oc-automerge-preconditions.json");
    const trackFilePath = resolve(REPO_ROOT, "docs/specs/oc-port/IMPLEMENTATION-TRACK.md");

    const status = JSON.parse(readFileSync(statusFilePath, "utf8"));
    const trackText = readFileSync(trackFilePath, "utf8");

    for (const id of ["T12", "T13", "T15"]) {
      const row = parseTrackRow(trackText, id);
      assert.equal(
        status[id],
        row.status === "done",
        `status file's ${id} boolean must strictly equal (TRACK row status === "done")`
      );
    }
  });
});
