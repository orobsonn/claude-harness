#!/usr/bin/env node
/** Explicit backport of cloudflare/workers-sdk#14850 for the pinned test runtime. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SUPPORTED_VERSION = "4.20250906.0";
const BEFORE = `  #startLoopbackServer(hostname) {
    if (hostname === "*") hostname = "::";
    return new Promise((resolve5) => {
      const server = (0, import_stoppable.default)(
        import_http6.default.createServer(this.#handleLoopback),
        /* grace */
        0
      );
      server.on("upgrade", this.#handleLoopbackUpgrade);
      server.listen(0, hostname, () => resolve5(server));
    });
  }`;
const AFTER = BEFORE.replace('      server.on("upgrade",',
  '      // Backport: https://github.com/cloudflare/workers-sdk/pull/14850\n      server.keepAliveTimeout = 0;\n      server.on("upgrade",');

export function patchMiniflareLoopback(projectRoot = process.cwd()) {
  const directory = path.join(projectRoot, "node_modules/miniflare");
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
  if (manifest.name !== "miniflare" || manifest.version !== SUPPORTED_VERSION) {
    throw new Error(`Miniflare backport supports only ${SUPPORTED_VERSION}; review/remove it when upgrading`);
  }
  const file = path.join(directory, "dist/src/index.js");
  if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw new Error("Miniflare bundle must be a regular file");
  const source = fs.readFileSync(file, "utf8");
  if (source.includes(AFTER)) return { status: "already-patched", version: manifest.version };
  if (source.split(BEFORE).length !== 2) throw new Error("Miniflare loopback code differs from the audited upstream backport");
  fs.writeFileSync(file, source.replace(BEFORE, AFTER));
  return { status: "patched", version: manifest.version };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log("[miniflare-loopback] " + JSON.stringify(patchMiniflareLoopback())); }
  catch (error) { console.error("[miniflare-loopback] " + error.message); process.exitCode = 1; }
}
