/** @description Host-owned dirty-worktree snapshots for exact Task completion attribution. */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const BASELINE_VERSION = 1;
const MAX_BASELINE_PATHS = 10_000;

function relativeTarget(projectRoot, relativePath) {
  if (typeof projectRoot !== "string" || !projectRoot || typeof relativePath !== "string" || !relativePath || path.isAbsolute(relativePath)) return null;
  const root = path.resolve(projectRoot);
  const target = path.resolve(root, relativePath);
  return target.startsWith(`${root}${path.sep}`) ? target : null;
}

function sameStat(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function fingerprint(projectRoot, relativePath) {
  const target = relativeTarget(projectRoot, relativePath);
  if (!target) return null;
  let first;
  try { first = fs.lstatSync(target); } catch (error) {
    return error && typeof error === "object" && error.code === "ENOENT" ? { kind: "absent" } : null;
  }
  try {
    if (first.isFile()) {
      const bytes = fs.readFileSync(target);
      const second = fs.lstatSync(target);
      if (!sameStat(first, second) || !second.isFile()) return null;
      return { kind: "file", mode: first.mode & 0o777, size: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
    }
    if (first.isSymbolicLink()) {
      const targetText = fs.readlinkSync(target);
      const second = fs.lstatSync(target);
      if (!sameStat(first, second) || !second.isSymbolicLink()) return null;
      const bytes = Buffer.from(targetText);
      return { kind: "symlink", mode: first.mode & 0o777, size: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
    }
  } catch { /* an unstable path is deliberately not suppressible */ }
  return null;
}

function parseNulPaths(output) {
  return Buffer.from(output ?? "").toString("utf8").split("\0").filter(Boolean);
}

function gitPaths(projectRoot, args) {
  try {
    return { ok: true, paths: parseNulPaths(execFileSync("git", args, { cwd: projectRoot, encoding: "buffer", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 })) };
  } catch { return { ok: false, paths: [] }; }
}

/** @description Read dirty tracked and ordinary untracked paths; partial Git failure is explicit. */
export function listGitTouchedPaths(projectRoot) {
  const tracked = gitPaths(projectRoot, ["diff", "--name-only", "-z", "HEAD"]);
  const untracked = gitPaths(projectRoot, ["ls-files", "--others", "--exclude-standard", "-z"]);
  return { ok: tracked.ok && untracked.ok, paths: [...new Set([...tracked.paths, ...untracked.paths])].sort() };
}

function validFingerprint(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (value.kind === "absent") return Object.keys(value).length === 1;
  return ["file", "symlink"].includes(value.kind) && Number.isInteger(value.mode) && value.mode >= 0 && value.mode <= 0o777 && Number.isInteger(value.size) && value.size >= 0 && typeof value.sha256 === "string" && /^[0-9a-f]{64}$/.test(value.sha256) && Object.keys(value).length === 4;
}

/** @description Validate a versioned host snapshot; invalid data never suppresses a touched path. */
export function isValidWorktreeBaseline(value, projectRoot) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== BASELINE_VERSION || !Array.isArray(value.entries) || value.entries.length > MAX_BASELINE_PATHS) return false;
  let prior = "";
  for (const entry of value.entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.path !== "string" || !relativeTarget(projectRoot, entry.path) || !validFingerprint(entry.fingerprint) || Object.keys(entry).length !== 2 || entry.path <= prior) return false;
    prior = entry.path;
  }
  return true;
}

/** @description Snapshot the exact pre-dispatch dirty set; unstable Git or files leave no suppressible baseline. */
export function snapshotWorktreeBaseline(projectRoot) {
  const first = listGitTouchedPaths(projectRoot);
  if (!first.ok || first.paths.length > MAX_BASELINE_PATHS) return null;
  const entries = [];
  for (const relativePath of first.paths) {
    const value = fingerprint(projectRoot, relativePath);
    if (value) entries.push({ path: relativePath, fingerprint: value });
  }
  const second = listGitTouchedPaths(projectRoot);
  if (!second.ok || first.paths.length !== second.paths.length || first.paths.some((entry, index) => entry !== second.paths[index])) return null;
  for (const entry of entries) {
    const after = fingerprint(projectRoot, entry.path);
    if (!after || JSON.stringify(after) !== JSON.stringify(entry.fingerprint)) return null;
  }
  return { version: BASELINE_VERSION, entries };
}

/** @description Return only paths whose state changed after the exact dispatch snapshot. */
export function pathsChangedSinceBaseline(projectRoot, baseline) {
  const current = listGitTouchedPaths(projectRoot);
  if (!current.ok || !isValidWorktreeBaseline(baseline, projectRoot)) return current.paths;
  const entries = new Map(baseline.entries.map((entry) => [entry.path, entry.fingerprint]));
  const candidates = new Set([...current.paths, ...entries.keys()]);
  const changed = [];
  for (const relativePath of [...candidates].sort()) {
    const before = entries.get(relativePath);
    if (!before) {
      changed.push(relativePath);
      continue;
    }
    const after = fingerprint(projectRoot, relativePath);
    if (!after || JSON.stringify(before) !== JSON.stringify(after)) changed.push(relativePath);
  }
  return changed;
}
