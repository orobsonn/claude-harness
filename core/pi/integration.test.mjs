import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import test from "node:test";

import { verifyPiHarness } from "./bin/pi-harness.mjs";

const ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));

test("preflight verifies the pinned Pi runtime and all canonical role assets", () => {
  assert.deepEqual(verifyPiHarness(ROOT), {
    ok: true,
    runtimeVersion: "0.84.4",
    roles: 10,
  });
});

test("launcher offers a provider-free preflight for the Orca terminal", () => {
  const result = spawnSync(process.execPath, ["core/pi/bin/pi-harness.mjs", "--verify"], {
    cwd: ROOT,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, runtimeVersion: "0.84.4", roles: 10 });
});
