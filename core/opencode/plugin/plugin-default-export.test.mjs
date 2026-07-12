/**
 * @description Every plugin path in opencode.json.example must default-export a function (OC load contract).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const example = join(root, "core/opencode/opencode.json.example");

test("all opencode.json.example plugins have default export function", async () => {
  const cfg = JSON.parse(readFileSync(example, "utf8"));
  const plugins = cfg.plugin || [];
  assert.ok(plugins.length >= 8, "expected obs + core plugins");
  for (const rel of plugins) {
    // ./.opencode/plugin/foo.ts → core/opencode/plugin/foo.ts in monorepo source
    const name = rel.replace("./.opencode/plugin/", "");
    const abs = join(root, "core/opencode/plugin", name);
    const mod = await import(pathToFileURL(abs).href);
    assert.equal(
      typeof mod.default,
      "function",
      `${rel} missing default export function`,
    );
  }
});
