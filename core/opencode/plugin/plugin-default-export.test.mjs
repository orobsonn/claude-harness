/**
 * @description Every plugin path in opencode.json.example AND root opencode.json must
 * (1) exist under the corresponding runtime tree and (2) default-export a function.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

async function assertPlugins(cfgPath, resolvePluginAbs) {
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  const plugins = cfg.plugin || [];
  assert.ok(plugins.length >= 8, `${cfgPath}: expected plugins`);
  for (const rel of plugins) {
    const abs = resolvePluginAbs(rel);
    assert.ok(existsSync(abs), `missing plugin file for ${rel} → ${abs}`);
    const mod = await import(pathToFileURL(abs).href);
    assert.equal(typeof mod.default, "function", `${rel} missing default export`);
  }
}

test("core/opencode/opencode.json.example plugins load from core/opencode/plugin", async () => {
  await assertPlugins(join(root, "core/opencode/opencode.json.example"), (rel) => {
    const name = rel.replace("./.opencode/plugin/", "");
    return join(root, "core/opencode/plugin", name);
  });
});

test("root opencode.json plugins exist under .opencode/plugin and default-export", async () => {
  const cfgPath = join(root, "opencode.json");
  if (!existsSync(cfgPath)) {
    // monorepo may not commit root config in all checkouts — skip soft
    return;
  }
  await assertPlugins(cfgPath, (rel) => {
    // ./.opencode/plugin/foo.ts → <root>/.opencode/plugin/foo.ts
    const name = rel.replace(/^\.\//, "");
    return join(root, name);
  });
});
