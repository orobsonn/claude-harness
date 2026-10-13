import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import http from "node:http";
import vm from "node:vm";
import { patchMiniflareLoopback } from "./patch-miniflare-loopback.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "miniflare-backport-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "node_modules/miniflare");
  fs.mkdirSync(path.join(directory, "dist/src"), { recursive: true });
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name: "miniflare", version: "4.20250906.0" }));
  // Use the audited block from the executable source; independently check its
  // resulting behavior against a real HTTP server below and in the consumer.
  const module = fs.readFileSync(new URL("./patch-miniflare-loopback.mjs", import.meta.url), "utf8");
  const block = /const BEFORE = `([\s\S]*?)`;/.exec(module)[1];
  const file = path.join(directory, "dist/src/index.js");
  fs.writeFileSync(file, "prefix\n" + block + "\nsuffix\n");
  return { root, directory, file };
}

test("backport changes only the loopback keep-alive timeout and is idempotent", (t) => {
  const f = fixture(t);
  assert.equal(patchMiniflareLoopback(f.root).status, "patched");
  const source = fs.readFileSync(f.file, "utf8");
  assert.match(source, /server.keepAliveTimeout = 0;/);
  assert.ok(source.startsWith("prefix\n") && source.endsWith("\nsuffix\n"));
  assert.equal(patchMiniflareLoopback(f.root).status, "already-patched");
  assert.equal(fs.readFileSync(f.file, "utf8"), source);
});

test("unknown versions and unexpected bundle contents are refused without mutation", (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.file, "unknown bundle");
  assert.throws(() => patchMiniflareLoopback(f.root), /differs/);
  assert.equal(fs.readFileSync(f.file, "utf8"), "unknown bundle");
  fs.writeFileSync(path.join(f.directory, "package.json"), JSON.stringify({ name: "miniflare", version: "5.0.0" }));
  assert.throws(() => patchMiniflareLoopback(f.root), /supports only/);
  assert.equal(fs.readFileSync(f.file, "utf8"), "unknown bundle");
});

test("the patched loopback method disables the timeout on a real HTTP server", async (t) => {
  const f = fixture(t);
  const start = async () => {
    const block = /  #startLoopbackServer\(hostname\) \{[\s\S]*?\n  \}/.exec(fs.readFileSync(f.file, "utf8"))[0];
    const Factory = vm.runInNewContext(`(class {
      #handleLoopback(_request, response) { response.end('ok'); }
      #handleLoopbackUpgrade() {}
      ${block}
      start() { return this.#startLoopbackServer('127.0.0.1'); }
    })`, { import_http6: { default: http }, import_stoppable: { default: (server) => server } });
    const server = await new Factory().start();
    t.after(() => new Promise((resolve) => server.close(resolve)));
    return server;
  };
  assert.ok((await start()).keepAliveTimeout > 0, "stock Node loopback closes idle sockets");
  patchMiniflareLoopback(f.root);
  assert.equal((await start()).keepAliveTimeout, 0);
});
