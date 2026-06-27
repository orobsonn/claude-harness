#!/usr/bin/env node
/**
 * @description Dependency-free secret scanner for git/filesystem trees.
 *
 * Scans a directory for LEAKED secrets and reports findings. Never reads real
 * secret files (.dev.vars, .env, .env.*). Excludes doc paths (core/rules/,
 * *.md) when instructed via the `exclude` option.
 *
 * Detection uses two complementary strategies:
 *   1. Known-prefix patterns (ghp_, ghs_, sk- + 48 chars, etc.) — high-precision.
 *   2. High-entropy generic strings (32+ chars, mixed case + digit, entropy > 4.5).
 *
 * The mixed-case+digit gate on strategy 2 filters out code identifiers (camelCase
 * without digits), all-lowercase file paths, and all-uppercase env var names — all
 * of which appear in the harness source but are not secrets.
 *
 * CLI: exits non-zero when findings > 0 (usable as a CI step).
 * Library: export `scanSecretsInTree(rootDir, { exclude })` returning
 *   `{ findings: [...] }`.
 *
 * Heuristic single-line scan — does NOT detect tokens fragmented across
 * concatenated literals nor encoded/obfuscated secrets; defense-in-depth,
 * not a guarantee.
 *
 * @module scan-secrets-in-tree
 */

import { readFileSync, readdirSync, statSync, lstatSync } from "node:fs";
import { join, basename } from "node:path";

// ---------------------------------------------------------------------------
// Entropy helpers
// ---------------------------------------------------------------------------

/**
 * @description Calculates Shannon entropy (bits per character) of a string.
 * @param {string} str
 * @returns {number}
 */
function shannonEntropy(str) {
  const freq = new Map();
  for (const c of str) freq.set(c, (freq.get(c) || 0) + 1);
  const len = str.length;
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * @description Returns true when a candidate string passes the high-entropy
 * secret heuristic: at least 32 chars, mixed case, at least one digit,
 * and Shannon entropy > 4.5 bits/char.
 *
 * The mixed-case + digit requirement is critical for reducing false positives:
 *   - All-lowercase paths (claude/skills/...) → no uppercase → NOT flagged
 *   - All-uppercase env var names (ANTHROPIC_AUTH_TOKEN) → no digit+lowercase pair → NOT flagged
 *   - camelCase identifiers (setupFilesAfterEnv) → no digit → NOT flagged
 *   - Separator comments (// ------) → near-zero entropy → NOT flagged
 *
 * @param {string} value
 * @returns {boolean}
 */
function isHighEntropySecret(value) {
  if (value.length < 32) return false;
  const hasUpper = /[A-Z]/.test(value);
  const hasLower = /[a-z]/.test(value);
  const hasDigit = /[0-9]/.test(value);
  if (!hasUpper || !hasLower || !hasDigit) return false;
  return shannonEntropy(value) > 4.5;
}

// ---------------------------------------------------------------------------
// Detection patterns
// ---------------------------------------------------------------------------

/**
 * Known high-confidence secret patterns (prefix-based, no entropy check needed).
 * Each pattern is reset via lastIndex = 0 before use.
 */
const SECRET_PATTERNS = [
  { name: "GitHub PAT (ghp_)", re: /ghp_[A-Za-z0-9]{20,}/g },
  { name: "GitHub App secret (ghs_)", re: /ghs_[A-Za-z0-9]{20,}/g },
  { name: "GitHub OAuth token (gho_)", re: /gho_[A-Za-z0-9]{20,}/g },
  { name: "GitHub PAT v2 (github_pat_)", re: /github_pat_[A-Za-z0-9_]{59,}/g },
  // sk- with 48+ chars after the prefix (skips low-entropy placeholders like sk-realvalue123)
  { name: "OpenAI-style secret key (sk-)", re: /sk-[A-Za-z0-9]{48,}/g },
  { name: "Slack bot token (xoxb-)", re: /xoxb-[A-Za-z0-9-]{30,}/g },
  { name: "Slack user token (xoxp-)", re: /xoxp-[A-Za-z0-9-]{30,}/g },
  { name: "AWS access key (AKIA/ASIA)", re: /\bA(KIA|SIA)[0-9A-Z]{16}\b/g },
  { name: "OpenAI project key (sk-proj-)", re: /\bsk-proj-[A-Za-z0-9_-]{20,}\b/g },
];

/** @description Regex for generic high-entropy candidate substrings. */
const ENTROPY_RE = /[A-Za-z0-9+/=_-]{32,}/g;

// ---------------------------------------------------------------------------
// Exclusion logic
// ---------------------------------------------------------------------------

/**
 * @description Returns true when the given relative path should be skipped.
 *
 * Always skips:
 *   .git/, node_modules/, .dev.vars (exact), .env, .env.* (any .env prefix)
 *
 * Custom excludes (from the `exclude` option):
 *   - "some/dir/" (trailing slash) → skip any path starting with that prefix
 *   - "**\/*.ext" → skip any file whose name ends with .ext
 *
 * @param {string} relPath - Path relative to the scan root (using / separators).
 * @param {string[]} exclude - Custom exclusion patterns.
 * @returns {boolean}
 */
function shouldSkip(relPath, exclude) {
  const parts = relPath.split("/");
  const name = parts[parts.length - 1];

  // Always skip: VCS and dependency dirs
  if (parts[0] === ".git") return true;
  if (parts[0] === "node_modules") return true;
  if (parts.includes(".git")) return true;
  if (parts.includes("node_modules")) return true;

  // Always skip: real secret files (NEVER read them)
  if (name === ".dev.vars") return true;
  if (name.startsWith(".dev.vars")) return true;
  if (name === ".env") return true;
  if (name.startsWith(".env")) return true;
  if (name === ".envrc") return true;
  if (name.endsWith(".env")) return true;

  // Custom exclusion patterns
  for (const pattern of exclude) {
    if (pattern.endsWith("/")) {
      // Directory prefix exclusion (e.g. "core/rules/")
      const prefix = pattern.slice(0, -1);
      if (relPath === prefix || relPath.startsWith(prefix + "/")) return true;
    } else if (pattern.startsWith("**/")) {
      // Extension glob (e.g. "**/*.md")
      const suffix = pattern.slice(3); // "*.md" → "*.md"
      if (suffix.startsWith("*.")) {
        // Match files ending with the extension
        const ext = suffix.slice(1); // ".md"
        if (name.endsWith(ext)) return true;
      }
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Directory walker
// ---------------------------------------------------------------------------

/**
 * @description Recursively walks a directory and returns all file paths,
 * respecting the exclusion list.
 *
 * @param {string} absDir - Absolute path of the directory to walk.
 * @param {string} relBase - Relative prefix accumulated so far (for shouldSkip).
 * @param {string[]} exclude - Custom exclusion patterns.
 * @param {Array<{ full: string, rel: string }>} results - Accumulator.
 * @returns {Array<{ full: string, rel: string }>}
 */
function walkDir(absDir, relBase, exclude, results = []) {
  let entries;
  try {
    entries = readdirSync(absDir);
  } catch {
    return results;
  }

  for (const entry of entries) {
    const fullPath = join(absDir, entry);
    const relPath = relBase ? `${relBase}/${entry}` : entry;

    if (shouldSkip(relPath, exclude)) continue;

    let stat;
    try {
      stat = lstatSync(fullPath);
    } catch {
      continue;
    }

    if (stat.isSymbolicLink()) continue;

    if (stat.isDirectory()) {
      walkDir(fullPath, relPath, exclude, results);
    } else if (stat.isFile()) {
      results.push({ full: fullPath, rel: relPath });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Content scanner
// ---------------------------------------------------------------------------

/**
 * @description Scans a single file's text content for secret patterns.
 *
 * @param {string} content - File text.
 * @param {string} relPath - Relative path (used in finding reports).
 * @returns {Array<{ file: string, line: number, pattern: string, excerpt: string }>}
 */
function scanContent(content, relPath) {
  const findings = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Strategy 1: Known-prefix pattern matching
    for (const { name, re } of SECRET_PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line)) !== null) {
        findings.push({
          file: relPath,
          line: lineNum,
          pattern: name,
          excerpt: `<redacted: ${m[0].length} chars>`,
        });
      }
    }

    // Strategy 2: High-entropy generic strings
    ENTROPY_RE.lastIndex = 0;
    let m;
    while ((m = ENTROPY_RE.exec(line)) !== null) {
      if (isHighEntropySecret(m[0])) {
        findings.push({
          file: relPath,
          line: lineNum,
          pattern: "high-entropy string",
          excerpt: `<redacted: ${m[0].length} chars>`,
        });
      }
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Maximum file size to scan in bytes (5 MB). Larger files are skipped. */
const MAX_FILE_BYTES = 5_000_000;

/**
 * @description Scans a directory tree for leaked secrets.
 *
 * Never reads .dev.vars or .env* files (real-secret files).
 * Always skips .git/ and node_modules/.
 * Respects custom exclusion patterns in the `exclude` option.
 *
 * @param {string} rootDir - Absolute path to the root directory to scan.
 * @param {{ exclude?: string[] }} options
 *   - exclude: patterns to skip (dir/ prefixes or **\/*.ext globs).
 * @returns {{ findings: Array<{ file: string, line: number, pattern: string, excerpt: string }> }}
 */
export function scanSecretsInTree(rootDir, { exclude = [] } = {}) {
  const files = walkDir(rootDir, "", exclude);
  const allFindings = [];

  for (const { full, rel } of files) {
    try {
      if (statSync(full).size > MAX_FILE_BYTES) continue;
    } catch {
      continue;
    }

    let content;
    try {
      content = readFileSync(full, "utf8");
    } catch {
      // Skip unreadable files (binary, permission-denied, etc.)
      continue;
    }

    const fileFindings = scanContent(content, rel);
    allFindings.push(...fileFindings);
  }

  return { findings: allFindings };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

// When run directly: scan from the working directory, exit non-zero on findings.
// Excludes doc paths (core/rules/, **/*.md) consistent with the CI step intent.
if (import.meta.url === `file://${process.argv[1]}`) {
  const rootDir = process.cwd();
  const { findings } = scanSecretsInTree(rootDir, {
    exclude: ["core/rules/", "**/*.md"],
  });

  if (findings.length === 0) {
    process.stdout.write("[scan-secrets] No secrets detected.\n");
    process.exit(0);
  }

  process.stderr.write(
    `[scan-secrets] FAIL: ${findings.length} potential secret(s) detected:\n`
  );
  for (const f of findings) {
    process.stderr.write(`  ${f.file}:${f.line} [${f.pattern}] ${f.excerpt}\n`);
  }
  process.exit(1);
}
