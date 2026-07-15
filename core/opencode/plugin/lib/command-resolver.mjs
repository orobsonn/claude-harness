/** @description Closed denied-command registry, canonical locked-test selection, and FD-pinned Vitest execution. */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const DENIED_CLASS = Object.freeze({ PACKAGE_LAUNCHER: "package_launcher", INTERPRETER: "interpreter", TARGETED_VITEST: "targeted_vitest" });
export const VITEST_REGISTRY_ID = "vitest.targeted.v1";
const TEST_FILE = /(?:^|\/)[^/]+\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/;
const GLOB_OR_META = /[*?\[\]{}!;&|`$()<>\n\r\0'"\\]/;

/** @description Accept one canonical repo-relative test file path, not an argv token or directory. */
export function normalizeTestPath(value) {
  if (typeof value !== "string" || !value || value.startsWith("-") || GLOB_OR_META.test(value)) return null;
  if (path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.split("/").includes("..")) return null;
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === "." || !TEST_FILE.test(normalized)) return null;
  return normalized;
}

/** @description Return a registry id only for exact launcher/interpreter equivalence shapes. */
export function registeredEquivalent(deniedClass, command, requestedTestPath) {
  const requested = normalizeTestPath(requestedTestPath);
  if (!requested) return null;
  if (deniedClass === DENIED_CLASS.TARGETED_VITEST && (!command || command === "vitest")) return { registry_id: VITEST_REGISTRY_ID, test_path: requested };
  if (typeof command !== "string" || !command.trim() || /[;&|`$(){}<>\n\r\0'"\\]/.test(command)) return null;
  const argv = command.trim().split(/\s+/);
  let candidate = null;
  if (deniedClass === DENIED_CLASS.PACKAGE_LAUNCHER) {
    if (argv[0] === "npx") {
      const offset = argv[1] === "--no-install" ? 2 : 1;
      if (argv[offset] === "vitest" && argv[offset + 1] === "run" && argv.length === offset + 3) candidate = argv[offset + 2];
    } else if (argv[0] === "bunx" && argv[1] === "vitest" && argv[2] === "run" && argv.length === 4) candidate = argv[3];
    else if (argv[0] === "pnpm" && argv[1] === "dlx" && argv[2] === "vitest" && argv[3] === "run" && argv.length === 5) candidate = argv[4];
    else if (argv[0] === "npm" && argv[1] === "exec" && argv[2] === "vitest" && argv[3] === "--" && argv[4] === "run" && argv.length === 6) candidate = argv[5];
  } else if (deniedClass === DENIED_CLASS.INTERPRETER) {
    const script = argv[1]?.replace(/^\.\//, "");
    if (argv[0] === "node" && ["node_modules/.bin/vitest", "node_modules/vitest/vitest.mjs"].includes(script) && argv[2] === "run" && argv.length === 4) candidate = argv[3];
  }
  return normalizeTestPath(candidate) === requested ? { registry_id: VITEST_REGISTRY_ID, test_path: requested } : null;
}

/** @description Select exactly one canonical locked_tests[].path from the immutable task snapshot. */
export function selectLockedTest(task, requestedPath, projectRoot, io = fs) {
  const requested = normalizeTestPath(requestedPath);
  if (!requested || !task || typeof task !== "object" || !Array.isArray(task.locked_tests)) return { ok: false, reason: "canonical locked test path required" };
  const normalized = [];
  for (const entry of task.locked_tests) {
    if (!entry || typeof entry !== "object" || typeof entry.path !== "string") continue;
    const candidate = normalizeTestPath(entry.path);
    if (!candidate) return { ok: false, reason: "bound locked_tests contains a non-canonical path" };
    normalized.push(candidate);
  }
  if (!new Set(normalized).has(requested)) return { ok: false, reason: "locked test target missing" };
  try {
    const root = io.realpathSync(projectRoot);
    const absolute = path.join(root, requested);
    const stat = io.lstatSync(absolute);
    if (!stat.isFile()) return { ok: false, reason: "locked test target must be a regular file" };
    const real = io.realpathSync(absolute);
    const relative = path.relative(root, real);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return { ok: false, reason: "locked test target escaped project" };
    return { ok: true, test_path: requested };
  } catch { return { ok: false, reason: "locked test target missing or unreadable" }; }
}

/** @description Canonical retry key; raw command spelling and target aliases never create a new attempt. */
export function denialFingerprint({ sessionId, featureId, taskId, deniedClass, registryId, testPath }) {
  const equivalence = registryId ? [registryId, testPath] : [`none:${deniedClass}`];
  return crypto.createHash("sha256").update(JSON.stringify([sessionId, featureId, taskId, deniedClass, ...equivalence])).digest("hex");
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/** @description Stable child-visible path for inherited FD 3 on supported POSIX hosts. */
export function inheritedFdPath(platform = process.platform) {
  if (platform === "linux") return "/proc/self/fd/3";
  if (platform === "darwin") return "/dev/fd/3";
  return null;
}

/** @description Validate package metadata and pin the exact declared Vitest entrypoint by open FD. */
export function openLocalVitest(projectRoot, io = fs) {
  let fd = null;
  try {
    if (!inheritedFdPath()) return { ok: false, status: "setup_missing", reason: "FD-pinned Vitest execution is unavailable on this platform" };
    const root = io.realpathSync(projectRoot);
    const modules = io.realpathSync(path.join(root, "node_modules"));
    const packageDir = io.realpathSync(path.join(modules, "vitest"));
    if (!inside(modules, packageDir) || packageDir === modules) throw new Error("package escape");
    const manifestPath = path.join(packageDir, "package.json");
    if (!io.lstatSync(manifestPath).isFile() || !inside(packageDir, io.realpathSync(manifestPath))) throw new Error("manifest is not package-local regular file");
    const manifest = JSON.parse(io.readFileSync(manifestPath, "utf8"));
    const binValue = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.vitest;
    if (manifest.name !== "vitest" || typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version) || typeof binValue !== "string") throw new Error("invalid manifest");
    if (path.isAbsolute(binValue) || binValue.includes("\\") || binValue.split("/").includes("..")) throw new Error("invalid bin mapping");
    const entry = io.realpathSync(path.resolve(packageDir, binValue));
    if (!inside(packageDir, entry) || entry === packageDir) throw new Error("declared entry escaped package");
    const before = io.statSync(entry);
    if (!before.isFile()) throw new Error("declared entry is not regular");
    fd = io.openSync(entry, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const openedStat = io.fstatSync(fd);
    if (!openedStat.isFile() || openedStat.dev !== before.dev || openedStat.ino !== before.ino) throw new Error("bin changed before open");
    if (process.platform === "linux") {
      const pinned = io.realpathSync(`/proc/self/fd/${fd}`);
      if (pinned !== entry || !inside(packageDir, pinned)) throw new Error("opened bin identity mismatch");
    }
    return { ok: true, fd, entry, package_dir: packageDir, version: manifest.version };
  } catch {
    if (fd !== null) try { io.closeSync(fd); } catch { /* ignore */ }
    return { ok: false, status: "setup_missing", reason: "local Vitest package/bin proof failed" };
  }
}

/** @description Execute the already-open Vitest inode through inherited FD 3 and fixed argv. */
export function runPinnedVitest(projectRoot, testPath, deps = {}) {
  const io = deps.fs ?? fs;
  const opened = openLocalVitest(projectRoot, io);
  if (!opened.ok) return opened;
  try {
    deps.beforeSpawn?.(opened);
    const spawn = deps.spawnSync ?? spawnSync;
    const fdPath = inheritedFdPath();
    if (!fdPath) return { ok: false, status: "setup_missing", reason: "FD-pinned Vitest execution is unavailable on this platform" };
    const run = spawn(process.execPath, [fdPath, "run", testPath], {
      cwd: projectRoot,
      shell: false,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe", opened.fd],
    });
    return { ok: run.status === 0, status: run.status === 0 ? "passed" : "failed", exit_code: run.status, signal: run.signal ?? null, stdout: String(run.stdout ?? "").slice(-8000), stderr: String(run.stderr ?? "").slice(-8000) };
  } finally { try { io.closeSync(opened.fd); } catch { /* ignore */ } }
}
