import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";

import { verifyPiHarness } from "./bin/pi-harness.mjs";

const ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));

test("preflight verifies the pinned Pi runtime and all canonical role assets", () => {
  assert.deepEqual(verifyPiHarness(ROOT), {
    ok: true,
    runtimeVersion: "0.84.4",
    subagentsVersion: "21.2.0",
    roles: 10,
  });
});

test("launcher offers a provider-free preflight for the Orca terminal", () => {
  const result = spawnSync(process.execPath, ["core/pi/bin/pi-harness.mjs", "--verify"], {
    cwd: ROOT,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true,
    runtimeVersion: "0.84.4",
    subagentsVersion: "21.2.0",
    roles: 10,
  });
});

test("published bin entry executes through its npm symlink", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-harness-bin-test-"));
  const launcher = join(directory, "pi-harness");
  try {
    symlinkSync(resolve(ROOT, "core/pi/bin/pi-harness.mjs"), launcher);
    const result = spawnSync(process.execPath, [launcher, "--verify"], {
      cwd: ROOT,
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      runtimeVersion: "0.84.4",
      subagentsVersion: "21.2.0",
      roles: 10,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Pi runtime's Node requirement is reflected by the published package", () => {
  const manifest = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
  assert.equal(manifest.engines.node, ">=22.19.0");
});
