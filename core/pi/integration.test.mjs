import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";

import { buildPiHarnessInvocation, verifyPiHarness } from "./bin/pi-harness.mjs";

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


test("nenhum gate fica de fora do launcher: toda extensão do pacote é carregada", () => {
  const declared = new Set(
    readdirSync(resolve(ROOT, "core/pi/extensions"))
      .filter((name) => name.endsWith(".ts"))
      .map((name) => `core/pi/extensions/${name}`),
  );
  const invocation = buildPiHarnessInvocation({ root: ROOT, argv: [], env: {} });
  const loaded = new Set(
    invocation.args
      .filter((arg, index) => invocation.args[index - 1] === "-e")
      .map((path) => path.startsWith(ROOT) ? path.slice(ROOT.length + 1) : path),
  );

  for (const extension of declared) {
    assert.equal(loaded.has(extension), true, `${extension} não é carregada pelo launcher`);
  }
});

test("preflight nomeia a primeira peça ausente em vez de subir um harness sem gate", () => {
  const empty = mkdtempSync(join(tmpdir(), "pi-harness-empty-root-"));
  try {
    const result = verifyPiHarness(empty);
    assert.equal(result.ok, false);
    assert.match(result.reason, /^missing:/);
    assert.match(result.reason, /harness-policy\.ts$/, "policy é a primeira extensão exigida");
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("o preflight cobre cada lib do porte", () => {
  // O preflight para na PRIMEIRA ausência, então a garantia útil é de lista: toda lib .mjs do
  // pacote (fora de teste) precisa estar exigida pelo launcher, ou some sem barulho no vendor.
  const launcher = readFileSync(resolve(ROOT, "core/pi/bin/pi-harness.mjs"), "utf8");
  for (const name of readdirSync(resolve(ROOT, "core/pi/lib"))) {
    if (!name.endsWith(".mjs") || name.endsWith(".test.mjs")) continue;
    assert.match(launcher, new RegExp(`core/pi/lib/${name.replace(".", "\\.")}`), `${name} não é exigida pelo preflight`);
  }
});
