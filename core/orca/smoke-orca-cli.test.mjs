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
 * Set `ORCA_BIN` to point at an AppImage that is not on PATH — the usual install
 * (`/opt/orca/orca-linux.AppImage`) is not.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import { parseWorktreePs, countWorking, unwrapOrca } from "./select-and-dispatch.mjs";

/** @returns {string|null} a runnable Orca binary, or null when none is available. */
function resolveOrca() {
  const bin = process.env.ORCA_BIN || "orca";
  try {
    // `--help`, not `--version`: this build exits 3 on every version flag it was probed with
    // (`--version`, `-v`, `version`) and 0 only on `--help`. Probing with the wrong flag makes the
    // smoke SKIP on a machine that has Orca — a silent hole in exactly the test meant to close one.
    execFileSync(bin, ["--help"], { stdio: "ignore", timeout: 60_000 });
    return bin;
  } catch {
    return null;
  }
}

const ORCA = resolveOrca();
const skip = ORCA ? false : "no Orca binary (set ORCA_BIN to run this smoke)";

test("SMOKE: `orca worktree ps --json` parses, and the concurrency ceiling can actually be counted from it", { skip }, () => {
  const stdout = execFileSync(ORCA, ["worktree", "ps", "--json"], {
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

test("SMOKE: the response envelope is a property of the CLI, not of one command", { skip }, () => {
  // If this ever fails for a command, the boundary contract changed for ALL of them — which is the
  // whole reason unwrapOrca lives at the boundary instead of one parser per command.
  for (const argv of [["status"], ["repo", "list"], ["worktree", "list"], ["worktree", "ps"]]) {
    let stdout;
    try {
      stdout = execFileSync(ORCA, [...argv, "--json"], {
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
