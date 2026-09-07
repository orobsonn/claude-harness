/**
 * Resolve and provision the Pi runtime in a host-local cache. This module only
 * handles files and child processes; it never imports the installed Pi runtime.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { applyPiAuthPathPatch, verifyPiAuthPathPatch } from "./pi-auth-path-patch.mjs";

const RUNTIME_MANIFEST = "runtime-manifest.json";
const MANIFEST_FORMAT = 1;
const PINNED_PI_VERSION = "0.84.4";
const PINNED_SUBAGENTS_VERSION = "21.2.0";
const DEFAULT_LOCK_WAIT_MS = 150_000;
const DEFAULT_STALE_LOCK_MS = 120_000;
const DEFAULT_NPM_TIMEOUT_MS = 120_000;
const DEFAULT_SMOKE_TIMEOUT_MS = 30_000;

const DEFAULT_ASSETS_DIR = fileURLToPath(new URL("../runtime-deps/", import.meta.url));
const DEFAULT_OVERLAY_PATH = fileURLToPath(new URL("./pi-auth-path-patch.mjs", import.meta.url));

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isInside(root, path) {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function reason(error) {
  return error instanceof Error ? error.message : String(error);
}

function regularFile(path, label) {
  let info;
  try {
    info = lstatSync(path);
  } catch {
    throw new Error(`runtime-assets-missing:${label}`);
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`runtime-assets-invalid:${label}`);
  return readFileSync(path);
}

function defaultCacheRoot() {
  const xdg = process.env.XDG_CACHE_HOME;
  if (typeof xdg === "string" && isAbsolute(xdg)) return join(xdg, "claude-harness", "pi-runtime");
  return join(homedir(), ".cache", "claude-harness", "pi-runtime");
}

/**
 * All input bytes that affect a published cache tree. `overlayPath` is an
 * injection seam for tests; production always uses the sealed local overlay.
 */
function runtimeDefinition(options = {}) {
  const cacheRoot = options.cacheRoot === undefined ? defaultCacheRoot() : options.cacheRoot;
  const assetsDir = options.assetsDir === undefined ? DEFAULT_ASSETS_DIR : options.assetsDir;
  const overlayPath = options.overlayPath === undefined ? DEFAULT_OVERLAY_PATH : options.overlayPath;
  if (typeof cacheRoot !== "string" || !isAbsolute(cacheRoot)) throw new Error("runtime-cache-root-invalid");
  if (typeof assetsDir !== "string" || !isAbsolute(assetsDir)) throw new Error("runtime-assets-dir-invalid");
  if (typeof overlayPath !== "string" || !isAbsolute(overlayPath)) throw new Error("runtime-overlay-invalid");

  const packageBytes = regularFile(join(assetsDir, "package.json"), "package.json");
  const lockBytes = regularFile(join(assetsDir, "package-lock.json"), "package-lock.json");
  const overlayBytes = regularFile(overlayPath, "overlay");
  const input = {
    packageSha256: sha256(packageBytes),
    lockSha256: sha256(lockBytes),
    overlaySha256: sha256(overlayBytes),
    platform: process.platform,
    arch: process.arch,
    nodeAbi: process.versions.modules,
  };
  const generation = sha256(JSON.stringify(input));
  return {
    cacheRoot: resolve(cacheRoot),
    assetsDir: resolve(assetsDir),
    input,
    generation,
    cacheDir: join(resolve(cacheRoot), "generations", generation),
  };
}

function runtimePaths(cacheDir) {
  return {
    piCli: join(cacheDir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
    piPackage: join(cacheDir, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"),
    subagentsExtension: join(cacheDir, "node_modules", "@gotgenes", "pi-subagents", "src", "index.ts"),
    subagentsPackage: join(cacheDir, "node_modules", "@gotgenes", "pi-subagents", "package.json"),
  };
}

function safeRelative(path) {
  return typeof path === "string" && path.length > 0 && !isAbsolute(path) && !path.split(/[\\/]+/).includes("..");
}

function walkTree(root, current = root, entries = []) {
  const children = readdirSync(current, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const child of children) {
    const path = join(current, child.name);
    const rel = relative(root, path);
    const info = lstatSync(path);
    if (info.isDirectory()) {
      if (info.isSymbolicLink()) throw new Error(`directory-symlink:${rel}`);
      walkTree(root, path, entries);
      continue;
    }
    if (info.isFile() && !info.isSymbolicLink()) {
      if (rel !== RUNTIME_MANIFEST) entries.push({
        kind: "file",
        path: rel,
        sha256: sha256(readFileSync(path)),
        mode: info.mode & 0o777,
      });
      continue;
    }
    if (info.isSymbolicLink()) {
      if (dirname(path).split(sep).at(-1) !== ".bin") throw new Error(`unexpected-symlink:${rel}`);
      const target = realpathSync(path);
      if (!isInside(realpathSync(root), target)) throw new Error(`escaping-symlink:${rel}`);
      entries.push({ kind: "symlink", path: rel, target: readlinkSync(path) });
      continue;
    }
    throw new Error(`unsupported-runtime-entry:${rel}`);
  }
  return entries;
}

function sameEntry(left, right) {
  return left.kind === right.kind && left.path === right.path && left.sha256 === right.sha256 &&
    left.mode === right.mode && left.target === right.target;
}

function readPinnedManifest(path, expectedName, expectedVersion, label) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`invalid-${label}`);
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (manifest?.name !== expectedName || manifest?.version !== expectedVersion) {
    throw new Error(`invalid-${label}-version`);
  }
}

function validateCacheDirectory(definition, cacheDir) {
  let cacheInfo;
  try {
    cacheInfo = lstatSync(cacheDir);
  } catch {
    return { ok: false, reason: "runtime-cache-missing" };
  }
  if (!cacheInfo.isDirectory() || cacheInfo.isSymbolicLink()) {
    return { ok: false, reason: "runtime-cache-invalid:cache-dir" };
  }

  try {
    const manifestPath = join(cacheDir, RUNTIME_MANIFEST);
    const manifestInfo = lstatSync(manifestPath);
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) throw new Error("manifest");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest?.format !== MANIFEST_FORMAT || manifest.generation !== definition.generation ||
      JSON.stringify(manifest.input) !== JSON.stringify(definition.input) || !Array.isArray(manifest.files)) {
      throw new Error("manifest-input");
    }
    const expected = manifest.files;
    if (expected.some((entry) => !entry || !safeRelative(entry.path) ||
      !["file", "symlink"].includes(entry.kind))) throw new Error("manifest-entries");
    const actual = walkTree(cacheDir);
    if (expected.length !== actual.length || expected.some((entry, index) => !sameEntry(entry, actual[index]))) {
      throw new Error("tree-integrity");
    }

    const paths = runtimePaths(cacheDir);
    readPinnedManifest(paths.piPackage, "@earendil-works/pi-coding-agent", PINNED_PI_VERSION, "pi-package");
    readPinnedManifest(paths.subagentsPackage, "@gotgenes/pi-subagents", PINNED_SUBAGENTS_VERSION, "subagents-package");
    for (const [label, path] of Object.entries({ piCli: paths.piCli, subagentsExtension: paths.subagentsExtension })) {
      const info = lstatSync(path);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error(`invalid-${label}`);
    }
    const overlay = verifyPiAuthPathPatch(paths.piPackage, paths.subagentsPackage);
    if (!overlay.ok) throw new Error(`overlay:${overlay.reason}`);
    return { ok: true, paths, cacheDir, generation: definition.generation };
  } catch (error) {
    return { ok: false, reason: `runtime-cache-invalid:${reason(error)}` };
  }
}

function mkdirPrivate(path) {
  if (existsSync(path)) {
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("runtime-cache-root-invalid");
    return;
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("runtime-cache-root-invalid");
}

function lockIsStale(lockDir, staleLockMs) {
  let info;
  let owner;
  try {
    info = lstatSync(lockDir);
    if (!info.isDirectory() || info.isSymbolicLink()) return false;
    owner = JSON.parse(readFileSync(join(lockDir, "owner.json"), "utf8"));
  } catch {
    // A partial lock must age before recovery: never steal one that may still
    // be writing owner.json, but do not wait forever after its owner died.
    return Boolean(info) && Date.now() - info.mtimeMs > staleLockMs;
  }
  const age = Date.now() - info.mtimeMs;
  if (!owner || typeof owner !== "object" || Array.isArray(owner) ||
    typeof owner.host !== "string" || !Number.isInteger(owner.pid) || owner.pid <= 0) {
    return Number.isFinite(age) && age > staleLockMs;
  }
  if (owner.host === hostname() && Number.isInteger(owner.pid) && owner.pid > 0) {
    try {
      process.kill(owner.pid, 0);
      return false;
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ESRCH") return true;
      return false;
    }
  }
  return Number.isFinite(age) && age > staleLockMs;
}

function acquireLock(definition, options) {
  const locksDir = join(definition.cacheRoot, ".locks");
  mkdirPrivate(locksDir);
  const lockDir = join(locksDir, `${definition.generation}.lock`);
  const deadline = Date.now() + (options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS);
  const staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
  const token = randomUUID();
  while (Date.now() <= deadline) {
    try {
      mkdirSync(lockDir, { mode: 0o700 });
    } catch (error) {
      if (!error || typeof error !== "object" || error.code !== "EEXIST") {
        return { ok: false, reason: `runtime-lock-error:${reason(error)}` };
      }
      if (lockIsStale(lockDir, staleLockMs)) {
        try {
          renameSync(lockDir, `${lockDir}.stale-${Date.now()}-${randomUUID()}`);
          continue;
        } catch {
          // Another contender changed the lock. Re-read it after the short wait.
        }
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(100, Math.max(1, deadline - Date.now())));
      continue;
    }
    try {
      (options.writeLockOwner ?? writeFileSync)(
        join(lockDir, "owner.json"),
        JSON.stringify({ token, pid: process.pid, host: hostname(), createdAt: Date.now() }),
        { mode: 0o600 },
      );
      return { ok: true, lockDir, token };
    } catch (error) {
      // This directory was created by this attempt. `rmdir` only succeeds if
      // it remains empty, so an unexpected concurrent entry is preserved.
      try { rmdirSync(lockDir); } catch {}
      return { ok: false, reason: `runtime-lock-error:${reason(error)}` };
    }
  }
  return { ok: false, reason: "runtime-lock-timeout" };
}

function releaseLock(lock) {
  if (!lock?.lockDir) return;
  try {
    const ownerPath = join(lock.lockDir, "owner.json");
    const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
    if (owner.token !== lock.token) return;
    unlinkSync(ownerPath);
    rmdirSync(lock.lockDir);
  } catch {
    // Leaving an untrusted or contested lock in place is safer than removing it.
  }
}

function run(command, args, options) {
  const result = spawnSync(command, args, options);
  if (result.error?.code === "ETIMEDOUT") throw new Error("timeout");
  if (result.error) throw new Error(result.error.message);
  if (result.status !== 0) throw new Error(`exit-${result.status ?? "signal"}`);
}

function quarantineInvalidGeneration(definition) {
  let info;
  try {
    info = lstatSync(definition.cacheDir);
  } catch {
    return { ok: true };
  }
  const quarantined = `${definition.cacheDir}.invalid-${Date.now()}-${randomUUID()}`;
  try {
    // `rename` moves the exact cache entry without traversing a symlink. The
    // published generation is preserved for diagnosis and never overwritten.
    renameSync(definition.cacheDir, quarantined);
    return { ok: true, quarantined, type: info.isDirectory() ? "directory" : "entry" };
  } catch (error) {
    return { ok: false, reason: `runtime-quarantine-failed:${reason(error)}` };
  }
}

function provision(definition, options) {
  const generationsDir = join(definition.cacheRoot, "generations");
  mkdirPrivate(generationsDir);
  const staging = join(generationsDir, `.staging-${definition.generation}-${process.pid}-${randomUUID()}`);
  mkdirSync(staging, { mode: 0o700 });
  try {
    const copyFile = options.copyFile ?? copyFileSync;
    copyFile(join(definition.assetsDir, "package.json"), join(staging, "package.json"));
    copyFile(join(definition.assetsDir, "package-lock.json"), join(staging, "package-lock.json"));
    try {
      run(options.npmPath ?? "npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
        cwd: staging,
        encoding: "utf8",
        timeout: options.npmTimeoutMs ?? DEFAULT_NPM_TIMEOUT_MS,
      });
    } catch (error) {
      return { ok: false, reason: `runtime-npm-failed:${reason(error)}` };
    }

    const paths = runtimePaths(staging);
    applyPiAuthPathPatch(paths.piPackage, paths.subagentsPackage);
    run(process.execPath, [paths.piCli, "--version"], {
      cwd: staging,
      encoding: "utf8",
      timeout: options.smokeTimeoutMs ?? DEFAULT_SMOKE_TIMEOUT_MS,
    });
    const files = walkTree(staging);
    writeFileSync(join(staging, RUNTIME_MANIFEST), `${JSON.stringify({
      format: MANIFEST_FORMAT,
      generation: definition.generation,
      input: definition.input,
      files,
    }, null, 2)}\n`, { mode: 0o600 });
    const staged = validateCacheDirectory(definition, staging);
    if (!staged.ok) return staged;
    const existing = validateCacheDirectory(definition, definition.cacheDir);
    if (existing.ok) return existing;
    const quarantined = quarantineInvalidGeneration(definition);
    if (!quarantined.ok) return quarantined;
    try {
      renameSync(staging, definition.cacheDir);
    } catch (error) {
      const published = validateCacheDirectory(definition, definition.cacheDir);
      if (published.ok) return published;
      return { ok: false, reason: `runtime-publish-failed:${reason(error)}` };
    }
    return validateCacheDirectory(definition, definition.cacheDir);
  } catch (error) {
    return { ok: false, reason: `runtime-provision-failed:${reason(error)}` };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Read and verify the one cache generation selected by the runtime assets and
 * host ABI. It has no fallback to project, npx, or globally-installed packages.
 *
 * @param {{cacheRoot?: string, assetsDir?: string, overlayPath?: string}} [options]
 */
export function resolveVerifiedPiRuntime(options = {}) {
  try {
    const definition = runtimeDefinition(options);
    return validateCacheDirectory(definition, definition.cacheDir);
  } catch (error) {
    return { ok: false, reason: reason(error) };
  }
}

/**
 * Provision the selected generation if it is not already verified. Installation
 * is synchronous so existing Pi launcher callers can remain synchronous.
 *
 * @param {{cacheRoot?: string, assetsDir?: string, overlayPath?: string, npmPath?: string, lockWaitMs?: number, staleLockMs?: number, npmTimeoutMs?: number, smokeTimeoutMs?: number, copyFile?: typeof copyFileSync, writeLockOwner?: typeof writeFileSync}} [options]
 */
export function ensurePiRuntime(options = {}) {
  const resolved = resolveVerifiedPiRuntime(options);
  if (resolved.ok) return resolved;
  let definition;
  try {
    definition = runtimeDefinition(options);
    mkdirPrivate(definition.cacheRoot);
  } catch (error) {
    return { ok: false, reason: reason(error) };
  }
  const lock = acquireLock(definition, options);
  if (!lock.ok) return lock;
  try {
    const afterLock = validateCacheDirectory(definition, definition.cacheDir);
    if (afterLock.ok) return afterLock;
    return provision(definition, options);
  } finally {
    releaseLock(lock);
  }
}
