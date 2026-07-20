/**
 * @description Every auto-globbed plugin under core/opencode/plugin (and the dogfood
 * .opencode/plugin tree) must default-export a function, and harness paths must stay
 * absent from opencode.json plugin[] so OC loads each factory exactly once.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * OpenCode auto-globs `.opencode/plugin/*.{ts,js}`; harness paths are deliberately absent
 * from opencode.json plugin[] (#402 — listing them registered every hook factory twice).
 * The contract to protect is therefore the plugin DIRECTORY: every auto-loaded file must
 * default-export a function, since OC will import all of them.
 */
async function assertPluginDir(pluginDir) {
  assert.ok(existsSync(pluginDir), `missing plugin dir ${pluginDir}`);
  const files = readdirSync(pluginDir).filter((name) => /\.(ts|js)$/.test(name));
  assert.ok(files.length >= 8, `${pluginDir}: expected auto-globbed plugins, got ${files.length}`);
  for (const name of files) {
    const mod = await import(pathToFileURL(join(pluginDir, name)).href);
    assert.equal(typeof mod.default, "function", `${name} missing default export`);
  }
}

async function assertNoHarnessPluginPaths(cfgPath) {
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  const listed = (cfg.plugin || []).filter((rel) => rel.includes(".opencode/plugin/"));
  assert.deepEqual(listed, [], `${cfgPath}: harness plugin paths must stay unlisted (OC auto-globs them)`);
}

test("core/opencode/plugin files auto-glob cleanly and stay unlisted in opencode.json.example", async () => {
  await assertPluginDir(join(root, "core/opencode/plugin"));
  await assertNoHarnessPluginPaths(join(root, "core/opencode/opencode.json.example"));
});

test("dogfood .opencode/plugin auto-globs cleanly and stays unlisted in root opencode.json", async () => {
  const cfgPath = join(root, "opencode.json");
  if (!existsSync(cfgPath)) {
    // monorepo may not commit root config in all checkouts — skip soft
    return;
  }
  await assertNoHarnessPluginPaths(cfgPath);
  // Dogfood .opencode/ is gitignored in this monorepo (source of truth = core/opencode/).
  // Soft-skip when not vendored locally; CI fresh checkout has no .opencode/plugin.
  const dogfoodPluginDir = join(root, ".opencode", "plugin");
  if (!existsSync(dogfoodPluginDir)) {
    return;
  }
  await assertPluginDir(dogfoodPluginDir);
});
