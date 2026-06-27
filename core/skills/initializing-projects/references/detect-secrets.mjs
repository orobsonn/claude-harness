#!/usr/bin/env node
/**
 * @description Detects required secret names from .dev.vars.example, .env.example,
 * and wrangler.jsonc in a given project directory. Emits only secret NAMES, never
 * values. Returns a setup guide listing `gh secret set <NAME>` for each detected
 * secret. Uses Node builtins only; never reads real secret files (.dev.vars, .env).
 *
 * @param {string} projectDir - Absolute or relative path to the project root.
 * @returns {{ secrets: string[], setupGuide: string }}
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Keys that must never appear as secret names (prototype pollution guard). */
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * @description Strips JSONC single-line (//) and block (/* *\/) comments from a
 * string without using eval, Function, or dynamic require. Handles strings
 * containing comment-like sequences safely.
 *
 * @param {string} text - Raw JSONC text.
 * @returns {string} JSON-safe text with comments removed.
 */
function stripJsoncComments(text) {
  let result = "";
  let i = 0;
  let inString = false;
  let inEscape = false;

  while (i < text.length) {
    const ch = text[i];

    if (inEscape) {
      result += ch;
      inEscape = false;
      i++;
      continue;
    }

    if (inString) {
      if (ch === "\\") {
        inEscape = true;
        result += ch;
        i++;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      result += ch;
      i++;
      continue;
    }

    // Not in a string — check for comment openers
    if (ch === "/" && text[i + 1] === "/") {
      // Single-line comment: skip to end of line
      while (i < text.length && text[i] !== "\n") {
        i++;
      }
      continue;
    }

    if (ch === "/" && text[i + 1] === "*") {
      // Block comment: skip to closing */
      i += 2;
      while (i < text.length) {
        if (text[i] === "*" && text[i + 1] === "/") {
          i += 2;
          break;
        }
        i++;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    }

    result += ch;
    i++;
  }

  return result;
}

/**
 * @description Parses a JSONC file and extracts var keys from its `vars` block.
 * Never throws — returns an empty array on any parse failure or missing `vars`.
 * Filters dangerous prototype-pollution keys.
 *
 * @param {string} content - Raw JSONC file content.
 * @returns {string[]} Array of variable names found in the `vars` object.
 */
function extractVarsFromJsonc(content) {
  try {
    const stripped = stripJsoncComments(content);
    const parsed = JSON.parse(stripped);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return [];
    }
    const vars = parsed.vars;
    if (!vars || typeof vars !== "object" || Array.isArray(vars)) {
      return [];
    }
    return Object.keys(vars).filter(
      (k) => !DANGEROUS_KEYS.has(k) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)
    );
  } catch {
    // Malformed or crafted JSONC — return nothing, never throw
    return [];
  }
}

/**
 * @description Parses a `.env`-style example file and extracts variable names.
 * Skips blank lines and lines starting with `#`. Emits only the name
 * (left of `=`), never the value.
 *
 * @param {string} content - File content.
 * @returns {string[]} Array of variable names.
 */
function extractNamesFromEnvFile(content) {
  const names = [];
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIndex = line.indexOf("=");
    if (eqIndex === -1) continue;
    const raw = line.slice(0, eqIndex).trim();
    const name = raw.startsWith("export ") ? raw.slice(7).trim() : raw;
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      names.push(name);
    }
  }
  return names;
}

/**
 * @description Detects required secret names from example/config files in a
 * project directory. Sources checked: `.dev.vars.example`, `.env.example`,
 * `wrangler.jsonc`. Real secret files (`.dev.vars`, `.env`) are never read.
 *
 * @param {string} projectDir - Path to the project root.
 * @returns {{ secrets: string[], setupGuide: string }}
 */
export function detectRequiredSecrets(projectDir) {
  const collected = new Set();

  // Source 1: .dev.vars.example (env-style, names only)
  const devVarsExamplePath = join(projectDir, ".dev.vars.example");
  if (existsSync(devVarsExamplePath)) {
    const content = readFileSync(devVarsExamplePath, "utf8");
    for (const name of extractNamesFromEnvFile(content)) {
      collected.add(name);
    }
  }

  // Source 2: .env.example (env-style, names only)
  const envExamplePath = join(projectDir, ".env.example");
  if (existsSync(envExamplePath)) {
    const content = readFileSync(envExamplePath, "utf8");
    for (const name of extractNamesFromEnvFile(content)) {
      collected.add(name);
    }
  }

  // Source 3: wrangler.jsonc vars block (JSONC — strip comments, no eval)
  const wranglerPath = join(projectDir, "wrangler.jsonc");
  if (existsSync(wranglerPath)) {
    const content = readFileSync(wranglerPath, "utf8");
    for (const name of extractVarsFromJsonc(content)) {
      collected.add(name);
    }
  }

  const secrets = Array.from(collected);

  if (secrets.length === 0) {
    return { secrets: [], setupGuide: "" };
  }

  const setupGuide = secrets.map((name) => `gh secret set ${name}`).join("\n");

  return { secrets, setupGuide };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

// When run directly: print detected secrets as JSON to stdout.
// Includes secrets[] and setupGuide (gh secret set commands).
// Usage: node detect-secrets.mjs [--target <project-dir>]
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let target = process.cwd();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--target" && args[i + 1] !== undefined) {
      target = args[++i];
    }
  }
  const result = detectRequiredSecrets(target);
  process.stdout.write(JSON.stringify(result) + "\n");
}
