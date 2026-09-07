#!/usr/bin/env node
/**
 * Claude Harness v2.4.2 — vendored Pi entry point.
 * Runs the LOCAL launcher under .pi/harness/bin/. No download, no network: @earendil-works/pi-coding-agent
 * and @gotgenes/pi-subagents are resolved from the verified user/host runtime cache.
 * Every flag, --verify included, is forwarded verbatim.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const launcher = join(dirname(fileURLToPath(import.meta.url)), "bin", "pi-harness.mjs");
const result = spawnSync(process.execPath, [launcher, ...process.argv.slice(2)], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
