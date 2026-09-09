import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function parseConfig(bytes) {
  const config = JSON.parse(bytes);
  const limit = config?.maxParallelEyes;
  if (!config || Array.isArray(config) || !Number.isInteger(limit) || limit < 1 || limit > 3) {
    throw new Error("harness-config: maxParallelEyes must be an integer from 1 to 3");
  }
  return { maxParallelEyes: limit };
}

/** Read-only runtime configuration; never changes an operator's choice. */
export function readPiReviewConfig(runtimeDir) {
  const path = join(runtimeDir, "harness.json");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("harness-config: regular file required");
  return parseConfig(readFileSync(path, "utf8"));
}

/** Bootstrap a missing config, then validate existing bytes without rewriting them. */
export function materializePiReviewConfig(runtimeDir, defaultsPath) {
  try { return readPiReviewConfig(runtimeDir); } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const bytes = readFileSync(defaultsPath, "utf8");
  parseConfig(bytes);
  mkdirSync(runtimeDir, { recursive: true });
  try { writeFileSync(join(runtimeDir, "harness.json"), bytes, { mode: 0o600, flag: "wx" }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  return readPiReviewConfig(runtimeDir);
}
