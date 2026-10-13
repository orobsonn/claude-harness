#!/usr/bin/env node
/** Attach failure notifications without replacing the project's configured reporters. */
import path from "node:path";
import { pathToFileURL } from "node:url";
import ShardFailureReporter from "../lib/vitest-shard-reporter.mjs";

process.env.TEST = "true";
process.env.VITEST = "true";
process.env.NODE_ENV ??= "test";
let context;
try {
  const { createVitest, parseCLI } = await import(pathToFileURL(path.join(process.cwd(), "node_modules/vitest/dist/node.js")).href);
  const { filter, options } = parseCLI(["vitest", "run", ...process.argv.slice(2)]);
  context = await createVitest("test", { ...options, run: true, watch: false });
  context.reporters.push(new ShardFailureReporter());
  await context.start(filter);
} catch (error) {
  process.exitCode = 1;
  console.error(error?.stack ?? error);
} finally {
  await context?.close();
  if (process.connected) process.disconnect();
}
