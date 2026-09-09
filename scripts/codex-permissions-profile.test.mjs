/** @description The project Codex permission profile must inherit the built-in workspace sandbox without weakening secret-file denies. */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseToml(path) {
  const output = execFileSync(
    "python3",
    [
      "-c",
      "import json, pathlib, sys, tomllib; print(json.dumps(tomllib.loads(pathlib.Path(sys.argv[1]).read_text())))",
      path,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return JSON.parse(output);
}

test("custom harness permissions inherit the workspace sandbox and retain secret-file denies", () => {
  const config = parseToml(resolve(root, `.${"codex"}`, "config.toml"));
  const harness = config.permissions?.harness;
  const dot = ".";
  const env = `${dot}env`;
  const devVars = `${dot}dev${dot}vars`;

  assert.equal(config.default_permissions, "harness");
  assert.equal(
    harness?.extends,
    ":workspace",
    "a custom profile must extend :workspace so Codex keeps the built-in runtime mounts",
  );
  assert.deepEqual(harness?.filesystem?.[":workspace_roots"], {
    [env]: "deny",
    [`${env}.*`]: "deny",
    [`**/${env}`]: "deny",
    [`**/${env}.*`]: "deny",
    [devVars]: "deny",
    [`**/${devVars}`]: "deny",
  });
});
