#!/usr/bin/env node
/** Attach failure notifications without replacing the project's configured reporters. */
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ShardFailureReporter from "../lib/vitest-shard-reporter.mjs";

process.env.TEST = "true";
process.env.VITEST = "true";
process.env.NODE_ENV ??= "test";
const requireProject = createRequire(path.join(process.cwd(), "package.json"));
let context;
try {
  const { createVitest, parseCLI } = await import(pathToFileURL(requireProject.resolve("vitest/node")).href);
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
