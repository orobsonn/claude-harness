/**
 * @description SMOKE test against the REAL Orca CLI. Deliberately separate from
 * `select-and-dispatch.test.mjs`, which is hermetic by contract (zero real CLI).
 *
 * Why this file exists: v0.57.0 shipped a `parseWorktreePs` that read a response shape nobody had
 * ever observed, and the frozen oracle asserted that same invented shape — so both passed and both
 * were wrong, and the selector skipped 100% of its ticks in silence on a real VPS. A hermetic oracle
 * can only ever prove the code agrees with its author's assumption. One call against the live CLI is
 * what proves the assumption agrees with the CLI, and it would have failed in the first minute.
 *
 * It SKIPS when no Orca binary is resolvable, so CI and any dev machine without Orca stay green.
 * `ORCA_BIN` still wins when set, but it is no longer required: the candidate order comes from
 * `orcaCandidates` (the same one `orca-doctor` uses), so the usual install
 * (`/opt/orca/orca-linux.AppImage`, which is NOT on PATH) is found on its own.
 *
 * The probe was `--help` until it was measured on a live VPS: the `orca` shim registered on `PATH`
 * answers it with `bad option: --no-sandbox` (a node arg-parse error from its own wrapper) while the
 * AppImage answers every command correctly — so this smoke skipped 2/2 on the one machine that HAS
 * Orca, which is precisely the silent hole its own header warned about, one level up. A liveness
 * probe here asks a REAL question and validates the envelope; nothing else proves the CLI answers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import { parseWorktreePs, countWorking, unwrapOrca } from "./select-and-dispatch.mjs";
import { PROBE_TIMEOUT_MS, orcaCandidates, readEnvelope } from "../claude-code/skills/connecting-orca/references/orca-doctor.mjs";

/** @returns {string|null} the first candidate that ANSWERS the envelope, or null when none does. */
function resolveOrca() {
  for (const bin of orcaCandidates(process.env)) {
    try {
      const stdout = execFileSync(bin, ["worktree", "ps", "--json"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        // Bounded per candidate: a mute binary must not hold the whole suite hostage. At the previous
        // 120s, two silent candidates meant four minutes of a test run with nothing on stdout.
        timeout: PROBE_TIMEOUT_MS,
      });
      if (readEnvelope(stdout).readable) return bin;
    } catch (error) {
      // A refusal (`ok:false`, non-zero exit) is still an answer — the binary works, it said no.
      if (readEnvelope(String(error?.stdout ?? "")).readable) return bin;
    }
  }
  return null;
}

// Resolved LAZILY. At module scope this ran a real subprocess during test COLLECTION — before any
// reporter output — so a slow binary looked like a hung suite rather than a slow probe.
let resolved;
/** @returns {string|null} */
function orcaBin() {
  if (resolved === undefined) resolved = resolveOrca();
  return resolved;
}
/** @returns {false|string} node:test's `skip` value: false to run, a reason string to skip. */
function skipReason() {
  return orcaBin() ? false : `no Orca binary answered (tried: ${orcaCandidates(process.env).join(", ")})`;
}

test("SMOKE: `orca worktree ps --json` parses, and the concurrency ceiling can actually be counted from it", { skip: skipReason() }, () => {
  const stdout = execFileSync(orcaBin(), ["worktree", "ps", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });

  const entries = parseWorktreePs(stdout);
  assert.notEqual(
    entries,
    null,
    "the live response came back UNREADABLE — this is exactly the v0.57.0 defect, not a flake",
  );
  assert.ok(Array.isArray(entries));

  const working = countWorking(entries);
  assert.ok(Number.isInteger(working) && working >= 0, "the ceiling must be countable");
  assert.ok(working <= entries.length);
});

test("SMOKE: the response envelope is a property of the CLI, not of one command", { skip: skipReason() }, () => {
  // If this ever fails for a command, the boundary contract changed for ALL of them — which is the
  // whole reason unwrapOrca lives at the boundary instead of one parser per command.
  for (const argv of [["status"], ["repo", "list"], ["worktree", "list"], ["worktree", "ps"]]) {
    let stdout;
    try {
      stdout = execFileSync(orcaBin(), [...argv, "--json"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 120_000,
      });
    } catch {
      continue; // a command this build does not support is not a contract failure
    }
    const raw = JSON.parse(stdout);
    assert.deepEqual(
      Object.keys(raw).sort(),
      ["_meta", "id", "ok", "result"],
      `orca ${argv.join(" ")} --json no longer answers the documented envelope`,
    );
    assert.doesNotThrow(() => unwrapOrca(raw));
  }
});
